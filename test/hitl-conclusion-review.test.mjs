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

import { conclusionReviewDecisions } from './fixtures/conclusion-review-decisions.mjs';
import { scopedIncident } from './fixtures/scoped-incident.mjs';
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

const fakeNodes = Object.fromEntries(
  lifecycleNodes.map((name) => [name, async () => ({})]),
);

test('exposes only the validated investigation execution surface', () => {
  const execution = graphPackage.createInvestigationGraph({ nodes: fakeNodes });

  assert.deepEqual(
    Object.keys(execution).sort(),
    ['execute', 'getGraph', 'getState'],
  );
});

function findInspectionHazards(value, path = '$', seen = new WeakSet()) {
  if (typeof value === 'function') {
    return { callablePaths: [path], forbiddenKeyPaths: [] };
  }
  if (typeof value !== 'object' || value === null || seen.has(value)) {
    return { callablePaths: [], forbiddenKeyPaths: [] };
  }

  seen.add(value);
  const hazards = { callablePaths: [], forbiddenKeyPaths: [] };
  for (const key of Reflect.ownKeys(value)) {
    const keyName = typeof key === 'symbol' ? key.toString() : key;
    const childPath = `${path}.${keyName}`;
    if (['data', 'invoke', 'runnable'].includes(keyName)) {
      hazards.forbiddenKeyPaths.push(childPath);
    }
    const childHazards = findInspectionHazards(value[key], childPath, seen);
    hazards.callablePaths.push(...childHazards.callablePaths);
    hazards.forbiddenKeyPaths.push(...childHazards.forbiddenKeyPaths);
  }
  return hazards;
}

test('getGraph returns an inert topology projection without runnable node data', async () => {
  const execution = graphPackage.createInvestigationGraph({ nodes: fakeNodes });
  const topology = await execution.getGraph();
  const hazards = findInspectionHazards({
    nodes: Object.values(topology.nodes),
    edges: topology.edges,
  });

  assert.deepEqual(
    {
      callablePaths: hazards.callablePaths,
      forbiddenKeyPaths: hazards.forbiddenKeyPaths,
      nodesWithData: Object.entries(topology.nodes)
        .filter(([, node]) => Object.hasOwn(node, 'data'))
        .map(([id]) => id),
    },
    {
      callablePaths: [],
      forbiddenKeyPaths: [],
      nodesWithData: [],
    },
  );
});

/**
 * Every member the schema declares, not the three someone wrote down. Before
 * AIC-77 this loop was a hand-written list of three, and so was the resume
 * suite's: a fourth member that the graph handled left both green — measured,
 * 522/522 — so "every supported decision" was a claim about a list rather than
 * about the schema.
 *
 * The table's own emptiness and completeness are not re-asserted here: the
 * module throws at import on an empty union, and its labels ARE the derived
 * list, so checking them against it could not fail. Both are covered where they
 * mean something, in conclusion-review-decision-fixture.test.mjs.
 */
test('accepts every supported conclusion review decision', () => {
  const schema = graphPackage.ConclusionReviewDecisionSchema;
  assert.equal(typeof schema?.safeParse, 'function');

  // Built through the table rather than by handing every action a hypothesis:
  // an action that declares none now REFUSES one, because silently dropping it
  // would let a caller believe it had been used.
  const table = conclusionReviewDecisions(() => ({
    id: 'human-hypothesis',
    statement: 'A human-supplied alternative',
    createdBy: 'initial',
  }));

  for (const { label, decision } of table) {
    assert.equal(
      schema.safeParse(decision()).success,
      true,
      `the fixture for ${label} must be a decision the schema accepts`,
    );
  }
});

