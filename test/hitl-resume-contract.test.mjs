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
import { INTERRUPT, isInterrupted } from '@langchain/langgraph';

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

const stalledTermination = async () => ({
  route: 'terminal',
  stopKind: 'stalled',
});

const alwaysNeedsMoreEvidence = async () => ({ route: 'need-more-evidence' });

function reviewedRunNodes(trace, terminationCheck) {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async (state) => {
        trace.push(name);
        if (name === 'termination_check') return terminationCheck(state);
        if (name === 'challenge_hypothesis') {
          throw new Error('challenge must not run in this review fixture');
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
    incident: { id: 'incident-hitl-resume-contract' },
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
      humanReview: true,
      ...control,
    },
  };
}

/**
 * A checkpointer whose reads can be rewritten after the run has already
 * interrupted, so a resume reads persisted state the current code never wrote.
 * That is the only way to exercise the resume path against a checkpoint left
 * behind by an earlier schema version — the writing side always writes the
 * current one.
 */
function createHarness({
  runId,
  terminationCheck = stalledTermination,
  control = {},
}) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-hitl-resume-'));
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

  const trace = [];
  const execution = graphPackage.createInvestigationGraph({
    nodes: reviewedRunNodes(trace, terminationCheck),
    checkpointer,
  });
  const config = { threadId: runId };

  return {
    trace,
    config,
    execution,
    rewriteEveryPersistedControl(rewrite) {
      rewritePersistedControl = rewrite;
    },
    async start() {
      const interrupted = await execution.execute(
        { kind: 'start', state: initialState(runId, control) },
        config,
      );
      assert.equal(
        isInterrupted(interrupted),
        true,
        'an interactive conclusion must pause instead of resolving at END',
      );
      return interrupted;
    },
    resume(interrupted, decision) {
      assert.equal(isInterrupted(interrupted), true);
      assert.equal(interrupted[INTERRUPT].length, 1);
      const [current] = interrupted[INTERRUPT];
      return execution
        .execute(
          { kind: 'resume', interruptId: current.id, decision },
          config,
        )
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
    },
    control() {
      return execution
        .getState(config)
        .then((snapshot) => snapshot.values.control);
    },
    cleanup() {
      checkpointer.db.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

const humanHypothesis = (round) => ({
  id: `human-hypothesis-${round}`,
  statement: 'A dependency outside the initial candidate set is failing',
  createdBy: 'initial',
});

const resumeDecisions = [
  { label: 'confirm', decision: () => ({ action: 'confirm' }) },
  { label: 'reject', decision: () => ({ action: 'reject' }) },
  {
    label: 'add_hypothesis',
    decision: (round) => ({
      action: 'add_hypothesis',
      hypothesis: humanHypothesis(round),
    }),
  },
];

/**
 * A rejected resume only proves a version boundary if the same resume succeeds
 * against a checkpoint at the current version: a decision the graph refuses for
 * some unrelated reason would satisfy every rejection assertion for the wrong
 * reason.
 */
async function assertCurrentVersionResumeResolves(runId, decision) {
  const harness = createHarness({ runId });

  try {
    const outcome = await harness.resume(await harness.start(), decision);
    assert.equal(
      'error' in outcome,
      false,
      `a checkpoint at schema version ${INCIDENT_STATE_SCHEMA_VERSION} must still resume: ${
        outcome.error?.message ?? ''
      }`,
    );
  } finally {
    harness.cleanup();
  }
}

const outdatedPersistedControls = [
  {
    label: 'a previous-version checkpoint without the usage counters',
    slug: 'without-counters',
    rewrite: (control) => {
      const {
        iterationsUsed: _iterationsUsed,
        llmCallsUsed: _llmCallsUsed,
        ...rest
      } = control;
      return { ...rest, schemaVersion: INCIDENT_STATE_SCHEMA_VERSION - 1 };
    },
  },
  {
    label: 'a previous-version checkpoint that still carries the usage counters',
    slug: 'with-counters',
    rewrite: (control) => ({
      ...control,
      schemaVersion: INCIDENT_STATE_SCHEMA_VERSION - 1,
    }),
  },
  // The two rows above follow the current version wherever it goes; these two
  // pin the version the resume counter replaced, so a later bump cannot quietly
  // stop refusing a version-2 checkpoint.
  {
    label: 'a version-2 checkpoint written before the resume counter existed',
    slug: 'version-2-without-resume-count',
    rewrite: (control) => {
      const { resumeCount: _resumeCount, ...rest } = control;
      return { ...rest, schemaVersion: 2 };
    },
  },
  {
    label: 'a version-2 checkpoint that already carries the resume counter',
    slug: 'version-2-with-resume-count',
    rewrite: (control) => ({ ...control, schemaVersion: 2 }),
  },
];

const namesTheVersionBoundary = /schema ?version|incompatible version/i;

for (const persisted of outdatedPersistedControls) {
  for (const { label, decision } of resumeDecisions) {
    test(`resuming ${persisted.label} with ${label} fails loudly at the schema version boundary`, async () => {
      await assertCurrentVersionResumeResolves(
        `run-current-version-${label}-${persisted.slug}`,
        decision(1),
      );

      const harness = createHarness({
        runId: `run-outdated-${label}-${persisted.slug}`,
      });

      try {
        const interrupted = await harness.start();
        const traceBeforeResume = [...harness.trace];
        harness.rewriteEveryPersistedControl(persisted.rewrite);

        const outcome = await harness.resume(interrupted, decision(1));

        assert.equal(
          'error' in outcome,
          true,
          'persisted state from an incompatible schema version must be refused, not resumed',
        );
        assert.match(
          outcome.error.message,
          namesTheVersionBoundary,
          'the refusal must name the version boundary it refused on',
        );
        assert.doesNotMatch(
          outcome.error.message,
          /invalid logical iteration counter/,
          'an incompatible persisted version must not surface as a counter complaint',
        );
        assert.notEqual(
          outcome.error.message,
          'invalid investigation execution input',
          'an incompatible persisted version must not surface as the opaque input refusal',
        );
        assert.deepEqual(
          harness.trace,
          traceBeforeResume,
          'the refusal must land before the resumed run executes another lifecycle node',
        );
      } finally {
        harness.cleanup();
      }
    });
  }
}

/**
 * The counter guard's remaining job is the RESUME path.
 *
 * On `kind: 'start'` the domain schema parses the input first, so a fractional,
 * negative or non-safe-integer counter is refused by `LogicalCountSchema`
 * before the graph's own guard is ever consulted — a start-path table proves
 * the schema, not the guard. A checkpoint is never parsed, so the resume path
 * is the one place where neutering `assertLogicalBudgetCounters` would let a
 * corrupt counter through.
 *
 * These rows hold the schema version at the CURRENT one on purpose: the
 * refusal has to name the counter rather than the version, or a corrupt
 * counter would be indistinguishable from stale state.
 */
const corruptPersistedCounters = [
  {
    field: 'iterationsUsed',
    label: 'logical iteration counter',
    namesTheCounter: /invalid logical iteration counter/,
  },
  {
    field: 'llmCallsUsed',
    label: 'llm call counter',
    namesTheCounter: /invalid llm call counter/,
  },
  {
    field: 'resumeCount',
    label: 'resume counter',
    namesTheCounter: /invalid resume counter/,
  },
];

const corruptCounterValues = [
  { label: 'fractional', slug: 'fractional', value: 0.5 },
  { label: 'negative', slug: 'negative', value: -1 },
  {
    label: 'non-safe-integer',
    slug: 'non-safe-integer',
    value: Number.MAX_SAFE_INTEGER + 1,
  },
];

for (const counter of corruptPersistedCounters) {
  for (const corruption of corruptCounterValues) {
    test(`refuses a current-version checkpoint carrying a ${corruption.label} ${counter.label}, and names the counter`, async () => {
      const slug = `${counter.field}-${corruption.slug}`;
      await assertCurrentVersionResumeResolves(
        `run-current-version-counter-${slug}`,
        { action: 'confirm' },
      );

      const harness = createHarness({ runId: `run-corrupt-counter-${slug}` });

      try {
        const interrupted = await harness.start();
        const traceBeforeResume = [...harness.trace];
        harness.rewriteEveryPersistedControl((control) => ({
          ...control,
          schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
          [counter.field]: corruption.value,
        }));

        const outcome = await harness.resume(interrupted, { action: 'confirm' });

        assert.equal(
          'error' in outcome,
          true,
          'a checkpoint whose counter is not a count must be refused, not resumed to completion',
        );
        assert.match(
          outcome.error.message,
          counter.namesTheCounter,
          'the refusal must name the counter it refused on',
        );
        assert.doesNotMatch(
          outcome.error.message,
          namesTheVersionBoundary,
          'a corrupt counter at the current version must not surface as a version complaint',
        );
        assert.notEqual(
          outcome.error.message,
          'invalid investigation execution input',
          'a corrupt counter must not surface as the opaque input refusal',
        );
        assert.deepEqual(
          harness.trace,
          traceBeforeResume,
          'the refusal must land before the resumed run executes another lifecycle node',
        );
      } finally {
        harness.cleanup();
      }
    });
  }
}

/**
 * The challenge counters need their own rows, for a reason the logical
 * counters' header does NOT give.
 *
 * `LogicalCountSchema` is not what guards these two: `IncidentStateControlSchema`
 * declares `reservedChallengeBudget` and `challengeRounds` as bare `z.number()`,
 * which accepts -1 on the `kind: 'start'` path as readily as a checkpoint does
 * on the resume path. What refuses such a value is the graph's own
 * `assertChallengeCounters`, called from `routeChallenge`, `terminationCheck`,
 * `challengeHypothesis` and — since these rows went green — `reviewConclusion`.
 * The first three read the counters to decide something; a `confirm` decides
 * nothing from them and reaches END without visiting any of the three, which is
 * why the corruption has to be planted on a checkpoint and resumed rather than
 * passed at start, and why `reviewConclusion` had to assert them itself.
 *
 * Like the rows above, these hold the schema version at the CURRENT one: the
 * refusal has to name the counter rather than the version.
 */
const corruptPersistedChallengeCounters = [
  {
    field: 'challengeRounds',
    label: 'challenge round counter',
    namesTheCounter: /invalid challenge round counter/,
    // This counter is the only one with an upper bound, so it is the only one
    // whose table carries a value that is a perfectly good count and still not
    // a state this graph can be in.
    corruptions: [
      ...corruptCounterValues,
      {
        label: 'past-the-cap',
        slug: 'past-the-cap',
        value: graphPackage.MAX_CHALLENGE_ROUNDS + 1,
      },
    ],
  },
  {
    field: 'reservedChallengeBudget',
    label: 'reserved challenge budget',
    namesTheCounter: /invalid reserved challenge budget/,
    corruptions: corruptCounterValues,
  },
];

for (const counter of corruptPersistedChallengeCounters) {
  for (const corruption of counter.corruptions) {
    test(`refuses a current-version checkpoint carrying a ${corruption.label} ${counter.label}, and names the counter`, async () => {
      const slug = `${counter.field}-${corruption.slug}`;
      await assertCurrentVersionResumeResolves(
        `run-current-version-counter-${slug}`,
        { action: 'confirm' },
      );

      const harness = createHarness({ runId: `run-corrupt-counter-${slug}` });

      try {
        const interrupted = await harness.start();
        const traceBeforeResume = [...harness.trace];
        harness.rewriteEveryPersistedControl((control) => ({
          ...control,
          schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
          [counter.field]: corruption.value,
        }));

        const outcome = await harness.resume(interrupted, { action: 'confirm' });

        assert.equal(
          'error' in outcome,
          true,
          'a checkpoint whose challenge counter no other entry point would accept must be refused, not resumed to completion',
        );
        assert.match(
          outcome.error.message,
          counter.namesTheCounter,
          'the refusal must name the counter it refused on',
        );
        assert.doesNotMatch(
          outcome.error.message,
          namesTheVersionBoundary,
          'a corrupt counter at the current version must not surface as a version complaint',
        );
        assert.notEqual(
          outcome.error.message,
          'invalid investigation execution input',
          'a corrupt counter must not surface as the opaque input refusal',
        );
        assert.deepEqual(
          harness.trace,
          traceBeforeResume,
          'the refusal must land before the resumed run executes another lifecycle node',
        );
      } finally {
        harness.cleanup();
      }
    });
  }
}

/**
 * The rows above all resume with `confirm`, which is the route the finding was
 * reported on. It is not the only route the refusal has to cover, and where the
 * assertion SITS is what decides that: above `interrupt()` and above the branch
 * on the decision, it refuses before the resumed run reads the decision at all.
 * Moved into the confirm branch it would still satisfy every row above, while a
 * reject went back to running a whole lifecycle cycle before anything refused
 * it. So the route is a dimension of its own here, not a detail of the fixture.
 */
for (const { label, decision } of resumeDecisions) {
  test(`refuses a negative challenge round counter before a resumed ${label} executes another node`, async () => {
    await assertCurrentVersionResumeResolves(
      `run-current-version-challenge-route-${label}`,
      decision(1),
    );

    const harness = createHarness({ runId: `run-challenge-route-${label}` });

    try {
      const interrupted = await harness.start();
      const traceBeforeResume = [...harness.trace];
      harness.rewriteEveryPersistedControl((control) => ({
        ...control,
        schemaVersion: INCIDENT_STATE_SCHEMA_VERSION,
        challengeRounds: -1,
      }));

      const outcome = await harness.resume(interrupted, decision(1));

      assert.equal(
        'error' in outcome,
        true,
        'a checkpoint whose challenge counter no other entry point would accept must be refused on every resume route',
      );
      assert.match(
        outcome.error.message,
        /invalid challenge round counter/,
        'the refusal must name the counter it refused on',
      );
      assert.deepEqual(
        harness.trace,
        traceBeforeResume,
        'the refusal must land before the resumed run executes another lifecycle node, whichever route the human took',
      );
    } finally {
      harness.cleanup();
    }
  });
}

/**
 * The graph owns `resumeCount`, and a resume is the only thing that moves it:
 * pausing at the interrupt is not one, and neither is a lifecycle node replayed
 * by the resume — a reject re-enters the graph and runs a whole cycle again, so
 * a counter incremented per node would report several resumes for one human
 * decision.
 */
for (const { label, decision } of resumeDecisions) {
  test(`counts one resume for a human ${label} decision, however many nodes replay after it`, async () => {
    const harness = createHarness({ runId: `run-resume-count-${label}` });

    try {
      const interrupted = await harness.start();

      assert.equal(
        (await harness.control()).resumeCount,
        0,
        'a run paused at the interrupt has not been resumed yet',
      );

      const outcome = await harness.resume(interrupted, decision(1));

      assert.equal(
        'error' in outcome,
        false,
        `a human ${label} must resume the run: ${outcome.error?.message ?? ''}`,
      );
      assert.equal(
        (await harness.control()).resumeCount,
        1,
        `one human ${label} is one resume, whatever the resume replayed`,
      );
    } finally {
      harness.cleanup();
    }
  });
}

test('counts every resume of a run the human sent back before confirming it', async () => {
  const harness = createHarness({ runId: 'run-resume-count-twice' });

  try {
    const rejected = await harness.resume(await harness.start(), {
      action: 'reject',
    });

    assert.equal(
      'error' in rejected,
      false,
      `a rejected conclusion must re-enter the graph: ${
        rejected.error?.message ?? ''
      }`,
    );
    assert.equal(
      (await harness.control()).resumeCount,
      1,
      'the first resume must be counted before the second one happens',
    );

    const confirmed = await harness.resume(rejected.value, {
      action: 'confirm',
    });

    assert.equal(
      'error' in confirmed,
      false,
      `a confirmed conclusion must end the run: ${
        confirmed.error?.message ?? ''
      }`,
    );
    assert.equal(
      (await harness.control()).resumeCount,
      2,
      'two human decisions are two resumes, and the confirm path must carry the count to the end',
    );
  } finally {
    harness.cleanup();
  }
});

test('counts the resumes a human spends re-entering the graph without counting the replayed nodes', async () => {
  const harness = createHarness({
    runId: 'run-resume-count-replay',
    terminationCheck: alwaysNeedsMoreEvidence,
    control: { maxIterations: 1, llmCallBudget: 100 },
  });

  try {
    let interrupted = await harness.start();

    for (const round of [1, 2, 3]) {
      const traceBeforeResume = harness.trace.length;
      const outcome = await harness.resume(interrupted, { action: 'reject' });

      assert.equal(
        'error' in outcome,
        false,
        `resume ${round} must re-enter the graph: ${outcome.error?.message ?? ''}`,
      );
      interrupted = outcome.value;
      const replayedNodes = harness.trace.length - traceBeforeResume;
      const control = await harness.control();

      assert.ok(
        replayedNodes > 1,
        `resume ${round} must replay more than one node, or this proves nothing`,
      );
      assert.equal(
        control.resumeCount,
        round,
        `resume ${round} replayed ${replayedNodes} nodes and must still count as one resume`,
      );
    }
  } finally {
    harness.cleanup();
  }
});

const humanReEntryRoutes = [
  {
    label: 'reject',
    decision: () => ({ action: 'reject' }),
    reEntryNode: 'generate_hypotheses',
  },
  {
    label: 'add_hypothesis',
    decision: (round) => ({
      action: 'add_hypothesis',
      hypothesis: humanHypothesis(round),
    }),
    reEntryNode: 'derive_predictions',
  },
];

for (const route of humanReEntryRoutes) {
  test(`maxIterations caps the automatic loop-back edge while a ${route.label} re-entry is bounded by the human, and iterationsUsed keeps counting across it`, async () => {
    const runId = `run-human-reentry-${route.label}`;
    const harness = createHarness({
      runId,
      terminationCheck: alwaysNeedsMoreEvidence,
      control: { maxIterations: 1, llmCallBudget: 100 },
    });

    try {
      let interrupted = await harness.start();
      const plans = () =>
        harness.trace.filter((name) => name === 'plan_investigation').length;

      assert.deepEqual(
        {
          plans: plans(),
          iterationsUsed: (await harness.control()).iterationsUsed,
          stopKind: (await harness.control()).stopKind,
        },
        { plans: 1, iterationsUsed: 1, stopKind: 'budget-exhausted' },
        'the automatic need-more-evidence edge must stop at maxIterations',
      );

      for (const round of [1, 2, 3]) {
        const traceBeforeResume = harness.trace.length;
        const outcome = await harness.resume(interrupted, route.decision(round));

        assert.equal(
          'error' in outcome,
          false,
          `a human ${route.label} must re-enter the graph: ${
            outcome.error?.message ?? ''
          }`,
        );
        interrupted = outcome.value;
        const segment = harness.trace.slice(traceBeforeResume);
        const control = await harness.control();

        assert.deepEqual(
          {
            reEntryNode: segment[0],
            plansInSegment: segment.filter(
              (name) => name === 'plan_investigation',
            ).length,
            plans: plans(),
            iterationsUsed: control.iterationsUsed,
            stopKind: control.stopKind,
          },
          {
            reEntryNode: route.reEntryNode,
            plansInSegment: 1,
            plans: round + 1,
            iterationsUsed: round + 1,
            stopKind: 'budget-exhausted',
          },
          `human re-entry ${round} buys exactly one more iteration, and iterationsUsed reports it honestly`,
        );
      }
    } finally {
      harness.cleanup();
    }
  });
}
