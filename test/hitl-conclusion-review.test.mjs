import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import { createInvestigationGraph } from '@aic/graph';
import { createSqliteCheckpointer } from '@aic/persistence';
import { Command, INTERRUPT, isInterrupted } from '@langchain/langgraph';

const lifecycleNodes = [
  'normalize_incident',
  'collect_baseline',
  'generate_hypotheses',
  'derive_predictions',
  'plan_investigation',
  'execute_investigation',
  'evaluate_predictions',
  'interpret_residual_evidence',
  'derive_hypothesis_state',
  'termination_check',
  'challenge_hypothesis',
  'propose_conclusion',
];

const proposedConclusion = {
  kind: 'inconclusive',
  causes: [],
};

const addedHypothesis = {
  id: 'human-hypothesis',
  statement: 'A dependency outside the initial candidate set is failing',
  createdBy: 'initial',
};

function initialState(runId, humanReview) {
  return {
    incident: { id: 'incident-hitl-review' },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: STATUS_RULES_VERSION,
      phase: 'concluding',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      humanReview,
    },
  };
}

function fakeNodes(trace) {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async () => {
        trace.push(name);
        if (name === 'termination_check') {
          return { route: 'terminal', stopKind: 'stalled' };
        }
        if (name === 'challenge_hypothesis') {
          throw new Error('challenge must not run in this stalled-review fixture');
        }
        if (name === 'propose_conclusion') {
          return { conclusion: proposedConclusion };
        }
        return {};
      },
    ]),
  );
}

function createHarness({ humanReview = true, runId }) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-hitl-review-'));
  const checkpointPath = join(temporaryRoot, 'checkpoints.sqlite');
  const trace = [];
  let checkpointer = createSqliteCheckpointer(checkpointPath);
  let graph = createInvestigationGraph({
    nodes: fakeNodes(trace),
    checkpointer,
  });
  const config = { configurable: { thread_id: runId } };

  return {
    config,
    get graph() {
      return graph;
    },
    trace,
    reopen() {
      checkpointer.db.close();
      checkpointer = createSqliteCheckpointer(checkpointPath);
      graph = createInvestigationGraph({
        nodes: fakeNodes(trace),
        checkpointer,
      });
    },
    cleanup() {
      checkpointer.db.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
    state: initialState(runId, humanReview),
  };
}

async function interruptAndReopen(harness) {
  const interrupted = await harness.graph.invoke(harness.state, harness.config);
  assert.equal(
    isInterrupted(interrupted),
    true,
    'an interactive conclusion must pause instead of resolving at END',
  );
  harness.reopen();
  return interrupted;
}

function currentInterrupt(interrupted) {
  assert.equal(isInterrupted(interrupted), true);
  assert.equal(interrupted[INTERRUPT].length, 1);
  const [current] = interrupted[INTERRUPT];
  assert.equal(typeof current.id, 'string');
  assert.notEqual(current.id.length, 0);
  return current;
}

function resumeCurrent(interrupted, decision) {
  const current = currentInterrupt(interrupted);
  return new Command({ resume: { [current.id]: decision } });
}

test('persists a proposed conclusion and pending review through the repository checkpointer', async () => {
  const runId = 'run-persisted-review';
  const harness = createHarness({ runId });

  try {
    await interruptAndReopen(harness);
    const persisted = await harness.graph.getState(harness.config);

    assert.deepEqual(persisted.values.conclusion, proposedConclusion);
    assert.equal(persisted.values.control.runId, runId);
    assert.equal(persisted.values.control.humanReview, true);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].name, 'review_conclusion');
    assert.equal(persisted.tasks[0].interrupts.length, 1);
    assert.equal(
      harness.trace.at(-1),
      'propose_conclusion',
      'the sequential review interrupt must happen only after a conclusion is proposed',
    );
  } finally {
    harness.cleanup();
  }
});

test('rejects a start whose thread_id differs from runId before lifecycle work begins', async () => {
  const harness = createHarness({ runId: 'run-identity-match' });
  const mismatchedConfig = {
    configurable: { thread_id: 'different-thread-id' },
  };

  try {
    await assert.rejects(
      harness.graph.invoke(harness.state, mismatchedConfig),
    );
    assert.deepEqual(
      harness.trace,
      [],
      'identity mismatch must fail before any user-provided lifecycle node executes',
    );
  } finally {
    harness.cleanup();
  }
});

test('confirm resumes the same run and thread and completes at END', async () => {
  const runId = 'run-confirm-review';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const completed = await harness.graph.invoke(
      resumeCurrent(interrupted, { action: 'confirm' }),
      harness.config,
    );
    const persisted = await harness.graph.getState(harness.config);

    assert.equal(isInterrupted(completed), false);
    assert.deepEqual(completed.conclusion, proposedConclusion);
    assert.equal(completed.control.runId, runId);
    assert.equal(completed.control.humanReview, true);
    assert.equal(persisted.config.configurable.thread_id, runId);
    assert.deepEqual(persisted.next, []);
  } finally {
    harness.cleanup();
  }
});

test('rejects an unscoped confirm without consuming the pending review', async () => {
  const harness = createHarness({ runId: 'run-unscoped-confirm' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);

    await assert.rejects(
      harness.graph.invoke(
        new Command({ resume: { action: 'confirm' } }),
        harness.config,
      ),
    );

    const persisted = await harness.graph.getState(harness.config);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].interrupts.length, 1);
    assert.equal(
      persisted.tasks[0].interrupts[0].id,
      pendingInterrupt.id,
      'an unscoped decision must not consume or replace the pending review',
    );
  } finally {
    harness.cleanup();
  }
});