test('rejects challenge provenance and unknown decision fields', () => {
  const schema = graphPackage.ConclusionReviewDecisionSchema;
  assert.equal(typeof schema?.safeParse, 'function');

  for (const decision of [
    {
      action: 'add_hypothesis',
      hypothesis: {
        id: 'challenge-hypothesis',
        statement: 'A challenge-generated alternative',
        createdBy: 'challenge',
      },
    },
    { action: 'confirm', extra: true },
  ]) {
    assert.equal(schema.safeParse(decision).success, false);
  }
});

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
    incident: scopedIncident('incident-hitl-review'),
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
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      humanReview,
    },
  };
}

const defaultProposeConclusion = async () => ({ conclusion: proposedConclusion });

function tracedNodes(trace, { proposeConclusion = defaultProposeConclusion } = {}) {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async (state) => {
        trace.push(name);
        if (name === 'termination_check') {
          return { route: 'terminal', stopKind: 'stalled' };
        }
        if (name === 'challenge_hypothesis') {
          throw new Error('challenge must not run in this stalled-review fixture');
        }
        if (name === 'propose_conclusion') {
          return proposeConclusion(state);
        }
        return {};
      },
    ]),
  );
}

function createHarness({ humanReview = true, runId, proposeConclusion }) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-hitl-review-'));
  const checkpointPath = join(temporaryRoot, 'checkpoints.sqlite');
  const trace = [];
  let checkpointer = createSqliteCheckpointer(checkpointPath);
  let execution = graphPackage.createInvestigationGraph({
    nodes: tracedNodes(trace, { proposeConclusion }),
    checkpointer,
  });
  const config = { threadId: runId };

  return {
    config,
    get execution() {
      return execution;
    },
    trace,
    reopen() {
      checkpointer.db.close();
      checkpointer = createSqliteCheckpointer(checkpointPath);
      execution = graphPackage.createInvestigationGraph({
        nodes: tracedNodes(trace, { proposeConclusion }),
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

function configWithInheritedThreadId(threadId) {
  return Object.assign(Object.create({ threadId }), {
    checkpoint_id: 'forbidden-checkpoint-selector',
  });
}

const symbolCheckpointSelector = Symbol('checkpoint_id');
const hiddenExtraKeyCases = [
  {
    label: 'a non-enumerable extra key',
    key: 'checkpoint_id',
    addTo(target) {
      Object.defineProperty(target, 'checkpoint_id', {
        value: 'forbidden-checkpoint-selector',
        enumerable: false,
      });
      return target;
    },
  },
  {
    label: 'a symbol extra key',
    key: symbolCheckpointSelector,
    addTo(target) {
      target[symbolCheckpointSelector] = 'forbidden-checkpoint-selector';
      return target;
    },
  },
];

function addChangingAccessor(
  target,
  key,
  { validValue, changedValue, validReads },
) {
  let reads = 0;
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      reads += 1;
      return reads <= validReads ? validValue : changedValue;
    },
  });
  return { target, readCount: () => reads };
}

async function interruptAndReopen(harness) {
  const interrupted = await harness.execution.execute(
    { kind: 'start', state: harness.state },
    harness.config,
  );
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
  return {
    kind: 'resume',
    interruptId: current.id,
    decision,
  };
}

test('persists the proposed conclusion and pending review across reopen', async () => {
  const runId = 'run-persisted-review';
  const harness = createHarness({ runId });

  try {
    await interruptAndReopen(harness);
    const persisted = await harness.execution.getState(harness.config);

    assert.deepEqual(persisted.values.conclusion, proposedConclusion);
    assert.equal(persisted.values.control.runId, runId);
    assert.equal(persisted.values.control.humanReview, true);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].name, 'review_conclusion');
    assert.equal(persisted.tasks[0].interrupts.length, 1);
    assert.equal(harness.trace.at(-1), 'propose_conclusion');
  } finally {
    harness.cleanup();
  }
});

