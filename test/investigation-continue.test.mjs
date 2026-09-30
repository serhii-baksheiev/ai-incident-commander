import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as graphPackage from '@aic/graph';
import { createSqliteCheckpointer } from '@aic/persistence';
import { isInterrupted } from '@langchain/langgraph';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

/**
 * AIC-146 (c2) — `{ kind: 'continue' }` on the canonical investigation graph.
 *
 * A run whose node threw mid-superstep, or whose process died there, has no
 * interrupt to name, so `resume` has nothing to answer, and `start`
 * overwrites the control instead of re-entering it. `{ kind: 'continue' }`
 * re-enters it from its last checkpoint.
 *
 * The guards a `continue` shares with `resume` — `readOwnControl`,
 * `assertOwnControlFields`, `assertPersistedStateVersion` — come from
 * `execute`'s `resume` branch in `packages/graph/src/investigation.ts`; a
 * `continue` also refuses while an interrupt is pending, then calls
 * `graph.invoke(null, config)`. This file reuses the harness style of
 * `hitl-resume-contract.test.mjs`.
 *
 * Two facts about `@langchain/langgraph@1.4.13`'s own `invoke(null, config)`
 * were measured with a two-node throwaway graph rather than assumed, because
 * this file pins a third party's behaviour rather than this repository's:
 * - on a thread with one committed node and a second that threw once, a
 *   second `invoke(null, config)` re-runs only the node that threw (and
 *   whatever follows it) — the committed node's call counter never moves;
 * - on a thread whose last invoke already reached `END`, `invoke(null,
 *   config)` returns that same final state and calls no node again.
 * A third case was measured and is why the interrupt row below is a guard
 * this file adds rather than one `@langchain/langgraph` already provides:
 * `invoke(null, config)` on a thread paused at a pending interrupt does not
 * throw — it resolves with the same interrupted value, silently re-asking
 * the paused question instead of refusing to.
 */

const proposedConclusion = { kind: 'inconclusive', causes: [] };

const stalledTermination = async () => ({ route: 'terminal', stopKind: 'stalled' });

/**
 * One lifecycle node function per name in `INVESTIGATION_NODE_NAMES`,
 * derived rather than restated so a node added to the graph arrives here
 * automatically. Every call increments `callCounts[name]`, which is the
 * independent oracle every row below reads instead of trusting a stated
 * claim about which nodes re-ran.
 *
 * `throwOnFirstCall`, when given, names the one node that throws on its
 * first call and succeeds on every call after — the shape of a node that
 * threw mid-superstep, or a process that died before its checkpoint landed.
 */
function countingLifecycleNodes(callCounts, { throwOnFirstCall } = {}) {
  return Object.fromEntries(
    graphPackage.INVESTIGATION_NODE_NAMES.map((name) => [
      name,
      async (state) => {
        callCounts[name] = (callCounts[name] ?? 0) + 1;
        if (name === throwOnFirstCall && callCounts[name] === 1) {
          throw new Error(
            `${name} threw on its first call, simulating a crashed superstep`,
          );
        }
        if (name === 'termination_check') return stalledTermination(state);
        if (name === 'challenge_hypothesis') {
          throw new Error(
            'challenge_hypothesis must not run under stalledTermination',
          );
        }
        if (name === 'propose_conclusion') {
          return { conclusion: proposedConclusion };
        }
        return {};
      },
    ]),
  );
}

function initialState(runId, control = {}) {
  return {
    incident: scopedIncident(`incident-${runId}`),
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
      phase: 'investigating',
      maxIterations: 4,
      llmCallBudget: 8,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      humanReview: false,
      ...control,
    },
  };
}

/**
 * The same rewrite-on-read shape `hitl-resume-contract.test.mjs` uses: a
 * checkpointer whose reads can be rewritten after a run has already reached
 * whatever state a row needs, so a continue can be exercised against a
 * checkpoint the writing side never actually produced (a stale schema
 * version, a control field the prototype supplies).
 */