test('reject resumes deterministically at hypothesis generation and returns to review', async () => {
  const harness = createHarness({ runId: 'run-reject-review' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const traceBeforeResume = harness.trace.length;
    const interruptedAgain = await harness.graph.invoke(
      resumeCurrent(interrupted, { action: 'reject' }),
      harness.config,
    );

    assert.equal(isInterrupted(interruptedAgain), true);
    assert.deepEqual(harness.trace.slice(traceBeforeResume), [
      'generate_hypotheses',
      'derive_predictions',
      'plan_investigation',
      'execute_investigation',
      'evaluate_predictions',
      'interpret_residual_evidence',
      'derive_hypothesis_state',
      'termination_check',
      'propose_conclusion',
    ]);
  } finally {
    harness.cleanup();
  }
});

test('a stale interrupt-id confirmation cannot complete a newer review', async () => {
  const harness = createHarness({ runId: 'run-stale-review-decision' });

  try {
    const firstInterrupted = await interruptAndReopen(harness);
    const firstInterrupt = currentInterrupt(firstInterrupted);
    const secondInterrupted = await harness.graph.invoke(
      resumeCurrent(firstInterrupted, { action: 'reject' }),
      harness.config,
    );
    const secondInterrupt = currentInterrupt(secondInterrupted);
    assert.notEqual(secondInterrupt.id, firstInterrupt.id);

    const staleReplay = await harness.graph.invoke(
      new Command({
        resume: {
          [firstInterrupt.id]: { action: 'confirm' },
        },
      }),
      harness.config,
    );

    assert.equal(isInterrupted(staleReplay), true);
    assert.equal(currentInterrupt(staleReplay).id, secondInterrupt.id);
    const persisted = await harness.graph.getState(harness.config);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(
      persisted.tasks[0].interrupts[0].id,
      secondInterrupt.id,
      'the current pending review must survive replay of a stale decision',
    );
  } finally {
    harness.cleanup();
  }
});

test('add_hypothesis persists a valid frozen-domain hypothesis and resumes at prediction derivation', async () => {
  const harness = createHarness({ runId: 'run-add-hypothesis-review' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const traceBeforeResume = harness.trace.length;
    const interruptedAgain = await harness.graph.invoke(
      resumeCurrent(interrupted, {
        action: 'add_hypothesis',
        hypothesis: addedHypothesis,
      }),
      harness.config,
    );

    assert.equal(isInterrupted(interruptedAgain), true);
    assert.deepEqual(interruptedAgain.hypotheses, [addedHypothesis]);
    assert.deepEqual(harness.trace.slice(traceBeforeResume), [
      'derive_predictions',
      'plan_investigation',
      'execute_investigation',
      'evaluate_predictions',
      'interpret_residual_evidence',
      'derive_hypothesis_state',
      'termination_check',
      'propose_conclusion',
    ]);
  } finally {
    harness.cleanup();
  }
});

test('add_hypothesis refuses an existing id without overwriting persisted state', async () => {
  const harness = createHarness({ runId: 'run-duplicate-human-hypothesis' });
  const existingHypothesis = {
    ...addedHypothesis,
    statement: 'The existing hypothesis must remain unchanged',
  };
  harness.state.hypotheses = [existingHypothesis];

  try {
    const interrupted = await interruptAndReopen(harness);
    await assert.rejects(
      harness.graph.invoke(
        resumeCurrent(interrupted, {
          action: 'add_hypothesis',
          hypothesis: addedHypothesis,
        }),
        harness.config,
      ),
    );
    const persisted = await harness.graph.getState(harness.config);
    assert.deepEqual(persisted.values.hypotheses, [existingHypothesis]);
  } finally {
    harness.cleanup();
  }
});

test('add_hypothesis refuses challenge provenance reserved for graph-owned challenge output', async () => {
  const harness = createHarness({ runId: 'run-invalid-human-provenance' });

  try {
    const interrupted = await interruptAndReopen(harness);
    await assert.rejects(
      harness.graph.invoke(
        resumeCurrent(interrupted, {
          action: 'add_hypothesis',
          hypothesis: { ...addedHypothesis, createdBy: 'challenge' },
        }),
        harness.config,
      ),
    );
    const persisted = await harness.graph.getState(harness.config);
    assert.deepEqual(persisted.values.hypotheses, []);
  } finally {
    harness.cleanup();
  }
});

test('humanReview=false bypasses review and preserves the benchmark path to END', async () => {
  const runId = 'run-benchmark-no-review';
  const harness = createHarness({ humanReview: false, runId });

  try {
    const completed = await harness.graph.invoke(harness.state, harness.config);

    assert.equal(isInterrupted(completed), false);
    assert.deepEqual(completed.conclusion, proposedConclusion);
    assert.equal(completed.control.runId, runId);
    assert.equal(completed.control.humanReview, false);
    assert.deepEqual(harness.trace, [
      'normalize_incident',
      'collect_baseline',
      'generate_hypotheses',
      'derive_predictions',
      'plan_investigation',
      'execute_investigation',
      'evaluate_predictions',
      'interpret_residual_evidence',
      'derive_hypothesis_state',
      'termination_check',
      'propose_conclusion',
    ]);
  } finally {
    harness.cleanup();
  }
});