test('rejects a mismatched interactive start without replacing the pending review checkpoint', async () => {
  const runId = 'run-identity-match';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);
    const traceBeforeRejectedStart = [...harness.trace];

    await assert.rejects(
      harness.execution.execute(
        {
          kind: 'start',
          state: initialState('different-run-id', true),
        },
        harness.config,
      ),
    );

    const persisted = await harness.execution.getState(harness.config);
    assert.deepEqual(harness.trace, traceBeforeRejectedStart);
    assert.equal(persisted.values.control.runId, runId);
    assert.deepEqual(persisted.values.conclusion, proposedConclusion);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].interrupts.length, 1);
    assert.equal(persisted.tasks[0].interrupts[0].id, pendingInterrupt.id);
  } finally {
    harness.cleanup();
  }
});

test('confirm resumes the same run and thread and completes at END', async () => {
  const runId = 'run-confirm-review';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const completed = await harness.execution.execute(
      resumeCurrent(interrupted, { action: 'confirm' }),
      harness.config,
    );
    const persisted = await harness.execution.getState(harness.config);

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

test('rejects raw checkpoint selectors without consuming the pending review', async () => {
  const runId = 'run-raw-checkpoint-selector-rejected';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);
    const before = await harness.execution.getState(harness.config);
    const rawSelector = {
      threadId: runId,
      configurable: { ...before.config.configurable },
    };
    assert.equal(typeof rawSelector.configurable.checkpoint_id, 'string');
    assert.equal(
      Object.hasOwn(rawSelector.configurable, 'checkpoint_ns'),
      true,
    );

    await assert.rejects(
      harness.execution.execute(
        resumeCurrent(interrupted, { action: 'confirm' }),
        rawSelector,
      ),
    );

    const persisted = await harness.execution.getState(harness.config);
    assert.equal(persisted.values.control.runId, runId);
    assert.deepEqual(persisted.values.conclusion, proposedConclusion);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].interrupts.length, 1);
    assert.equal(persisted.tasks[0].interrupts[0].id, pendingInterrupt.id);
  } finally {
    harness.cleanup();
  }
});

test('execute rejects an inherited threadId with an own checkpoint selector without consuming the pending review', async () => {
  const runId = 'run-inherited-execute-config-rejected';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);
    const inheritedConfig = configWithInheritedThreadId(runId);
    assert.deepEqual(Object.keys(inheritedConfig), ['checkpoint_id']);
    assert.equal(Object.hasOwn(inheritedConfig, 'threadId'), false);

    const outcome = await harness.execution
      .execute(
        resumeCurrent(interrupted, { action: 'confirm' }),
        inheritedConfig,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const persisted = await harness.execution.getState(harness.config);

    assert.deepEqual(
      {
        rejected: Object.hasOwn(outcome, 'error'),
        next: persisted.next,
        pendingInterruptId: persisted.tasks[0]?.interrupts[0]?.id,
      },
      {
        rejected: true,
        next: ['review_conclusion'],
        pendingInterruptId: pendingInterrupt.id,
      },
    );
  } finally {
    harness.cleanup();
  }
});

test('getState rejects an inherited threadId with an own checkpoint selector', async () => {
  const runId = 'run-inherited-get-state-config-rejected';
  const harness = createHarness({ runId });

  try {
    await interruptAndReopen(harness);
    const inheritedConfig = configWithInheritedThreadId(runId);
    assert.deepEqual(Object.keys(inheritedConfig), ['checkpoint_id']);
    assert.equal(Object.hasOwn(inheritedConfig, 'threadId'), false);

    await assert.rejects(harness.execution.getState(inheritedConfig));
  } finally {
    harness.cleanup();
  }
});

test('rejects a start with inherited kind and own checkpoint selector before graph execution', async () => {
  const harness = createHarness({
    humanReview: false,
    runId: 'run-inherited-start-kind-rejected',
  });
  const inheritedStart = Object.assign(Object.create({ kind: 'start' }), {
    state: harness.state,
    checkpoint_id: 'forbidden-checkpoint-selector',
  });

  try {
    assert.deepEqual(Object.keys(inheritedStart), ['state', 'checkpoint_id']);
    assert.equal(Object.hasOwn(inheritedStart, 'kind'), false);

    const outcome = await harness.execution
      .execute(inheritedStart, harness.config)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

    assert.deepEqual(
      {
        rejected: Object.hasOwn(outcome, 'error'),
        trace: harness.trace,
      },
      { rejected: true, trace: [] },
    );
  } finally {
    harness.cleanup();
  }
});

