import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  INCIDENT_STATE_SCHEMA_VERSION,
  IncidentStateControlSchema,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as graphPackage from '@aic/graph';

import { conclusionReviewDecisions } from './fixtures/conclusion-review-decisions.mjs';
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
  let tupleReads = 0;
  let rewritePersistedControl;
  checkpointer.getTuple = async (config) => {
    tupleReads += 1;
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
    tupleReads() {
      return tupleReads;
    },
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

/**
 * Derived from `ConclusionReviewDecisionSchema`, not listed. A member added to
 * that union arrives here on its own, and arrives without a fixture — which
 * throws by name rather than leaving these loops quietly one route short.
 */
const resumeDecisions = conclusionReviewDecisions(humanHypothesis);

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
 * The boundary the refusal deliberately does NOT cross, pinned because the
 * implementation had a choice here and nothing else records which one it took.
 *
 * "No checkpoint" is decided from the ABSENCE OF `control` in the snapshot, not
 * from an empty task list. A run that has already been confirmed has no pending
 * task either, but it has a checkpoint and a real state — refusing it as
 * "no checkpoint for thread …" would be a false statement about the thread.
 * Resuming a finished run stays what it was: a no-op that resolves.
 *
 * Deciding from `snapshot.tasks.length === 0` instead passes every other test
 * in this file, which is why this one exists.
 */
test('resolves a resume of a run that already finished, rather than calling it a missing checkpoint', async () => {
  const harness = createHarness({ runId: 'run-resume-after-finish' });

  try {
    const interrupted = await harness.start();
    const confirmed = await harness.resume(interrupted, { action: 'confirm' });
    assert.equal(
      'error' in confirmed,
      false,
      `the first confirm must complete the run: ${confirmed.error?.message ?? ''}`,
    );

    const [pending] = interrupted[INTERRUPT];
    const again = await harness.execution
      .execute(
        {
          kind: 'resume',
          interruptId: pending.id,
          decision: { action: 'confirm' },
        },
        harness.config,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

    assert.equal(
      'error' in again,
      false,
      `a finished run has a checkpoint, so resuming it must not be refused as missing one: ${again.error?.message ?? ''}`,
    );

    const control = await harness.control();
    assert.equal(
      control.resumeCount,
      1,
      'the no-op resume must not count a second resume the human did not spend',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The challenge counters need their own rows, for a reason the logical
 * counters' header does NOT give.
 *
 * `LogicalCountSchema` is not what guards these two ON THIS PATH. Both fields
 * have carried it since AIC-76, so a `-1` is refused at the `kind: 'start'`
 * boundary — but a `kind: 'resume'` takes its state from the checkpointer and
 * is never parsed by `IncidentStateSchema` at all, which is what these rows are
 * about. What refuses such a value here is the graph's own
 * `assertChallengeCounters` — deliberately not enumerated by call site, because
 * a hand-written list of sites in prose is the copy that goes stale, and this
 * one did on the very next change to the set (AIC-75 added a fifth). `grep -n
 * assertChallengeCounters packages/graph/src/investigation.ts` is the list.
 *
 * What matters here is not how many sites there are but which route reaches
 * one. A `confirm` decides nothing from these counters and reaches END without
 * entering another lifecycle node, so `reviewConclusion` asserting above
 * `interrupt()` is the only thing standing on that route.
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
 * reported on. It is not the only route the refusal has to cover, and these
 * rows check the other two.
 *
 * ⚠ What these rows discriminate CHANGED under AIC-75, and saying so is the
 * point of this paragraph. They were written to show that where
 * `reviewConclusion`'s assertion sits is load-bearing: moved into the confirm
 * branch it would satisfy every row above, while a `reject` went back to
 * running a whole lifecycle cycle before anything refused it. That argument no
 * longer holds. `reject` and `add_hypothesis` re-enter at `generate_hypotheses`
 * and `derive_predictions`, both wrapped, and the wrapper now asserts these
 * counters on entry — so these two rows stay green with `reviewConclusion`'s
 * assertion deleted outright. Measured: deleting it reddens 8 tests here, and
 * the two that went quiet are exactly these.
 *
 * Do not complete that thought as "so the wrapper is what these rows exercise
 * now" — it is not. Deleting the WRAPPER's assertion alone also leaves them
 * green; only the entry-time test in investigation-graph.test.mjs reddens.
 * These two rows redden when BOTH calls go, and not before. They are mutually
 * masked, exactly like the three sites named in that wrapper's own comment.
 *
 * They are kept, and not because deleting a test is unpleasant. What they pin
 * is still true and still worth pinning — a corrupt counter is refused before
 * another node runs, on every route a human can take — and `confirm` remains a
 * route where `reviewConclusion` is the only guard. What they no longer prove
 * on their own is the placement argument above, and a reader who took the old
 * sentence at face value would over-trust them.
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

/**
 * The rows above all resume a thread that HAS a checkpoint, and the checkpoint
 * is where every refusal so far read its reason from. A thread with no
 * checkpoint at all has no such state to complain about, and that is the case
 * this block covers.
 *
 * Measured at bc51808, with a checkpointer configured: an unknown thread's
 * snapshot carries no channel values for `control`, the graph enters
 * `normalize_incident` on empty state, and `assertInteractiveRunIdentity`
 * surfaces as `TypeError: Cannot read properties of undefined (reading
 * 'humanReview')`. A caller receiving that cannot tell a thread it mistyped
 * from a thread whose checkpoint belongs to another run.
 *
 * A resume input must carry a well-formed interrupt id to be parsed at all, and
 * a thread that never ran has no real one to offer. That is not what these rows
 * discriminate: measured at the same commit, a well-formed id matching no
 * pending interrupt resolves as a no-op against a live thread and leaves its
 * interrupt pending. The thread is what decides these outcomes, not the id.
 */
const neverRunThreadId = 'run-thread-that-never-started-8f3a';
const wellFormedInterruptId = 'a1b2c3d4000000000000000000000fff';

function attemptResume(execution, config, decision) {
  return execution
    .execute(
      {
        kind: 'resume',
        interruptId: wellFormedInterruptId,
        decision,
      },
      config,
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
}

/**
 * What the refusal has to name, split into its two halves so that neither can
 * be dropped in silence — as a disjunction over them, either could.
 *
 * Deliberately not `/checkpoint/i`, which is what this started as: that matched
 * `Cannot use Command(resume=...) without checkpointer` and `No checkpointer
 * set` too, the wrong refusals this change exists to stop displacing. And not
 * "no investigation state" either, which is false of the second state the guard
 * fires on — a checkpoint whose `control` is gone still carries its other eight
 * channels. What is true of both is that there is no run to resume and no
 * control to resume it from.
 */
const namesTheMissingRun = /no resumable run/i;
const namesTheAbsentControl = /no investigation control/i;
const namesTheForeignCheckpoint = /interactive runId must match LangGraph thread_id/;

test('refuses a resume under a thread that has no checkpoint, naming the thread', async () => {
  const harness = createHarness({ runId: neverRunThreadId });

  try {
    const outcome = await attemptResume(harness.execution, harness.config, {
      action: 'confirm',
    });

    assert.equal(
      'error' in outcome,
      true,
      'a resume of a thread that never ran must be refused, not started from nothing',
    );
    assert.equal(
      outcome.error instanceof TypeError,
      false,
      `a caller-facing refusal is not an internal type error: ${outcome.error?.message ?? ''}`,
    );
    assert.doesNotMatch(
      outcome.error.message,
      /Cannot read properties of undefined/,
      'a missing checkpoint must not surface as a property read on absent state',
    );
    assert.ok(
      outcome.error.message.includes(neverRunThreadId),
      `the refusal must name the thread it could not resume: ${outcome.error.message}`,
    );
    assert.match(
      outcome.error.message,
      namesTheMissingRun,
      'the refusal must name what was missing, not merely that something was',
    );
    assert.match(
      outcome.error.message,
      namesTheAbsentControl,
      'the refusal must name the control it could not find, not only that a run is missing',
    );
    assert.deepEqual(
      harness.trace,
      [],
      'a thread with nothing to resume must not execute a lifecycle node',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The refusal has to land BEFORE the graph is invoked, and the message alone
 * does not prove that. Measured at bc51808: the refused resume above still
 * writes a checkpoint for the thread it failed on — `next: ['normalize_incident']`,
 * one pending task, a checkpoint id — so `getState` reports a started run on a
 * thread where nothing ran.
 *
 * That is the whole of the measured consequence. An earlier draft of this
 * comment added "which a later resume would read as real state", and that is
 * false: at bc51808 a second resume returns the identical TypeError and a later
 * `start` under the ghost id resolves normally.
 */
test('leaves no checkpoint behind for the thread whose resume it refused', async () => {
  const harness = createHarness({ runId: neverRunThreadId });

  try {
    const before = await harness.execution.getState(harness.config);
    assert.deepEqual(
      { next: [...before.next], tasks: before.tasks.length },
      { next: [], tasks: 0 },
      'the premise of this test: the thread starts with nothing to resume',
    );

    await attemptResume(harness.execution, harness.config, {
      action: 'confirm',
    });
    const after = await harness.execution.getState(harness.config);

    assert.deepEqual(
      {
        next: [...after.next],
        tasks: after.tasks.length,
        checkpointId: after.config?.configurable?.checkpoint_id ?? null,
      },
      { next: [], tasks: 0, checkpointId: null },
      'a refused resume must not leave a half-started run under the thread it refused',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The item's actual complaint: the two failures a caller most needs to tell
 * apart are a thread with NO checkpoint and a checkpoint belonging to ANOTHER
 * run, and today only the second one is named.
 *
 * The mismatched half is built by rewriting the persisted `runId` rather than
 * by resuming under a second thread id, because a second thread id is not the
 * mismatched case at all — it is the missing one, which is what the first half
 * already covers. Every successful resume reaches
 * `assertInteractiveRunIdentity` with state to judge; a checkpoint whose
 * `runId` is foreign to its thread is the only shape that reaches it and
 * FAILS, which is the shape this half needs.
 */
test('tells a missing checkpoint apart from a mismatched one', async () => {
  const missing = createHarness({ runId: neverRunThreadId });
  const mismatched = createHarness({
    runId: 'run-thread-carrying-a-foreign-checkpoint',
  });

  try {
    const missingOutcome = await attemptResume(
      missing.execution,
      missing.config,
      { action: 'confirm' },
    );

    const interrupted = await mismatched.start();
    mismatched.rewriteEveryPersistedControl((control) => ({
      ...control,
      runId: 'run-some-other-investigation',
    }));
    const mismatchedOutcome = await mismatched.resume(interrupted, {
      action: 'confirm',
    });

    assert.deepEqual(
      {
        missingRefused: 'error' in missingOutcome,
        mismatchedRefused: 'error' in mismatchedOutcome,
      },
      { missingRefused: true, mismatchedRefused: true },
      'neither an absent checkpoint nor a foreign one may resume',
    );
    assert.match(
      mismatchedOutcome.error.message,
      namesTheForeignCheckpoint,
      'a checkpoint that belongs to another run keeps the refusal it already gives',
    );
    assert.match(
      missingOutcome.error.message,
      namesTheMissingRun,
      'an absent checkpoint must be named as absent, not left for the caller to guess',
    );
    assert.match(
      missingOutcome.error.message,
      namesTheAbsentControl,
      'the refusal must name the control it could not find, not only that a run is missing',
    );
    assert.doesNotMatch(
      missingOutcome.error.message,
      namesTheForeignCheckpoint,
      'a thread with no checkpoint must not be reported as a run identity mismatch',
    );
    assert.notEqual(
      missingOutcome.error.message,
      mismatchedOutcome.error.message,
      'a caller must be able to tell a thread it mistyped from a thread that holds another run',
    );
  } finally {
    missing.cleanup();
    mismatched.cleanup();
  }
});

/**
 * Limit one of the guard, with a row instead of a sentence.
 *
 * A checkpoint can EXIST while its `control` channel does not — a partial write,
 * or a checkpoint from before the channel existed. That state is not the ghost
 * thread: `getState` reports a checkpoint id and a pending task, and the other
 * eight channels are populated. The guard refuses it with the same message, and
 * the message has to be true about it: not "no checkpoint" and not "no state",
 * but no CONTROL to resume from.
 *
 * Without this row the guard can be narrowed to "the snapshot is empty" and
 * nothing goes red — measured, and it is what put this row here.
 */
test('refuses a checkpoint whose control channel is gone, without calling the thread empty', async () => {
  const harness = createHarness({ runId: 'run-checkpoint-without-control' });

  try {
    const interrupted = await harness.start();
    harness.rewriteEveryPersistedControl(() => undefined);

    const outcome = await harness.resume(interrupted, { action: 'confirm' });

    assert.equal(
      'error' in outcome,
      true,
      'a checkpoint carrying no control has nothing to resume from',
    );
    assert.match(outcome.error.message, namesTheMissingRun);
    assert.match(
      outcome.error.message,
      namesTheAbsentControl,
      'the message must name the control, because this thread does have a checkpoint and does have state',
    );
    assert.doesNotMatch(
      outcome.error.message,
      /Cannot read properties of undefined/,
      'this state must not fall through to the identity check either',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * What was AIC-74's limit two, closed by AIC-89 — and this row is the reason the
 * closing was noticed rather than silent.
 *
 * AIC-74 left `control` present but MALFORMED (`null`) uncaught: its check was
 * `values?.control === undefined`, and `null !== undefined`, so the value
 * reached `assertInteractiveRunIdentity` and raised a raw TypeError. That row
 * said in as many words: "if someone widens the guard to catch it, this row
 * goes red and they can delete it deliberately."
 *
 * AIC-89 widened it. `readOwnControl` returns a control or nothing, and `null`
 * is nothing — so a malformed control is now refused by name, on the same
 * message as an absent one, which is true of it: there is no run to resume.
 * The row is kept, inverted, rather than deleted: it is the only coverage of a
 * malformed control, and without it the behaviour would be unpinned again.
 */
test('refuses a malformed control by name instead of leaving it to the identity check', async () => {
  const harness = createHarness({ runId: 'run-checkpoint-with-null-control' });

  try {
    const interrupted = await harness.start();
    harness.rewriteEveryPersistedControl(() => null);

    const outcome = await harness.resume(interrupted, { action: 'confirm' });

    assert.equal('error' in outcome, true);
    assert.match(
      outcome.error.message,
      namesTheMissingRun,
      'a malformed control is no run to resume, and must be refused as one',
    );
    assert.match(outcome.error.message, namesTheAbsentControl);
    assert.doesNotMatch(
      outcome.error.message,
      /Cannot read properties of null/,
      'the refusal must be the graph deciding, not a property read on a value it did not check',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * Why this graph needs TWO ownership checks rather than one.
 *
 * `execute` validates the control that `graph.getState` deserialized, and then
 * `graph.invoke` deserializes the checkpoint AGAIN and runs on that second
 * object. One check cannot cover both, and the gap between them is not
 * theoretical: `security-scanner` measured a 124-turn window in which arming an
 * `Object.prototype` accessor completed a resume, skipped the human-review
 * identity check, and persisted a control the domain schema rejects — using
 * nothing but microtask scheduling. AIC-90 closed it by adding the second check
 * on the object the run uses, at the top of `reviewConclusion`.
 *
 * The two reads remain, so this row stays green and keeps its job: it pins the
 * FACT that makes two checks necessary. A change that removes the second
 * deserialization turns it red, and that is the signal to ask whether the
 * second check is still earning its place — not to restore the number.
 */
test('reads the checkpoint twice per resume, so one guard cannot cover both objects', async () => {
  const harness = createHarness({ runId: 'run-two-deserializations' });

  try {
    const interrupted = await harness.start();
    const readsBeforeResume = harness.tupleReads();

    const resumed = await harness.resume(interrupted, { action: 'confirm' });
    assert.equal(
      'error' in resumed,
      false,
      `the clean resume must succeed for its read count to mean anything: ${resumed.error?.message ?? ''}`,
    );

    assert.equal(
      harness.tupleReads() - readsBeforeResume,
      2,
      'one read is execute validating the control, the other is graph.invoke deserializing it again for the run',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * A graph built without a checkpointer already refuses a resume for a reason of
 * its own, and that reason names the missing MECHANISM rather than a missing
 * checkpoint. A guard that reads the snapshot on the resume path must not reach
 * it — `getState` throws `GraphValueError: No checkpointer set` there — and must
 * not restate it as a thread-level complaint.
 *
 * All three decisions, and they do NOT all pass at bc51808. Measured there:
 * `confirm` and `reject` answer `Cannot use Command(resume=...) without
 * checkpointer`, while `add_hypothesis` answers `GraphValueError: No
 * checkpointer set` — because that decision is the one that read the snapshot
 * first. So two of these rows are regression pins and the third is the row that
 * caught this change moving a caller-visible message. Pinning `confirm` alone,
 * as the first draft did, would have left exactly that route uncovered.
 */
for (const { label, decision } of resumeDecisions) {
  test(`still refuses a ${label} resume with no checkpointer for the reason it already gives`, async () => {
    const execution = graphPackage.createInvestigationGraph({
      nodes: reviewedRunNodes([], stalledTermination),
    });

    const outcome = await attemptResume(
      execution,
      { threadId: neverRunThreadId },
      decision(1),
    );

    assert.equal(
      'error' in outcome,
      true,
      'a resume without a checkpointer must still be refused',
    );
    assert.match(
      outcome.error.message,
      /Cannot use Command\(resume=\.\.\.\) without checkpointer/,
      'the unconfigured-checkpointer refusal must survive the new one',
    );
    assert.equal(
      outcome.error.message.includes(neverRunThreadId),
      false,
      'with no checkpointer there is no thread to blame, so the refusal must not name one',
    );
  });
}

/**
 * AIC-89 — a `kind: 'resume'` must run on the control the CHECKPOINT owns,
 * never on one `Object.prototype` supplied.
 *
 * AIC-87 closed this on the `kind: 'start'` path with `assertOwnControlFields`,
 * called from `parseInvestigationExecutionInput`. A resume never passes through
 * that function's start branch and never through `IncidentStateSchema` at all:
 * its control comes back off disk, and the deserializer builds that object by
 * ASSIGNING each field. With an accessor of the same name on `Object.prototype`
 * the assignment lands on the inherited setter, no own property is created, and
 * every later read — the graph's guards, the node's, the spread that writes the
 * control back — falls through to the getter.
 *
 * That makes the resume path the worse half of the same defect, because the
 * corruption is DURABLE. `{ ...state.control }` copies own enumerable
 * properties, so a field the setter swallowed is not merely misread, it is
 * dropped from what gets checkpointed.
 *
 * Measured at 286b45f against the real SQLite checkpointer, one accessor per
 * control field armed on a run genuinely paused at `review_conclusion`, resumed
 * with `confirm`:
 *
 * - ten of the thirteen fields are refused, every one of them for a reason that
 *   has nothing to do with noticing the substitution — an inherited STRING fails
 *   that field's own validator, or `runId` stops matching the thread;
 * - `phase`, `stopKind` and `humanReview` are not refused at all. The run
 *   completes, counts its resume, and writes back a control missing that field:
 *   `humanReview` and `phase` leave a control on disk that
 *   `IncidentStateControlSchema.safeParse` then rejects with `expected boolean,
 *   received undefined` and `expected string, received undefined`; `stopKind`
 *   loses the terminal stop kind silently, since the field is optional and the
 *   damaged control still parses.
 *
 * The value the accessor hands out is deliberately one string for every field
 * rather than a type-plausible substitute per field: ownership is what the guard
 * has to decide on, and a per-field value list is the hand-written copy that goes
 * stale. Type-plausible values were measured too and change nothing that matters
 * here — an accessor returning `false` for `humanReview` and one returning `99`
 * for `resumeCount` both complete, the first losing `humanReview` from disk
 * exactly as the string does, the second persisting `resumeCount: 100`.
 */

/** What the polluted prototype hands out; distinct from every fixture value. */
const INHERITED_VALUE = 'inherited';

/**
 * Derived, never hand-listed: a field added to the control schema is covered
 * here the day it is declared.
 */
const CONTROL_FIELDS = Object.keys(IncidentStateControlSchema.shape);

/**
 * The refusal this ticket asks for — the graph's own, naming the offending
 * field. Same wording as the start path's, because it is the same invariant and
 * a caller should not have to learn two spellings of it.
 */
const OWN_CONTROL_REFUSAL = /investigation control must carry its own (\w+)/;

/**
 * Every refusal the polluted resume already produces today for a reason that is
 * not the guard. Ten distinct messages, measured at 286b45f as described above;
 * `invalid investigation execution input` is the eleventh member and this path
 * did not produce it — it is here because every other block in this file guards
 * against the opaque refusal displacing a specific one.
 *
 * Without this set, "it threw, so the guard works" passes for a guard nobody
 * wrote: ten of the thirteen subtests below would be green on an unchanged tree.
 */
const INCIDENTAL_RESUME_REFUSALS = new RegExp(
  [
    namesTheForeignCheckpoint.source,
    'incompatible persisted state',
    'invalid iteration budget',
    'invalid llm call budget',
    'invalid reserved challenge budget',
    'invalid challenge round counter',
    'invalid logical iteration counter',
    'invalid llm call counter',
    'invalid resume counter',
    'invalid investigation execution input',
  ].join('|'),
);

/**
 * Arms the hazardous shape: an accessor, not a data property. A plain inherited
 * data property is shadowed by the value the checkpoint carries and is harmless;
 * the accessor is what removes ownership. The setter swallows instead of
 * throwing, which is the quiet shape — a getter-only property would make the
 * deserializer's assignment throw a `TypeError` in strict mode, and the resume
 * would then fail on the assignment rather than on the substitution.
 */
function armInheritedAccessor(field, value = INHERITED_VALUE) {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return value;
    },
    set() {},
  });
}

/**
 * One paused interactive run, resumed with the prototype armed for exactly the
 * window of the resume, and the control that ended up on disk read back
 * afterwards.
 *
 * Two things about the ordering are load-bearing:
 *
 * - the run is STARTED under a clean prototype, so what is under test is the
 *   restored control and not a start state that was already substituted;
 * - the prototype is restored SYNCHRONOUSLY in `finally`, and before the
 *   persisted control is read back. `t.after` would not do: a subtest's hooks
 *   run at the end of the PARENT, so the accessor would stay armed for every
 *   later subtest, which would then fail on each other's pollution. And the read
 *   has to happen after the restore because the read deserializes too — an armed
 *   accessor swallows the field on the way back in and would report damage on
 *   disk that is not there.
 */
async function resumeUnderPollutedPrototype({ runId, field, value }) {
  const harness = createHarness({ runId });

  try {
    const interrupted = await harness.start();
    const traceBeforeResume = [...harness.trace];

    let outcome;
    try {
      if (field !== undefined) armInheritedAccessor(field, value);
      outcome = await harness.resume(interrupted, { action: 'confirm' });
    } finally {
      if (field !== undefined) delete Object.prototype[field];
    }

    return {
      outcome,
      traceBeforeResume,
      trace: [...harness.trace],
      persistedControl: await harness.control(),
    };
  } finally {
    harness.cleanup();
  }
}

test('refuses a resume whose restored control field is supplied by an accessor on the prototype', async (t) => {
  assert.equal(
    CONTROL_FIELDS.length > 0,
    true,
    'an empty control schema would make every subtest below vacuous',
  );

  for (const field of CONTROL_FIELDS) {
    await t.test(`refuses an inherited ${field} accessor`, async () => {
      const { outcome } = await resumeUnderPollutedPrototype({
        runId: `run-resume-own-control-${field}`,
        field,
      });

      assert.equal(
        'error' in outcome,
        true,
        `a resume whose ${field} is supplied by the prototype must be refused, not run to completion`,
      );

      const message = outcome.error.message;
      assert.doesNotMatch(
        message,
        INCIDENTAL_RESUME_REFUSALS,
        `refusing ${field} because an inherited string fails its validator is not the guard working: ${message}`,
      );

      const named = OWN_CONTROL_REFUSAL.exec(message);
      assert.notEqual(
        named,
        null,
        `refusing an inherited ${field} must say so in the graph's own words, not: ${message}`,
      );
      assert.equal(
        named[1],
        field,
        `the refusal named ${named?.[1]} while the prototype supplied ${field}`,
      );
    });
  }
});

/**
 * The durable half, and the reason this ranks above AIC-87.
 *
 * A start-path substitution costs a run. A resume-path one costs the
 * CHECKPOINT: the run completes, the damaged control is written back, and every
 * later reader of that thread — including a resume under a perfectly clean
 * prototype — finds a control that no longer satisfies its own schema.
 *
 * `safeParse` is a floor rather than the whole claim. It is blind to `stopKind`
 * going missing, because the field is optional; the test above is what covers
 * that field, and this one is what covers the two that leave state on disk no
 * reader can parse.
 */
test('leaves no unparseable control on disk when it refuses', async (t) => {
  for (const field of CONTROL_FIELDS) {
    await t.test(`persists a parseable control despite an inherited ${field} accessor`, async () => {
      const { persistedControl } = await resumeUnderPollutedPrototype({
        runId: `run-resume-durable-control-${field}`,
        field,
      });

      const parsed = IncidentStateControlSchema.safeParse(persistedControl);
      assert.equal(
        parsed.success,
        true,
        `a resume polluted at ${field} must not leave a control on disk that no longer parses: ${
          parsed.error?.issues
            .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
            .join('; ') ?? ''
        }`,
      );
    });
  }
});

/**
 * `control` is not one of the thirteen field names, so the loops above never
 * arm it — and it is the worst shape of all: the prototype supplies the WHOLE
 * control, so a thread with no checkpoint appears to have one.
 *
 * Measured at 286b45f: `values?.control === undefined` resolves up the chain to
 * the fabricated object, the AIC-74 ghost-thread refusal never fires, the graph
 * is invoked on a thread that never ran, and the caller receives `TypeError:
 * channels[chan].get is not a function` from inside LangGraph's channel map —
 * which the pollution has also displaced. That is a refusal by collision, not by
 * check, and it says nothing about the thread the caller mistyped.
 */
test('refuses a fabricated control supplied entirely by the prototype', async () => {
  const harness = createHarness({ runId: neverRunThreadId });
  const fabricated = Object.freeze(initialState('run-nobody-started').control);

  try {
    let outcome;
    try {
      armInheritedAccessor('control', fabricated);
      outcome = await attemptResume(harness.execution, harness.config, {
        action: 'confirm',
      });
    } finally {
      delete Object.prototype.control;
    }

    assert.equal(
      'error' in outcome,
      true,
      'a thread with no checkpoint must be refused however convincing the prototype is',
    );
    assert.equal(
      outcome.error instanceof TypeError,
      false,
      `a caller-facing refusal is not an internal type error: ${outcome.error?.message ?? ''}`,
    );
    assert.doesNotMatch(
      outcome.error.message,
      /is not a function|Cannot read properties/,
      'a fabricated control must be refused by a check, not by LangGraph colliding with the same pollution',
    );
    assert.ok(
      outcome.error.message.includes(neverRunThreadId),
      `the refusal must name the thread it could not resume: ${outcome.error.message}`,
    );
    assert.match(
      outcome.error.message,
      namesTheMissingRun,
      'a control nobody checkpointed is still no resumable run',
    );
    assert.match(
      outcome.error.message,
      namesTheAbsentControl,
      'the refusal must name the control it could not find, exactly as it does with a clean prototype',
    );
    assert.doesNotMatch(
      outcome.error.message,
      namesTheForeignCheckpoint,
      'a thread with no checkpoint must not be reported as a run identity mismatch',
    );
    assert.deepEqual(
      harness.trace,
      [],
      'a thread with nothing to resume must not execute a lifecycle node',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The clean-prototype arm of the two loops above, run through the same helper
 * so that a guard written too broadly — one that refuses on the mere PRESENCE of
 * a field rather than on its ownership — goes red here.
 *
 * It passes today and must keep passing.
 */
test('resumes normally, counting one resume, when nothing is on the prototype', async () => {
  const { outcome, persistedControl } = await resumeUnderPollutedPrototype({
    runId: 'run-resume-clean-prototype',
  });

  assert.equal(
    'error' in outcome,
    false,
    `an unpolluted resume must complete: ${outcome.error?.message ?? ''}`,
  );
  assert.equal(
    IncidentStateControlSchema.safeParse(persistedControl).success,
    true,
    'an unpolluted resume must leave a control on disk that parses',
  );
  assert.equal(
    persistedControl.resumeCount,
    1,
    'one human confirm is one resume, and the pollution rows are only meaningful against this',
  );
});

/**
 * AIC-90 — the resume must run on a control the guard actually checked.
 *
 * The row above ("reads the checkpoint twice per resume") pins the mechanism:
 * `execute` validates what `graph.getState` deserialized, and `graph.invoke`
 * then deserializes the checkpoint AGAIN and runs on a second object. AIC-89's
 * `assertOwnControlFields` therefore inspects an object the run discards. These
 * rows pin the CONSEQUENCE — that between the two deserializations there is a
 * window in which the ownership guard is bypassed and the run persists a
 * control the domain schema rejects.
 *
 * The attack needs nothing but microtask scheduling: no instrumentation of the
 * checkpointer, no control over its timing, only the ability to run a
 * self-rescheduling microtask chain concurrently with the resume — which any
 * code sharing the event loop can do. `createHarness` counts tuple reads and
 * nothing else here rewrites them.
 *
 * Measured on this machine at 226185a, `Object.prototype.humanReview` armed at
 * microtask turn N of the resume, every turn in 1..400:
 *
 * - turns 1-39 — refused, by AIC-89's guard: the accessor is armed before
 *   `graph.getState` resolves, so the object the guard reads is already the
 *   polluted one;
 * - turns 40-163 — the run COMPLETES. The guard saw a clean control, the
 *   accessor arms afterwards, `graph.invoke`'s deserialization assigns
 *   `humanReview` into the inherited setter, and the control written back has no
 *   own `humanReview` at all: `IncidentStateControlSchema.safeParse` rejects it
 *   with `expected boolean, received undefined`, and the resume counted itself
 *   as a normal one;
 * - turns 164-400 — clean, and NOT because nothing armed. Measured: a `confirm`
 *   resume spans 331 microtask turns, so turns 164-331 do arm during it; only
 *   332+ never fire. They are clean because both deserializations are already
 *   past by then. The first version of this line said "nothing is ever armed",
 *   which understated the coverage in the safe direction while misstating the
 *   mechanism — in the paragraph a reader trusts about how far the scan sees.
 *
 * Identical for an accessor returning `false` and one returning the string
 * `'inherited'`, and identical across three consecutive scans — the window is
 * an artifact of the two reads, not of timing noise, which is why it can be a
 * test at all.
 */

/** The field the window was measured on; a member of the schema, not a literal
 * the schema no longer declares — see the assertion in the helper below. */
const POLLUTED_FIELD = 'humanReview';

/**
 * What an honest interactive run carries in that field, and therefore what must
 * be on disk after any resume the scan calls clean.
 *
 * The accessor supplies `false`, which is schema-valid — so without this the
 * scan's oracle cannot tell "the run kept its own value" from "the run adopted
 * the attacker's and the review gate is off". That distinction is the whole
 * severity of the defect.
 */
const EXPECTED_POLLUTED_VALUE = true;

/**
 * A self-rescheduling microtask chain, counted in turns.
 *
 * It ALWAYS terminates — at `turns`, or earlier on `cancel()`. That is not
 * tidiness: microtasks drain to exhaustion before the event loop turns, so a
 * chain that reschedules forever wedges the process rather than failing a test.
 *
 * `onTurn` is invoked once, on the last turn, and never after `cancel()` — the
 * caller relies on that to guarantee nothing arms the prototype after it has
 * been restored.
 */
function scheduleMicrotaskChain({ turns, onTurn }) {
  let cancelled = false;
  let turnsRun = 0;
  let fired = false;

  const step = () => {
    if (cancelled) return;
    turnsRun += 1;
    if (turnsRun >= turns) {
      if (onTurn !== undefined) {
        onTurn();
        fired = true;
      }
      return;
    }
    Promise.resolve().then(step);
  };
  Promise.resolve().then(step);

  return {
    cancel() {
      cancelled = true;
    },
    get fired() {
      return fired;
    },
    get turnsRun() {
      return turnsRun;
    },
  };
}

/**
 * The scan harness, and it is in the repository on purpose: the finding was
 * produced by a throwaway script, and a window nobody can re-measure is a
 * number in a ticket rather than a property of this code.
 *
 * One paused interactive run, resumed with a microtask chain racing it, and the
 * outcome classified into exactly three kinds:
 *
 * - `refused` — the resume rejected;
 * - `corrupt` — the resume COMPLETED and the control left on disk fails
 *   `IncidentStateControlSchema.safeParse`;
 * - `clean` — the resume completed and the persisted control still parses.
 *
 * Four orderings are load-bearing, three of them for the same reason
 * `resumeUnderPollutedPrototype` gives above:
 *
 * - the run is STARTED under a clean prototype, so what is under test is the
 *   restored control and not a start state that was already substituted;
 * - the chain is cancelled and the prototype restored SYNCHRONOUSLY in
 *   `finally`, never in `t.after` — a hook runs at the end of the PARENT test,
 *   which would leave the accessor armed across every later row;
 * - the cancel comes BEFORE the delete. A chain that has not reached its turn
 *   yet is still pending when the resume settles, and deleting first would let
 *   it arm the prototype afterwards — pollution outliving the test that owns it;
 * - the persisted control is read back AFTER the restore, because that read
 *   deserializes too and an armed accessor would swallow the field on the way
 *   in, reporting damage on disk that is not there.
 */
async function resumeRacedByMicrotaskChain({
  runId,
  turn,
  arm = true,
  value = INHERITED_VALUE,
}) {
  assert.equal(
    CONTROL_FIELDS.includes(POLLUTED_FIELD),
    true,
    `the scan arms ${POLLUTED_FIELD}, which the control schema no longer declares — re-pick the field from CONTROL_FIELDS`,
  );
  assert.equal(
    POLLUTED_FIELD in {},
    false,
    `the prototype is already carrying ${POLLUTED_FIELD} before this run started: an earlier row leaked it`,
  );

  const harness = createHarness({ runId });

  try {
    const interrupted = await harness.start();

    let outcome;
    let chain;
    try {
      chain = scheduleMicrotaskChain({
        turns: turn,
        onTurn: arm
          ? () => armInheritedAccessor(POLLUTED_FIELD, value)
          : undefined,
      });
      outcome = await harness.resume(interrupted, { action: 'confirm' });
    } finally {
      chain.cancel();
      delete Object.prototype[POLLUTED_FIELD];
    }

    const persistedControl = await harness.control();
    const parsed = IncidentStateControlSchema.safeParse(persistedControl);
    const refused = 'error' in outcome;

    // Parse alone is the WRONG oracle, and measuring only it hid the worst
    // outcome: a control that parses cleanly while carrying the value the
    // attacker supplied. On `main` the reject and add_hypothesis routes produce
    // exactly that — `humanReview: false`, schema-valid, review gate disarmed,
    // nothing on disk recording it — so a parse-only scan reports those routes
    // as having no window at all. Value fidelity is the assertion that sees it.
    const substituted =
      !refused &&
      parsed.success &&
      persistedControl[POLLUTED_FIELD] !== EXPECTED_POLLUTED_VALUE;

    return {
      turn,
      armed: chain.fired,
      outcome,
      persistedControl,
      substituted,
      kind: refused
        ? 'refused'
        : substituted
          ? 'substituted'
          : parsed.success
            ? 'clean'
            : 'corrupt',
      issues:
        parsed.success === true
          ? ''
          : parsed.error.issues
              .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
              .join('; '),
    };
  } finally {
    harness.cleanup();
  }
}

/** Compacts scanned turns into ranges, so a failure names the window it found
 * rather than printing a hundred numbers. */
function describeTurns(turns) {
  if (turns.length === 0) return '(none)';
  const ranges = [];
  for (const turn of turns) {
    const last = ranges.at(-1);
    if (last !== undefined && last.to + SCAN_STRIDE === turn) last.to = turn;
    else ranges.push({ from: turn, to: turn });
  }
  return ranges
    .map(({ from, to }) => (from === to ? `${from}` : `${from}-${to}`))
    .join(', ');
}

/**
 * ⚠ What this scan can and cannot see, stated because a green run here is easy
 * to over-read.
 *
 * It CAN see: every arming turn from 1 to 200 inclusive, on the `confirm`
 * route, for an accessor on `humanReview`. The measured window (40-163 on this
 * machine, 40-162 as reported on the scanner's) sits inside that with 39 turns
 * of refusal before it and 37 turns of clean completion after it, so both edges
 * are covered rather than assumed.
 *
 * It CANNOT see: an arming turn past 200 — beyond the range, a chain simply
 * never fires, and 164-400 was measured clean for that reason rather than for a
 * reassuring one; the other twelve control fields; the `reject` and
 * `add_hypothesis` routes, whose resumes replay more nodes and therefore have
 * their own, longer, unmeasured windows; and any window that a future change
 * opens at a turn this scan happens to step over.
 *
 * So this row SAMPLES the absence of a window. It does not prove one. If it
 * goes red on a turn outside 40-163, the correct response is to re-measure the
 * whole range, not to widen the stride until it passes.
 *
 * Cost, measured: 200 resumes against a real SQLite checkpointer, about 3s on
 * this machine — the file was 2.2s before it.
 */
const SCAN_FIRST_TURN = 1;
const SCAN_LAST_TURN = 200;
const SCAN_STRIDE = 1;

test('no arming turn leaves a control the domain schema rejects', async () => {
  const rows = [];
  for (
    let turn = SCAN_FIRST_TURN;
    turn <= SCAN_LAST_TURN;
    turn += SCAN_STRIDE
  ) {
    rows.push(
      await resumeRacedByMicrotaskChain({
        runId: `run-resume-race-turn-${turn}`,
        turn,
      }),
    );
  }

  const armed = rows.filter((row) => row.armed);
  assert.ok(
    armed.length > 0,
    'no scanned turn armed the prototype during its resume, so this scan proves nothing — re-measure the turn range',
  );

  const corrupt = rows.filter((row) => row.kind === 'corrupt');
  assert.deepEqual(
    corrupt.map((row) => row.turn),
    [],
    `a resume racing a microtask chain persisted a control the domain schema rejects at turns ${describeTurns(
      corrupt.map((row) => row.turn),
    )} — refused at ${describeTurns(
      rows.filter((row) => row.kind === 'refused').map((row) => row.turn),
    )}, clean at ${describeTurns(
      rows.filter((row) => row.kind === 'clean').map((row) => row.turn),
    )}; first failure: ${corrupt[0]?.issues ?? ''}`,
  );

  // The severe outcome, and the one a parse-only oracle scores as clean: the
  // control is schema-valid and carries the value the accessor supplied, with
  // the review gate off and nothing on disk saying so.
  const substituted = rows.filter((row) => row.kind === 'substituted');
  assert.deepEqual(
    substituted.map((row) => row.turn),
    [],
    `a resume racing a microtask chain persisted a PARSEABLE control carrying the accessor's ${POLLUTED_FIELD} at turns ${describeTurns(
      substituted.map((row) => row.turn),
    )} — the review gate is disarmed and the checkpoint records nothing about it`,
  );
});

/**
 * The deterministic row: one turn, well inside the measured window, chosen
 * because a scan that samples is a poor regression signal on its own.
 *
 * 100 is not arbitrary — it sits 60 turns past the refusal edge and 63 turns
 * short of the clean one, the widest margin the measured window offers. Every
 * turn in 40-163 corrupted on three consecutive scans of the full range, so
 * this is a stable choice rather than a lucky one.
 *
 * It asserts a REFUSAL, which is the remedy this ticket asks for and the one
 * every sibling row in this file already spells the same way. A fix that made
 * the resume immune instead — rebuilding the control at the persistence
 * boundary so no pollution can reach it — would complete cleanly and redden
 * this row. That is deliberate: choosing immunity over refusal is a
 * caller-visible decision about whether an attempted substitution is reported,
 * and this row is where it gets recorded rather than absorbed.
 */
const ARMING_TURN_INSIDE_WINDOW = 100;

test('refuses the pollution armed at a turn inside the measured window', async () => {
  const raced = await resumeRacedByMicrotaskChain({
    runId: 'run-resume-race-inside-window',
    turn: ARMING_TURN_INSIDE_WINDOW,
  });

  assert.equal(
    raced.armed,
    true,
    `the chain never reached turn ${ARMING_TURN_INSIDE_WINDOW} during the resume, so nothing was under test — the window has moved and needs re-measuring`,
  );
  assert.notEqual(
    raced.kind,
    'corrupt',
    `a resume polluted at turn ${ARMING_TURN_INSIDE_WINDOW} completed and left a control on disk that no longer parses: ${raced.issues}`,
  );
  assert.equal(
    raced.kind,
    'refused',
    `pollution armed between the guard's read and the run's must be refused, not resumed to a ${raced.kind} completion`,
  );

  const message = raced.outcome.error.message;
  assert.doesNotMatch(
    message,
    INCIDENTAL_RESUME_REFUSALS,
    `refusing for a reason that is not the ownership guard is not this defect being fixed: ${message}`,
  );

  const named = OWN_CONTROL_REFUSAL.exec(message);
  assert.notEqual(
    named,
    null,
    `the refusal must be the graph's own words about ownership, not: ${message}`,
  );
  assert.equal(
    named[1],
    POLLUTED_FIELD,
    `the refusal named ${named?.[1]} while the prototype supplied ${POLLUTED_FIELD}`,
  );
});

/**
 * The control arm, and the reason the two rows above mean what they say.
 *
 * The same self-rescheduling chain, interleaved with the same resume at the
 * same turn, arming NOTHING. It separates "a microtask chain running alongside
 * the resume perturbs it" from "the pollution corrupts it" — without this, a
 * red scan could be read as the harness breaking the run, and the fix would be
 * aimed at the wrong thing.
 *
 * It passes before the fix and must pass after it.
 */
test('completes a resume interleaved with a microtask chain that arms nothing', async () => {
  const raced = await resumeRacedByMicrotaskChain({
    runId: 'run-resume-race-unarmed-chain',
    turn: ARMING_TURN_INSIDE_WINDOW,
    arm: false,
  });

  assert.equal(
    'error' in raced.outcome,
    false,
    `a chain that arms nothing must not disturb the resume: ${raced.outcome.error?.message ?? ''}`,
  );
  assert.equal(
    raced.kind,
    'clean',
    'a resume raced by an inert chain must leave a control on disk that parses',
  );
  assert.equal(
    raced.persistedControl.resumeCount,
    1,
    'one human confirm is one resume, however the microtasks interleaved',
  );
});