function createContinueHarness({ runId, nodes }) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-continue-'));
  const checkpointer = createSqliteCheckpointer(
    join(temporaryRoot, 'checkpoints.sqlite'),
  );
  const readTuple = checkpointer.getTuple.bind(checkpointer);
  let rewritePersistedControl;
  checkpointer.getTuple = async (config) => {
    const tuple = await readTuple(config);
    const persisted = tuple?.checkpoint?.channel_values?.control;
    if (rewritePersistedControl !== undefined && persisted !== undefined) {
      tuple.checkpoint.channel_values.control = rewritePersistedControl(
        persisted,
      );
    }
    return tuple;
  };

  const execution = graphPackage.createInvestigationGraph({
    nodes,
    checkpointer,
  });
  const config = { threadId: runId };

  return {
    execution,
    config,
    rewriteEveryPersistedControl(rewrite) {
      rewritePersistedControl = rewrite;
    },
    cleanup() {
      checkpointer.db.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

function attemptStart(harness, runId, control = {}) {
  return harness.execution
    .execute({ kind: 'start', state: initialState(runId, control) }, harness.config)
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
}

function attemptContinue(execution, config) {
  return execution.execute({ kind: 'continue' }, config).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
}

test('continue advances a run whose node threw mid-superstep to completion without re-running already-checkpointed nodes', async () => {
  const runId = 'run-continue-after-node-throw';
  const callCounts = {};
  const harness = createContinueHarness({
    runId,
    nodes: countingLifecycleNodes(callCounts, {
      throwOnFirstCall: 'execute_investigation',
    }),
  });

  try {
    const started = await attemptStart(harness, runId);
    assert.equal(
      'error' in started,
      true,
      'the premise of this test: the injected throw must reach the caller, or this row proves nothing',
    );
    assert.match(started.error.message, /execute_investigation threw/);

    const callsBeforeContinue = { ...callCounts };
    assert.deepEqual(
      callsBeforeContinue,
      {
        normalize_incident: 1,
        collect_baseline: 1,
        generate_hypotheses: 1,
        derive_predictions: 1,
        plan_investigation: 1,
        execute_investigation: 1,
      },
      'the premise: only the nodes up to and including the one that threw have run before continue',
    );

    const outcome = await attemptContinue(harness.execution, harness.config);

    assert.equal(
      'error' in outcome,
      false,
      `continue must advance the crashed run to completion: ${outcome.error?.message ?? ''}`,
    );
    assert.equal(
      isInterrupted(outcome.value),
      false,
      'this run has no human review, so it must resolve rather than pause',
    );
    assert.deepEqual(
      callCounts,
      {
        normalize_incident: 1,
        collect_baseline: 1,
        generate_hypotheses: 1,
        derive_predictions: 1,
        plan_investigation: 1,
        execute_investigation: 2,
        evaluate_predictions: 1,
        interpret_residual_evidence: 1,
        derive_hypothesis_state: 1,
        termination_check: 1,
        propose_conclusion: 1,
      },
      'every node the crash had already checkpointed must run exactly once; only the node that threw retries, and every node after it runs for the first time',
    );
  } finally {
    harness.cleanup();
  }
});

const neverRunThreadId = 'run-continue-thread-that-never-started';

test('refuses a continue under a thread that has no checkpointed control, naming the thread, and leaves no checkpoint behind', async () => {
  const harness = createContinueHarness({
    runId: neverRunThreadId,
    nodes: countingLifecycleNodes({}),
  });

  try {
    const before = await harness.execution.getState(harness.config);
    assert.deepEqual(
      { next: [...before.next], tasks: before.tasks.length },
      { next: [], tasks: 0 },
      'the premise of this test: the thread starts with nothing to continue',
    );

    const outcome = await attemptContinue(harness.execution, harness.config);

    assert.equal(
      'error' in outcome,
      true,
      'a continue of a thread that never ran must be refused, not started from nothing',
    );
    assert.ok(
      outcome.error.message.includes(neverRunThreadId),
      `the refusal must name the thread it could not continue: ${outcome.error.message}`,
    );
    assert.match(
      outcome.error.message,
      /no resumable run|no checkpointed control|no investigation control/i,
      'the refusal must say what was missing, not merely that something was',
    );

    const after = await harness.execution.getState(harness.config);
    assert.deepEqual(
      {
        next: [...after.next],
        tasks: after.tasks.length,
        checkpointId: after.config?.configurable?.checkpoint_id ?? null,
      },
      { next: [], tasks: 0, checkpointId: null },
      'a refused continue must not leave a half-started run under the thread it refused',
    );
  } finally {
    harness.cleanup();
  }
});

const namesAPendingReview = /pending review/i;

test('refuses a continue while an interrupt is pending, naming the pending review rather than silently re-asking it', async () => {
  const runId = 'run-continue-while-interrupt-pending';
  const harness = createContinueHarness({
    runId,
    nodes: countingLifecycleNodes({}),
  });

  try {
    const interrupted = await harness.execution.execute(
      { kind: 'start', state: initialState(runId, { humanReview: true }) },
      harness.config,
    );
    assert.equal(
      isInterrupted(interrupted),
      true,
      'the premise of this test: the run must be paused on a human review',
    );

    const outcome = await attemptContinue(harness.execution, harness.config);

    assert.equal(
      'error' in outcome,
      true,
      'a pending review needs a decision through resume, not a silent continue',
    );
    assert.match(
      outcome.error.message,
      namesAPendingReview,
      'the refusal must name the pending review it refused to skip past',
    );
  } finally {
    harness.cleanup();
  }
});

test('refuses a continue that names no thread', async () => {
  const runId = 'run-continue-no-thread-id';
  const harness = createContinueHarness({
    runId,
    nodes: countingLifecycleNodes({}),
  });

  try {
    const outcome = await harness.execution.execute({ kind: 'continue' }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    assert.equal(
      'error' in outcome,
      true,
      'a continue naming no thread has nothing to re-enter',
    );
    assert.match(outcome.error.message, /continue requires an execution threadId/);
  } finally {
    harness.cleanup();
  }
});

test('refuses a continue with no checkpointer configured', async () => {
  const execution = graphPackage.createInvestigationGraph({
    nodes: countingLifecycleNodes({}),
  });

  const outcome = await execution
    .execute({ kind: 'continue' }, { threadId: 'run-continue-no-checkpointer' })
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );

  assert.equal(
    'error' in outcome,
    true,
    'a continue with no checkpointer configured has no checkpoint to read',
  );
  assert.match(outcome.error.message, /No checkpointer set/);
});

/**
 * `graph.invoke(null, config)` on a finished thread was measured, not
 * inferred: see this file's header. This row holds the canonical graph to
 * that measured behaviour rather than to a guess.
 */
test('continue on a finished run returns its final state without invoking any node again', async () => {
  const runId = 'run-continue-after-finish';
  const callCounts = {};
  const harness = createContinueHarness({
    runId,
    nodes: countingLifecycleNodes(callCounts),
  });

  try {
    const finished = await harness.execution.execute(
      { kind: 'start', state: initialState(runId) },
      harness.config,
    );
    assert.equal(
      isInterrupted(finished),
      false,
      'the premise of this test: the run must finish without pausing',
    );

    const callsAfterFinish = { ...callCounts };

    const outcome = await attemptContinue(harness.execution, harness.config);

    assert.equal(
      'error' in outcome,
      false,
      `continue on a finished run must not be refused: ${outcome.error?.message ?? ''}`,
    );
    assert.deepEqual(
      outcome.value,
      finished,
      'continue on a finished run must hand back the same final state, not a fresh one',
    );
    assert.deepEqual(
      callCounts,
      callsAfterFinish,
      'a finished run has nothing left to execute; continue must not invoke a single node again',
    );
  } finally {
    harness.cleanup();
  }
});

const namesTheVersionBoundary = /schema ?version|incompatible version/i;

test('refuses a continue whose persisted control predates the current schema version, without retrying the crashed node', async () => {
  const runId = 'run-continue-stale-version';
  const callCounts = {};
  const harness = createContinueHarness({
    runId,
    nodes: countingLifecycleNodes(callCounts, {
      throwOnFirstCall: 'execute_investigation',
    }),
  });

  try {
    const started = await attemptStart(harness, runId);
    assert.equal(
      'error' in started,
      true,
      'the premise of this test: the run must be crashed mid-superstep, waiting to be continued',
    );

    const callsBeforeContinue = { ...callCounts };
    harness.rewriteEveryPersistedControl((control) => ({
      ...control,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION - 1,
    }));

    const outcome = await attemptContinue(harness.execution, harness.config);

    assert.equal(
      'error' in outcome,
      true,
      'a checkpoint from an incompatible schema version must be refused, not continued',
    );
    assert.match(
      outcome.error.message,
      namesTheVersionBoundary,
      'the refusal must name the version boundary it refused on',
    );
    assert.deepEqual(
      callCounts,
      callsBeforeContinue,
      'the refusal must land before the crashed node is retried',
    );
  } finally {
    harness.cleanup();
  }
});

test('refuses a continue whose restored control field is supplied by an accessor on the prototype', async () => {
  const runId = 'run-continue-polluted-control';
  const callCounts = {};
  const harness = createContinueHarness({
    runId,
    nodes: countingLifecycleNodes(callCounts, {
      throwOnFirstCall: 'execute_investigation',
    }),
  });

  try {
    const started = await attemptStart(harness, runId);
    assert.equal(
      'error' in started,
      true,
      'the premise of this test: the run must be crashed mid-superstep, waiting to be continued',
    );

    const callsBeforeContinue = { ...callCounts };
    let outcome;
    try {
      Object.defineProperty(Object.prototype, 'humanReview', {
        configurable: true,
        get() {
          return 'inherited';
        },
        set() {},
      });
      outcome = await attemptContinue(harness.execution, harness.config);
    } finally {
      delete Object.prototype.humanReview;
    }

    assert.equal(
      'error' in outcome,
      true,
      'a continue whose humanReview is supplied by the prototype must be refused, not run to completion',
    );
    assert.match(
      outcome.error.message,
      /investigation control must carry its own humanReview/,
      'the refusal must say so in the graph’s own words',
    );
    assert.deepEqual(
      callCounts,
      callsBeforeContinue,
      'the refusal must land before the crashed node is retried',
    );
  } finally {
    harness.cleanup();
  }
});

test('accepts only a continue request whose own properties are exactly { kind }', async () => {
  const runId = 'run-continue-exact-shape';
  const callCounts = {};
  const harness = createContinueHarness({
    runId,
    nodes: countingLifecycleNodes(callCounts, {
      throwOnFirstCall: 'execute_investigation',
    }),
  });

  try {
    const started = await attemptStart(harness, runId);
    assert.equal(
      'error' in started,
      true,
      'the premise of this test: the run must be crashed mid-superstep, waiting to be continued',
    );

    const extra = await harness.execution
      .execute({ kind: 'continue', extra: 1 }, harness.config)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    assert.equal(
      'error' in extra,
      true,
      'an extra own property must be refused rather than silently ignored',
    );

    const inheritedKindProto = { kind: 'continue' };
    const inheritedKind = Object.create(inheritedKindProto);
    const viaInheritedKind = await harness.execution
      .execute(inheritedKind, harness.config)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    assert.equal(
      'error' in viaInheritedKind,
      true,
      "a kind supplied only by the prototype is not the caller's own request",
    );

    const wellFormed = await attemptContinue(harness.execution, harness.config);
    assert.equal(
      'error' in wellFormed,
      false,
      `the exact shape { kind: 'continue' } must be accepted: ${wellFormed.error?.message ?? ''}`,
    );
  } finally {
    harness.cleanup();
  }
});