for (const hiddenExtra of hiddenExtraKeyCases) {
  test(`execute rejects resume config with ${hiddenExtra.label} without consuming the pending review`, async () => {
    const runId = `run-hidden-execute-config-${String(hiddenExtra.key)}`;
    const harness = createHarness({ runId });

    try {
      const interrupted = await interruptAndReopen(harness);
      const pendingInterrupt = currentInterrupt(interrupted);
      const config = hiddenExtra.addTo({ threadId: runId });
      assert.deepEqual(Object.keys(config), ['threadId']);
      assert.equal(Object.hasOwn(config, hiddenExtra.key), true);

      const outcome = await harness.execution
        .execute(
          resumeCurrent(interrupted, { action: 'confirm' }),
          config,
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const persisted = await harness.execution.getState(harness.config);

      assert.deepEqual(
        {
          rejected: Object.hasOwn(outcome, 'error'),
          next: persisted.next,
          pendingInterruptId: persisted.tasks[0]?.interrupts[0]?.id,
        },
        {
          rejected: true,
          next: ['review_conclusion'],
          pendingInterruptId: pendingInterrupt.id,
        },
      );
    } finally {
      harness.cleanup();
    }
  });

  test(`getState rejects config with ${hiddenExtra.label}`, async () => {
    const runId = `run-hidden-get-state-config-${String(hiddenExtra.key)}`;
    const harness = createHarness({ runId });

    try {
      await interruptAndReopen(harness);
      const config = hiddenExtra.addTo({ threadId: runId });
      assert.deepEqual(Object.keys(config), ['threadId']);
      assert.equal(Object.hasOwn(config, hiddenExtra.key), true);

      await assert.rejects(harness.execution.getState(config));
    } finally {
      harness.cleanup();
    }
  });

  test(`rejects start input with ${hiddenExtra.label} before graph execution`, async () => {
    const harness = createHarness({
      humanReview: false,
      runId: `run-hidden-start-input-${String(hiddenExtra.key)}`,
    });
    const input = hiddenExtra.addTo({ kind: 'start', state: harness.state });

    try {
      assert.deepEqual(Object.keys(input), ['kind', 'state']);
      assert.equal(Object.hasOwn(input, hiddenExtra.key), true);

      const outcome = await harness.execution
        .execute(input, harness.config)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );

      assert.deepEqual(
        {
          rejected: Object.hasOwn(outcome, 'error'),
          trace: harness.trace,
        },
        { rejected: true, trace: [] },
      );
    } finally {
      harness.cleanup();
    }
  });

  test(`rejects resume input with ${hiddenExtra.label} without consuming the pending review`, async () => {
    const runId = `run-hidden-resume-input-${String(hiddenExtra.key)}`;
    const harness = createHarness({ runId });

    try {
      const interrupted = await interruptAndReopen(harness);
      const pendingInterrupt = currentInterrupt(interrupted);
      const input = hiddenExtra.addTo(
        resumeCurrent(interrupted, { action: 'confirm' }),
      );
      assert.deepEqual(Object.keys(input), [
        'kind',
        'interruptId',
        'decision',
      ]);
      assert.equal(Object.hasOwn(input, hiddenExtra.key), true);

      const outcome = await harness.execution
        .execute(input, harness.config)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
      const persisted = await harness.execution.getState(harness.config);

      assert.deepEqual(
        {
          rejected: Object.hasOwn(outcome, 'error'),
          next: persisted.next,
          pendingInterruptId: persisted.tasks[0]?.interrupts[0]?.id,
        },
        {
          rejected: true,
          next: ['review_conclusion'],
          pendingInterruptId: pendingInterrupt.id,
        },
      );
    } finally {
      harness.cleanup();
    }
  });
}

test('execute rejects a changing threadId accessor without consuming the pending review', async () => {
  const runId = 'run-changing-execute-thread-id';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);
    const changingConfig = addChangingAccessor({}, 'threadId', {
      validValue: runId,
      changedValue: 42,
      validReads: 2,
    });

    const outcome = await harness.execution
      .execute(
        resumeCurrent(interrupted, { action: 'confirm' }),
        changingConfig.target,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const persisted = await harness.execution.getState(harness.config);

    assert.deepEqual(
      {
        rejected: Object.hasOwn(outcome, 'error'),
        accessorReads: changingConfig.readCount(),
        next: persisted.next,
        pendingInterruptId: persisted.tasks[0]?.interrupts[0]?.id,
      },
      {
        rejected: true,
        accessorReads: 0,
        next: ['review_conclusion'],
        pendingInterruptId: pendingInterrupt.id,
      },
    );
  } finally {
    harness.cleanup();
  }
});

test('getState rejects a changing threadId accessor without reading or changing the pending review', async () => {
  const runId = 'run-changing-get-state-thread-id';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);
    const changingConfig = addChangingAccessor({}, 'threadId', {
      validValue: runId,
      changedValue: 42,
      validReads: 2,
    });

    const outcome = await Promise.resolve()
      .then(() => harness.execution.getState(changingConfig.target))
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const persisted = await harness.execution.getState(harness.config);

    assert.deepEqual(
      {
        rejected: Object.hasOwn(outcome, 'error'),
        accessorReads: changingConfig.readCount(),
        next: persisted.next,
        pendingInterruptId: persisted.tasks[0]?.interrupts[0]?.id,
      },
      {
        rejected: true,
        accessorReads: 0,
        next: ['review_conclusion'],
        pendingInterruptId: pendingInterrupt.id,
      },
    );
  } finally {
    harness.cleanup();
  }
});

test('execute rejects a changing interruptId accessor before checkpoint mutation', async () => {
  const runId = 'run-changing-resume-interrupt-id';
  const harness = createHarness({ runId });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);
    const changingInput = addChangingAccessor(
      { kind: 'resume' },
      'interruptId',
      {
        validValue: pendingInterrupt.id,
        changedValue: 42,
        validReads: 2,
      },
    );
    changingInput.target.decision = { action: 'confirm' };

    const outcome = await harness.execution
      .execute(changingInput.target, harness.config)
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
    const persisted = await harness.execution.getState(harness.config);

    assert.deepEqual(
      {
        rejected: Object.hasOwn(outcome, 'error'),
        accessorReads: changingInput.readCount(),
        next: persisted.next,
        pendingInterruptId: persisted.tasks[0]?.interrupts[0]?.id,
      },
      {
        rejected: true,
        accessorReads: 0,
        next: ['review_conclusion'],
        pendingInterruptId: pendingInterrupt.id,
      },
    );
  } finally {
    harness.cleanup();
  }
});

test('rejects a raw LangGraph Command without consuming the pending review', async () => {
  const harness = createHarness({ runId: 'run-raw-command-rejected' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);

    await assert.rejects(
      harness.execution.execute(
        new Command({
          resume: {
            [pendingInterrupt.id]: { action: 'confirm' },
          },
        }),
        harness.config,
      ),
    );

    const persisted = await harness.execution.getState(harness.config);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks[0].interrupts[0].id, pendingInterrupt.id);
  } finally {
    harness.cleanup();
  }
});

test('rejects scoped command fields before mutating the pending review', async () => {
  const harness = createHarness({ runId: 'run-command-fields-rejected' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);

    await assert.rejects(
      harness.execution.execute(
        new Command({
          resume: {
            [pendingInterrupt.id]: { action: 'confirm' },
          },
          update: { control: { humanReview: false } },
          goto: '__end__',
          graph: 'parent',
        }),
        harness.config,
      ),
    );

    const persisted = await harness.execution.getState(harness.config);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].interrupts.length, 1);
    assert.equal(persisted.tasks[0].interrupts[0].id, pendingInterrupt.id);
    assert.equal(persisted.values.control.humanReview, true);
  } finally {
    harness.cleanup();
  }
});

test('rejects an unscoped resume without consuming the pending review', async () => {
  const harness = createHarness({ runId: 'run-unscoped-confirm' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);

    await assert.rejects(
      harness.execution.execute(
        { kind: 'resume', decision: { action: 'confirm' } },
        harness.config,
      ),
    );

    const persisted = await harness.execution.getState(harness.config);
    assert.deepEqual(persisted.next, ['review_conclusion']);
    assert.equal(persisted.tasks.length, 1);
    assert.equal(persisted.tasks[0].interrupts.length, 1);
    assert.equal(persisted.tasks[0].interrupts[0].id, pendingInterrupt.id);
  } finally {
    harness.cleanup();
  }
});

test('reject resumes at hypothesis generation and returns to review', async () => {
  const harness = createHarness({ runId: 'run-reject-review' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const traceBeforeResume = harness.trace.length;
    const interruptedAgain = await harness.execution.execute(
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

/**
 * The invariant here is unchanged and the ANSWER is not, which is why this row
 * was rewritten rather than left alone.
 *
 * A stale id has never been able to complete a newer review. What it used to do
 * was RESOLVE — LangGraph replayed the pending task with the resume map
 * unmatched, handed the caller back the interrupt that was already there, and
 * said nothing about the id it had ignored. A caller who did not compare
 * interrupt ids read that as success. AIC-92 made it a refusal that names the
 * id, because the same silent replay was also the route into
 * `preserveGraphOwnedControl` on a run that had moved past its review.
 *
 * Both halves are asserted: the refusal, and — still — that the newer review is
 * untouched underneath it. A refusal that also consumed the pending interrupt
 * would satisfy the first half alone.
 */
test('a stale interrupt id cannot complete a newer review', async () => {
  const harness = createHarness({ runId: 'run-stale-review-decision' });

  try {
    const firstInterrupted = await interruptAndReopen(harness);
    const firstInterrupt = currentInterrupt(firstInterrupted);
    const secondInterrupted = await harness.execution.execute(
      resumeCurrent(firstInterrupted, { action: 'reject' }),
      harness.config,
    );
    const secondInterrupt = currentInterrupt(secondInterrupted);
    assert.notEqual(secondInterrupt.id, firstInterrupt.id);

    const staleReplay = await harness.execution
      .execute(
        {
          kind: 'resume',
          interruptId: firstInterrupt.id,
          decision: { action: 'confirm' },
        },
        harness.config,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

    assert.equal(
      'error' in staleReplay,
      true,
      'a decision aimed at an interrupt the run has moved past must be refused, not replayed into a resolved-looking answer',
    );
    assert.match(
      staleReplay.error.message,
      /not the interrupt thread .* is waiting on/,
      `the refusal must say the run is waiting on a different interrupt: ${staleReplay.error.message}`,
    );
    assert.equal(
      staleReplay.error.message.includes(firstInterrupt.id),
      true,
      'the refusal must name the id the caller sent, not only the thread',
    );

    const persisted = await harness.execution.getState(harness.config);
    assert.deepEqual(
      persisted.next,
      ['review_conclusion'],
      'the refusal must leave the newer review exactly where it was',
    );
    assert.equal(
      persisted.tasks[0].interrupts[0].id,
      secondInterrupt.id,
      'the newer interrupt must still be the pending one after the refusal',
    );
  } finally {
    harness.cleanup();
  }
});

test('add_hypothesis persists the human hypothesis and resumes at prediction derivation', async () => {
  const harness = createHarness({ runId: 'run-add-hypothesis-review' });

  try {
    const interrupted = await interruptAndReopen(harness);
    const traceBeforeResume = harness.trace.length;
    const interruptedAgain = await harness.execution.execute(
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

test('add_hypothesis refuses an existing id without overwriting state', async () => {
  const harness = createHarness({ runId: 'run-duplicate-human-hypothesis' });
  const existingHypothesis = {
    ...addedHypothesis,
    statement: 'The existing hypothesis must remain unchanged',
  };
  harness.state.hypotheses = [existingHypothesis];

  try {
    const interrupted = await interruptAndReopen(harness);
    await assert.rejects(
      harness.execution.execute(
        resumeCurrent(interrupted, {
          action: 'add_hypothesis',
          hypothesis: addedHypothesis,
        }),
        harness.config,
      ),
    );
    const persisted = await harness.execution.getState(harness.config);
    assert.deepEqual(persisted.values.hypotheses, [existingHypothesis]);
  } finally {
    harness.cleanup();
  }
});

test('duplicate add_hypothesis rejection leaves the same review resumable by confirm', async () => {
  const runId = 'run-duplicate-then-confirm-review';
  const harness = createHarness({ runId });
  const existingHypothesis = {
    ...addedHypothesis,
    statement: 'The existing hypothesis must remain unchanged',
  };
  harness.state.hypotheses = [existingHypothesis];

  try {
    const interrupted = await interruptAndReopen(harness);
    const pendingInterrupt = currentInterrupt(interrupted);

    await assert.rejects(
      harness.execution.execute(
        resumeCurrent(interrupted, {
          action: 'add_hypothesis',
          hypothesis: addedHypothesis,
        }),
        harness.config,
      ),
      /human-added hypothesis reuses an existing hypothesis id/,
    );

    const completed = await harness.execution.execute(
      {
        kind: 'resume',
        interruptId: pendingInterrupt.id,
        decision: { action: 'confirm' },
      },
      harness.config,
    );
    const persisted = await harness.execution.getState(harness.config);

    assert.equal(isInterrupted(completed), false);
    assert.deepEqual(completed.hypotheses, [existingHypothesis]);
    assert.deepEqual(completed.conclusion, proposedConclusion);
    assert.equal(completed.control.runId, runId);
    assert.deepEqual(persisted.next, []);
  } finally {
    harness.cleanup();
  }
});

test('add_hypothesis refuses graph-owned challenge provenance', async () => {
  const harness = createHarness({ runId: 'run-invalid-human-provenance' });

  try {
    const interrupted = await interruptAndReopen(harness);
    await assert.rejects(
      harness.execution.execute(
        resumeCurrent(interrupted, {
          action: 'add_hypothesis',
          hypothesis: { ...addedHypothesis, createdBy: 'challenge' },
        }),
        harness.config,
      ),
    );
    const persisted = await harness.execution.getState(harness.config);
    assert.deepEqual(persisted.values.hypotheses, []);
  } finally {
    harness.cleanup();
  }
});

test('humanReview=false bypasses review and completes at END', async () => {
  const runId = 'run-benchmark-no-review';
  const harness = createHarness({ humanReview: false, runId });

  try {
    const completed = await harness.execution.execute(
      { kind: 'start', state: harness.state },
      harness.config,
    );

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

/**
 * A START with humanReview:false is the legitimate unattended path (the test
 * above). These fixtures are about a NODE flipping the review gate or the run
 * identity mid-run: `humanReview` decides whether `propose_conclusion` routes
 * to `review_conclusion` or END, and `runId` is what the interactive identity
 * check compares against the thread, so both are graph-owned like the budgets.
 */
const foreignRunId = 'someone-elses-run';

function proposeWithControlUpdate(rewrite) {
  return async (state) => ({
    conclusion: proposedConclusion,
    control: { ...state.control, ...rewrite },
  });
}

/**
 * The node mutates the control it was handed and returns that same object,
 * for the same reason as the resume-counter twin in investigation-graph: an
 * unreturned mutation never reaches the channel whether the field is protected
 * or not, so it would prove nothing.
 */
function proposeWithMutatedControl(rewrite) {
  return async (state) => {
    Object.assign(state.control, rewrite);
    return { conclusion: proposedConclusion, control: state.control };
  };
}

async function assertReviewGateIntact(harness, runId) {
  const persisted = await harness.execution.getState(harness.config);
  assert.deepEqual(
    persisted.next,
    ['review_conclusion'],
    'a rogue control update must not route the conclusion past the human review',
  );
  assert.equal(
    persisted.values.control.humanReview,
    true,
    'only the graph may write humanReview, so a node dropping it must be ignored',
  );
  assert.equal(
    persisted.values.control.runId,
    runId,
    'only the graph may write runId, so a node rewriting it must be ignored',
  );
}

async function confirmAndAssertIdentity(harness, interrupted, runId) {
  const completed = await harness.execution.execute(
    resumeCurrent(interrupted, { action: 'confirm' }),
    harness.config,
  );
  assert.equal(isInterrupted(completed), false);
  assert.equal(completed.control.humanReview, true);
  assert.equal(completed.control.runId, runId);
}

test('does not let a lifecycle node drop humanReview to skip the conclusion review', async () => {
  const runId = 'run-node-drops-human-review';
  const harness = createHarness({
    runId,
    proposeConclusion: proposeWithControlUpdate({ humanReview: false }),
  });

  try {
    const interrupted = await interruptAndReopen(harness);
    await assertReviewGateIntact(harness, runId);
    await confirmAndAssertIdentity(harness, interrupted, runId);
  } finally {
    harness.cleanup();
  }
});

test('restores humanReview when a lifecycle node mutates the control it was handed', async () => {
  const runId = 'run-node-mutates-human-review';
  const harness = createHarness({
    runId,
    proposeConclusion: proposeWithMutatedControl({ humanReview: false }),
  });

  try {
    const interrupted = await interruptAndReopen(harness);
    await assertReviewGateIntact(harness, runId);
    await confirmAndAssertIdentity(harness, interrupted, runId);
  } finally {
    harness.cleanup();
  }
});

test('does not let a lifecycle node rewrite the graph-owned runId', async () => {
  const runId = 'run-node-rewrites-run-id';
  const harness = createHarness({
    runId,
    proposeConclusion: proposeWithControlUpdate({ runId: foreignRunId }),
  });

  try {
    const interrupted = await interruptAndReopen(harness);
    await assertReviewGateIntact(harness, runId);
    await confirmAndAssertIdentity(harness, interrupted, runId);
  } finally {
    harness.cleanup();
  }
});

test('restores the graph-owned runId when a lifecycle node mutates the control it was handed', async () => {
  const runId = 'run-node-mutates-run-id';
  const harness = createHarness({
    runId,
    proposeConclusion: proposeWithMutatedControl({ runId: foreignRunId }),
  });

  try {
    const interrupted = await interruptAndReopen(harness);
    await assertReviewGateIntact(harness, runId);
    await confirmAndAssertIdentity(harness, interrupted, runId);
  } finally {
    harness.cleanup();
  }
});

test('does not let a lifecycle node disarm both the review gate and the run identity at once', async () => {
  const runId = 'run-node-disarms-review-and-identity';
  const harness = createHarness({
    runId,
    proposeConclusion: proposeWithControlUpdate({
      humanReview: false,
      runId: foreignRunId,
    }),
  });

  try {
    const interrupted = await interruptAndReopen(harness);
    await assertReviewGateIntact(harness, runId);
    await confirmAndAssertIdentity(harness, interrupted, runId);
  } finally {
    harness.cleanup();
  }
});
