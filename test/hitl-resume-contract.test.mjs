import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ConclusionReviewDecisionSchema,
  INCIDENT_STATE_SCHEMA_VERSION,
  IncidentStateControlSchema,
  STATUS_RULES_VERSION,
} from '@aic/domain';
import * as graphPackage from '@aic/graph';

import { conclusionReviewDecisions } from './fixtures/conclusion-review-decisions.mjs';
import { createSqliteCheckpointer } from '@aic/persistence';
import { INTERRUPT, interrupt, isInterrupted } from '@langchain/langgraph';

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
  nodes,
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
    nodes: nodes?.(trace) ?? reviewedRunNodes(trace, terminationCheck),
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
    startRaw() {
      return execution.execute(
        { kind: 'start', state: initialState(runId, control) },
        config,
      );
    },
    resumeWith(interruptId, decision) {
      return execution
        .execute({ kind: 'resume', interruptId, decision }, config)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
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
 * It CANNOT see: an arming turn past 200; the other twelve control fields; the
 * `reject` and `add_hypothesis` resumes, whose replays are longer and have
 * their own unmeasured windows; and any window a future change opens at a turn
 * this scan steps over.
 *
 * ⚠ Why it cannot see past 200 is the RANGE, not "a chain that never fires" —
 * which is what this paragraph claimed until AIC-92 checked it. A chain still
 * arms the prototype well beyond turn 163, and turns there are clean because
 * both deserializations are already past by the time the accessor lands, not
 * because nothing was armed. That is a claim about a mechanism, so it is a row
 * rather than a sentence: see › "arms the prototype well past the scan's range,
 * and lands after both deserializations". The old wording understated the
 * coverage in the safe direction while misstating the mechanism, in the
 * paragraph a reader trusts about the scan's reach — a limits block that is
 * wrong about WHY is the shape that survives review, because the conclusion
 * still reads right.
 *
 * ⚠ The `reject` and `add_hypothesis` limit above stays, and a reader comparing
 * this block with the stale-retry scan further down should not read that scan
 * as closing it. That one covers the `reject` route only, and only on a retry
 * of a run whose node THREW — a thread waiting on no interrupt at all, which is
 * a different replay from the ordinary in-contract `reject` resume this block
 * is about. It is deliberately NOT the `SUPERSEDED_INTERRUPT_REFUSAL` case
 * either; that scan asserts it is not. `add_hypothesis` gains nothing from it;
 * that scan's own limits block says so.
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
 * The mechanism behind the limits block's "past 200 is the range, not a chain
 * that never fires", so that sentence is a pointer rather than a claim.
 *
 * One turn well past the scan's last, chosen inside the region the old wording
 * called unarmed. Both halves are asserted, and neither is enough alone: the
 * chain DID reach its turn during the resume, and the resume was clean anyway —
 * which is the corrected mechanism, a late accessor rather than an absent one.
 *
 * It does not pin the exact turn the chain stops firing at. That number moves
 * with the machine, and a row asserting it would be a flake rather than a
 * limit; what has to be true is that arming continues past the range this scan
 * covers.
 *
 * Cost, measured: one resume, ~30ms.
 */
const TURN_PAST_SCAN_RANGE = 250;

test("arms the prototype well past the scan's range, and lands after both deserializations", async () => {
  const raced = await resumeRacedByMicrotaskChain({
    runId: 'run-resume-race-past-range',
    turn: TURN_PAST_SCAN_RANGE,
  });

  assert.equal(
    raced.armed,
    true,
    `the chain did not reach turn ${TURN_PAST_SCAN_RANGE} during the resume, so turns past the scan's range really are unarmed and the limits block above is wrong the other way`,
  );
  assert.equal(
    raced.kind,
    'clean',
    `a turn past the scan's range must land after both deserializations, not produce a ${raced.kind} outcome`,
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

/**
 * AIC-92 — the laundering primitive, and the two routes that reach it.
 *
 * AIC-87, 89 and 90 each closed a refusal SITE. None of them touched the thing
 * that makes a substituted value survive a refusal site: `pickGraphOwnedControl`
 * read each graph-owned field with a plain `[[Get]]` and re-defined it as an own
 * property, so a value the prototype supplied came out of that function owned,
 * carrying the substitution, and every ownership check downstream then passed.
 *
 * The two routes measured to reach it, both entirely through
 * `createInvestigationGraph`'s own API:
 *
 * 1. **A stale `interruptId`.** A resume whose interrupt is no longer pending
 *    replays the thread's pending task — a WRAPPED lifecycle node — so
 *    `preserveGraphOwnedControl` runs before `reviewConclusion` ever does. What
 *    a CLI does after a transient failure: pause, reject, a node throws, retry
 *    the same id.
 * 2. **A caller-supplied node that calls `interrupt()`.** Resuming it re-enters
 *    at that node, which is wrapped, with the same result and a PENDING id.
 *    `InvestigationNode` does not declare `interrupt()`, but nothing refuses a
 *    node that calls it, and a contract gap a caller can walk through is a
 *    route.
 *
 * ⚠ Both are closed at the PRIMITIVE, and no row here is satisfied by a route
 * refusal. An earlier version of this change also refused the stale id in
 * `execute`, which would have made route 1's rows green without
 * `pickGraphOwnedControl` doing anything — and, worse, made a run whose node
 * threw unresumable, since such a thread has a pending task and zero pending
 * interrupts and `execute` offers no replay that carries no id. What survives
 * of that idea is narrower and is about answering the wrong question rather
 * than about ownership: a decision naming an interrupt while the run waits on a
 * DIFFERENT one is refused, and a run waiting on none is still resumable.
 *
 * Measured on `main` (d8bdea1) for route 1, arming
 * `Object.prototype.humanReview` as an accessor returning `false` at each turn
 * of a microtask chain racing the retry: turns 1-33 refused, **34-175
 * substituted** — the retry completed, `humanReview: false` reached disk, the
 * control PARSED, and the run never paused for review again — 176 and past it
 * clean, the accessor arriving after both deserializations. That range is this
 * scan's own output on `main`, not a figure carried from the ticket: a
 * standalone probe of the same route reported 34-174, one turn narrower,
 * because the harness below takes an extra `getState` to prove the id is stale
 * before it retries. Route 2 is
 * deterministic rather than raced and is measured by checkpoint read below.
 *
 * The severity is the parse: a corrupt control is at least visible to anything
 * that reads it back, and this one is not. So every row here classifies on
 * VALUE FIDELITY, never on `safeParse` alone.
 */

/** The control the graph must be running on, and therefore what has to be on
 * disk after any resume these rows call clean. The accessor supplies `false`,
 * which is schema-valid — that is the whole point. */
const RETRY_EXPECTED_HUMAN_REVIEW = true;

/** The refusal a decision aimed at a SUPERSEDED interrupt must produce, in the
 * graph's own words. */
const SUPERSEDED_INTERRUPT_REFUSAL = /not the interrupt thread .* is waiting on/;

/**
 * Lifecycle nodes with one arming hook: `armFailure(name)` makes that node
 * throw ONCE, the next time it runs.
 *
 * Once, not always, because the sequence under test is a TRANSIENT failure — a
 * node that kept throwing would make the retry fail for its own reason and the
 * row would pass without ever exercising the replay.
 */
function nodesWithTransientFailure() {
  let armed;
  const armFailure = (name) => {
    armed = name;
  };
  return {
    armFailure,
    nodes: (trace) =>
      Object.fromEntries(
        lifecycleNodes.map((name) => [
          name,
          async (state) => {
            trace.push(name);
            if (armed === name) {
              armed = undefined;
              throw new Error('transient model failure');
            }
            if (name === 'termination_check') return stalledTermination(state);
            if (name === 'propose_conclusion') {
              return { conclusion: proposedConclusion };
            }
            return {};
          },
        ]),
      ),
  };
}

/**
 * Route 1, end to end: pause, reject, a node fails transiently, retry the same
 * interrupt id — with the prototype armed for exactly the window of the retry.
 *
 * The orderings `resumeRacedByMicrotaskChain` documents above are load-bearing
 * here for the same reasons, and one more: the failure is armed BETWEEN the
 * start and the reject, because `derive_predictions` also runs on the way to
 * the first pause and a failure armed at construction would break the start.
 */
async function retryStaleInterruptRacedByMicrotaskChain({
  runId,
  turn,
  arm = true,
}) {
  assert.equal(
    POLLUTED_FIELD in {},
    false,
    `the prototype is already carrying ${POLLUTED_FIELD} before this run started: an earlier row leaked it`,
  );

  const { nodes, armFailure } = nodesWithTransientFailure();
  const harness = createHarness({ runId, nodes });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    armFailure('derive_predictions');
    const failed = await harness.resumeWith(pending.id, { action: 'reject' });
    assert.equal(
      'error' in failed,
      true,
      'the transient failure must reject the first resume, or the retry under test is not a retry',
    );

    const stranded = await harness.execution.getState(harness.config);
    const pendingInterruptIds = stranded.tasks.flatMap(({ interrupts }) =>
      interrupts.map(({ id }) => id),
    );
    assert.equal(
      pendingInterruptIds.includes(pending.id),
      false,
      'the id under test must be stale after the failure, or this row proves nothing',
    );
    assert.ok(
      stranded.tasks.length > 0,
      'the thread must still have pending work, or this is the finished-run no-op rather than a stale retry',
    );

    let outcome;
    let chain;
    try {
      chain = scheduleMicrotaskChain({
        turns: turn,
        onTurn: arm
          ? () => armInheritedAccessor(POLLUTED_FIELD, false)
          : undefined,
      });
      outcome = await harness.resumeWith(pending.id, { action: 'reject' });
    } finally {
      chain.cancel();
      delete Object.prototype[POLLUTED_FIELD];
    }

    const persistedControl = await harness.control();
    const parsed = IncidentStateControlSchema.safeParse(persistedControl);
    const refused = 'error' in outcome;
    const substituted =
      !refused &&
      parsed.success &&
      persistedControl[POLLUTED_FIELD] !== RETRY_EXPECTED_HUMAN_REVIEW;

    return {
      turn,
      armed: chain.fired,
      outcome,
      persistedControl,
      pausedAgain: !refused && isInterrupted(outcome.value),
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

/**
 * ⚠ What this scan sees, and what it does not — the same shape as the confirm
 * route's block above, because a green run here is just as easy to over-read.
 *
 * It CAN see every arming turn from 1 to 200 on the `reject` retry route, for
 * an accessor on `humanReview`. The measured window on `main` (34-175 on this
 * machine) sits inside that with 33 turns of refusal before it and 25 turns of
 * clean completion after it, so both edges are covered rather than assumed.
 *
 * It CANNOT see the other twelve control fields, the `confirm` and
 * `add_hypothesis` retry routes, or a window a future change opens at a turn it
 * steps over. It SAMPLES the absence of a window; it does not prove one.
 *
 * The deterministic rows below are what carry the regression signal. This one
 * is what would catch the window MOVING.
 *
 * ⚠ Under the shipped code every row here is the same ownership refusal, so it
 * is a weak signal on its own — reverting `pickGraphOwnedControl` alone is what
 * reddens it, and that is the mutation this scan exists for.
 *
 * Cost, measured on this machine, as two figures rather than a difference:
 * this row run alone reports 5.2s, and the whole file reports 9.3s. 200
 * sequences of a start, a failed resume and a retry against a real SQLite
 * checkpointer. Both include the runner's own startup, which the row below
 * puts at about 0.5s.
 */
const RETRY_SCAN_FIRST_TURN = 1;
const RETRY_SCAN_LAST_TURN = 200;
const RETRY_SCAN_STRIDE = 1;

test('no arming turn launders a value into the control a stale retry persists', async () => {
  const rows = [];
  for (
    let turn = RETRY_SCAN_FIRST_TURN;
    turn <= RETRY_SCAN_LAST_TURN;
    turn += RETRY_SCAN_STRIDE
  ) {
    rows.push(
      await retryStaleInterruptRacedByMicrotaskChain({
        runId: `run-stale-retry-turn-${turn}`,
        turn,
      }),
    );
  }

  assert.ok(
    rows.some((row) => row.armed),
    'no scanned turn armed the prototype during its retry, so this scan proves nothing — re-measure the turn range',
  );

  const corrupt = rows.filter((row) => row.kind === 'corrupt');
  assert.deepEqual(
    corrupt.map((row) => row.turn),
    [],
    `a stale retry persisted a control the domain schema rejects at turns ${describeTurns(
      corrupt.map((row) => row.turn),
    )}; first failure: ${corrupt[0]?.issues ?? ''}`,
  );

  const substituted = rows.filter((row) => row.kind === 'substituted');
  assert.deepEqual(
    substituted.map((row) => row.turn),
    [],
    `a stale retry persisted a PARSEABLE control carrying the accessor's ${POLLUTED_FIELD} at turns ${describeTurns(
      substituted.map((row) => row.turn),
    )} — the review gate is disarmed and the checkpoint records nothing about it`,
  );
});

/**
 * The deterministic row for route 1, at a turn well inside the measured window:
 * 100 sits 66 turns past the substitution edge and 75 short of the clean one.
 *
 * ⚠ It asserts the OWNERSHIP refusal, and that is the point of the row rather
 * than a detail of it. An earlier version of this change also refused the stale
 * id in `execute`, which closed this route before a node ran — and made this row
 * green for a reason that had nothing to do with the primitive. The refusal here
 * has to come from `pickGraphOwnedControl`, or the class is not what is closed.
 *
 * Ten other refusals are already reachable on this path —
 * `INCIDENTAL_RESUME_REFUSALS` — so "it threw" would be green for every one of
 * them.
 */
const RETRY_TURN_INSIDE_WINDOW = 100;

test('refuses the value a stale retry launders into a wrapped node', async () => {
  const raced = await retryStaleInterruptRacedByMicrotaskChain({
    runId: 'run-stale-retry-inside-window',
    turn: RETRY_TURN_INSIDE_WINDOW,
  });

  assert.equal(
    raced.armed,
    true,
    `the chain never reached turn ${RETRY_TURN_INSIDE_WINDOW} during the retry, so nothing was under test — the window has moved and needs re-measuring`,
  );
  assert.equal(
    raced.kind,
    'refused',
    `a retry carrying a laundered graph-owned field must be refused, not resumed to a ${raced.kind} completion`,
  );

  const message = raced.outcome.error.message;
  assert.doesNotMatch(
    message,
    INCIDENTAL_RESUME_REFUSALS,
    `refusing for an unrelated reason is not this defect being fixed: ${message}`,
  );
  assert.doesNotMatch(
    message,
    SUPERSEDED_INTERRUPT_REFUSAL,
    `this route must be closed by the ownership guard, not by a refusal that never lets it run: ${message}`,
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
  assert.equal(
    raced.persistedControl[POLLUTED_FIELD],
    RETRY_EXPECTED_HUMAN_REVIEW,
    'a refused retry must leave the run still under human review',
  );
});

/**
 * The recovery path, and it is here because closing route 1 at the ROUTE would
 * have silently taken it away.
 *
 * A lifecycle node that throws — or a process that dies mid-superstep — leaves
 * a thread with a pending TASK and **zero** pending interrupts. A resume is the
 * only way to advance it: `execute` has no replay that carries no interrupt id,
 * `getState` is read-only, and `kind: 'start'` overwrites the control. An
 * earlier version of this change refused on `tasks.length > 0`, which made
 * every id a caller could send an error and a crashed run unresumable. Nothing
 * asked for that, and nothing would have recorded it.
 *
 * So the row asserts the recovery, and the sibling below asserts that the
 * refusal still fires where it belongs. Neither is safe to have alone.
 */
test('advances a run past a transient node failure when the caller retries the same id', async () => {
  const { nodes, armFailure } = nodesWithTransientFailure();
  const harness = createHarness({ runId: 'run-transient-failure-recovery', nodes });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    armFailure('derive_predictions');
    const failed = await harness.resumeWith(pending.id, { action: 'reject' });
    assert.equal(
      'error' in failed,
      true,
      'the transient failure must reject the first resume, or there is nothing to recover from',
    );

    const stranded = await harness.execution.getState(harness.config);
    assert.ok(
      stranded.tasks.length > 0,
      'the crashed run must still have pending work',
    );
    assert.deepEqual(
      stranded.tasks.flatMap(({ interrupts }) => interrupts.map(({ id }) => id)),
      [],
      'the crashed run must be waiting on no interrupt at all — that is the shape this row is about',
    );

    const recovered = await harness.resumeWith(pending.id, { action: 'reject' });
    assert.equal(
      'error' in recovered,
      false,
      `a retry must advance a run whose node threw, not strand it: ${recovered.error?.message ?? ''}`,
    );
    assert.equal(
      isInterrupted(recovered.value),
      true,
      'the recovered run must reach its next human review rather than completing unreviewed',
    );

    const control = await harness.control();
    assert.equal(
      control[POLLUTED_FIELD],
      RETRY_EXPECTED_HUMAN_REVIEW,
      'recovery must leave the run under human review',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The refusal where it does belong: the thread IS waiting on an interrupt, and
 * the caller named a different one — a decision aimed at a question that has
 * already been replaced.
 *
 * All three decisions, because `add_hypothesis` is the one that reads the
 * snapshot on its own and could refuse for an unrelated reason.
 */
for (const { label, decision } of resumeDecisions) {
  test(`refuses a stale ${label} decision while the run waits on a different interrupt`, async () => {
    const harness = createHarness({ runId: `run-superseded-${label}` });

    try {
      const interrupted = await harness.start();
      const [first] = interrupted[INTERRUPT];

      const reopened = await harness.resume(interrupted, { action: 'reject' });
      assert.equal(
        'error' in reopened,
        false,
        `the reject must reopen the review: ${reopened.error?.message ?? ''}`,
      );
      const [second] = reopened.value[INTERRUPT];
      assert.notEqual(
        second.id,
        first.id,
        'the reopened review must carry a new interrupt id, or nothing here is superseded',
      );

      const outcome = await harness.resumeWith(first.id, decision(1));
      assert.equal(
        'error' in outcome,
        true,
        'a decision aimed at a superseded interrupt must be refused, not replayed into a resolved-looking answer',
      );
      assert.match(
        outcome.error.message,
        SUPERSEDED_INTERRUPT_REFUSAL,
        `the refusal must say the run is waiting on a different interrupt: ${outcome.error.message}`,
      );
      assert.equal(
        outcome.error.message.includes(first.id),
        true,
        'the refusal must name the id the caller sent, so a CLI can tell which decision it was',
      );

      const stillPending = await harness.execution.getState(harness.config);
      assert.equal(
        stillPending.tasks[0].interrupts[0].id,
        second.id,
        'the refusal must leave the newer review exactly where it was',
      );
    } finally {
      harness.cleanup();
    }
  });
}

/**
 * Route 2 — the same primitive, reached with a PENDING id, which is why the
 * stale-id refusal above cannot be what closes it.
 *
 * Deterministic rather than raced: the harness rewrites the control the
 * checkpointer hands back, from a chosen read onward, so the pollution lands
 * between `execute`'s validation and the object `graph.invoke` builds the run
 * from. That is the same two-read gap "reads the checkpoint twice per resume"
 * measures, exercised here on a node that is WRAPPED — so
 * `preserveGraphOwnedControl` sees the polluted control before `reviewConclusion`
 * would, and on `main` re-owns the substituted value rather than refusing it.
 *
 * Measured on `main` (d8bdea1) at each read: read 1 refused by the guard
 * `execute` already had; read 2 **substituted** — the run completed, the control
 * parsed, `humanReview: false` reached disk and the review node never ran; read
 * 3 clean, the pollution arriving after both deserializations.
 */
const POLLUTED_FROM_SECOND_READ = 2;

/** The same own fields the checkpoint carried, minus one the prototype now
 * supplies — the shape a deserializer's plain assignment leaves behind when an
 * inherited setter swallows the write. */
function withInheritedField(control, field, value) {
  const descriptors = Object.getOwnPropertyDescriptors(control);
  delete descriptors[field];
  return Object.create({ [field]: value }, descriptors);
}

/** Lifecycle nodes where `collect_baseline` pauses the run once, off-contract. */
function nodesPausingOffContract() {
  return (trace) =>
    Object.fromEntries(
      lifecycleNodes.map((name) => [
        name,
        async (state) => {
          trace.push(name);
          if (
            name === 'collect_baseline' &&
            trace.filter((entry) => entry === 'collect_baseline').length === 1
          ) {
            interrupt({ kind: 'off-contract-pause' });
          }
          if (name === 'termination_check') return stalledTermination(state);
          if (name === 'propose_conclusion') {
            return { conclusion: proposedConclusion };
          }
          return {};
        },
      ]),
    );
}

async function resumeOffContractPause({ runId, pollutedFromRead }) {
  const harness = createHarness({ runId, nodes: nodesPausingOffContract() });

  try {
    const interrupted = await harness.startRaw();
    assert.equal(
      isInterrupted(interrupted),
      true,
      'a lifecycle node calling interrupt() must pause the run',
    );
    const [pending] = interrupted[INTERRUPT];

    let reads = 0;
    if (pollutedFromRead !== undefined) {
      harness.rewriteEveryPersistedControl((persisted) => {
        reads += 1;
        return reads >= pollutedFromRead
          ? withInheritedField(persisted, POLLUTED_FIELD, false)
          : persisted;
      });
    }

    const outcome = await harness.resumeWith(pending.id, { action: 'confirm' });
    harness.rewriteEveryPersistedControl(undefined);

    const persistedControl = await harness.control();
    const parsed = IncidentStateControlSchema.safeParse(persistedControl);
    const refused = 'error' in outcome;
    const substituted =
      !refused &&
      parsed.success &&
      persistedControl[POLLUTED_FIELD] !== RETRY_EXPECTED_HUMAN_REVIEW;

    return {
      outcome,
      persistedControl,
      trace: [...harness.trace],
      kind: refused
        ? 'refused'
        : substituted
          ? 'substituted'
          : parsed.success
            ? 'clean'
            : 'corrupt',
    };
  } finally {
    harness.cleanup();
  }
}

test('refuses a control the prototype supplies to a wrapped node, on a pending interrupt', async () => {
  const resumed = await resumeOffContractPause({
    runId: 'run-off-contract-pause-polluted',
    pollutedFromRead: POLLUTED_FROM_SECOND_READ,
  });

  assert.equal(
    resumed.kind,
    'refused',
    `a wrapped node must refuse a graph-owned field it does not own, not run on it to a ${resumed.kind} completion`,
  );

  const message = resumed.outcome.error.message;
  assert.doesNotMatch(
    message,
    INCIDENTAL_RESUME_REFUSALS,
    `refusing for an unrelated reason is not this guard: ${message}`,
  );
  assert.doesNotMatch(
    message,
    SUPERSEDED_INTERRUPT_REFUSAL,
    `this id IS the one the run waits on, so the superseded-interrupt refusal must not be what answers here: ${message}`,
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
  assert.equal(
    resumed.persistedControl[POLLUTED_FIELD],
    RETRY_EXPECTED_HUMAN_REVIEW,
    'a refused resume must leave the run still under human review',
  );
});

/**
 * The control arm for route 2, and it is what stops the guard above from being
 * satisfied by a graph that refuses this route outright.
 *
 * Same off-contract pause, same resume, nothing rewritten: the run must
 * complete, and it must complete having gone THROUGH the wrapped node twice —
 * once before the pause and once on the replay — which is what puts
 * `pickGraphOwnedControl` on the polluted path in the row above.
 */
test('completes a resume of an off-contract pause when nothing is polluted', async () => {
  const resumed = await resumeOffContractPause({
    runId: 'run-off-contract-pause-clean',
  });

  assert.equal(
    'error' in resumed.outcome,
    false,
    `a resume of a node that paused itself must complete: ${resumed.outcome.error?.message ?? ''}`,
  );
  assert.equal(
    resumed.kind,
    'clean',
    'the completed run must leave a parseable control carrying its own humanReview',
  );
  assert.equal(
    resumed.trace.filter((entry) => entry === 'collect_baseline').length,
    2,
    'the replay must re-enter the wrapped node that paused, or the polluted row above tests nothing',
  );
});

/**
 * The half the first version of this guard left open, and the reason the
 * refusal does not ask whether the prototype is still carrying the value.
 *
 * The mechanism is a swallowed WRITE. A setter that takes the deserializer's
 * one assignment and then deletes itself leaves the field **absent, with a
 * pristine prototype** — so a guard conditioned on `field in control` sees
 * nothing and defines the field as an own `undefined`. For `humanReview` that
 * is the value the attacker wants: falsy at the `propose_conclusion` edge, an
 * early return out of `assertInteractiveRunIdentity`, and — because it is now
 * OWN — a shadow that hides anything the prototype could still carry.
 *
 * This row models the state such a gadget leaves rather than the gadget: the
 * restored control simply has no `humanReview`, on an ordinary prototype. That
 * is deterministic, needs no timing, and is the same input the self-erasing
 * setter produces. Found by `security-scanner` on the first version of this
 * change, where it completed the run with the review gate disarmed.
 */
function withoutOwnField(control, field) {
  const descriptors = Object.getOwnPropertyDescriptors(control);
  delete descriptors[field];
  return Object.create(Object.prototype, descriptors);
}

test('refuses a required control field erased before a wrapped node runs on it', async () => {
  const harness = createHarness({
    runId: 'run-field-erased-by-a-swallowed-write',
    nodes: nodesPausingOffContract(),
  });

  try {
    const interrupted = await harness.startRaw();
    const [pending] = interrupted[INTERRUPT];

    let reads = 0;
    harness.rewriteEveryPersistedControl((persisted) => {
      reads += 1;
      return reads >= POLLUTED_FROM_SECOND_READ
        ? withoutOwnField(persisted, POLLUTED_FIELD)
        : persisted;
    });

    const outcome = await harness.resumeWith(pending.id, { action: 'confirm' });
    harness.rewriteEveryPersistedControl(undefined);

    assert.equal(
      'error' in outcome,
      true,
      'a required graph-owned field that is absent must be refused however it went missing, not defined as an own undefined',
    );
    assert.doesNotMatch(
      outcome.error.message,
      INCIDENTAL_RESUME_REFUSALS,
      `refusing for an unrelated reason is not this guard: ${outcome.error.message}`,
    );

    const named = OWN_CONTROL_REFUSAL.exec(outcome.error.message);
    assert.notEqual(
      named,
      null,
      `the refusal must be the graph's own words about ownership, not: ${outcome.error.message}`,
    );
    assert.equal(named[1], POLLUTED_FIELD, `the refusal named ${named?.[1]}`);

    const persistedControl = await harness.control();
    assert.equal(
      persistedControl[POLLUTED_FIELD],
      RETRY_EXPECTED_HUMAN_REVIEW,
      'the refused run must still be under human review',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The same damage on the route where NO wrapped node runs, which is why the
 * primitive cannot be the only thing that refuses it.
 *
 * A `confirm` reaches END from `reviewConclusion` without entering a single
 * wrapped node, so `pickGraphOwnedControl` never sees the control. Measured
 * before `assertRestoredControlFieldsPresent` existed: the run COMPLETED and wrote a
 * control with no `humanReview` at all — `IncidentStateControlSchema` rejects
 * it, so the damage is at least visible, but the run finished on it and the
 * checkpoint is unusable.
 *
 * `assertOwnControlFields` cannot be the check that catches this: it asks only
 * that a PRESENT field be own, which is the right question for a caller's
 * `kind: 'start'` state, where a missing field must produce the schema's parse
 * error rather than an ownership one. A restored control has been parsed once
 * already, so a required field missing from it is damage rather than an
 * omission.
 *
 * All three decisions, because they reach the check through different routes —
 * `confirm` through `reviewConclusion` alone, the other two with wrapped nodes
 * behind them.
 */
for (const { label, decision } of resumeDecisions) {
  test(`refuses a ${label} whose restored control lost a required field, leaving the checkpoint intact`, async () => {
    const harness = createHarness({ runId: `run-erased-field-${label}` });

    try {
      const interrupted = await harness.start();
      const [pending] = interrupted[INTERRUPT];

      let reads = 0;
      harness.rewriteEveryPersistedControl((persisted) => {
        reads += 1;
        return reads >= POLLUTED_FROM_SECOND_READ
          ? withoutOwnField(persisted, POLLUTED_FIELD)
          : persisted;
      });

      const outcome = await harness.resumeWith(pending.id, decision(1));
      harness.rewriteEveryPersistedControl(undefined);

      assert.equal(
        'error' in outcome,
        true,
        'a restored control missing a required field must be refused, not run on',
      );
      assert.doesNotMatch(
        outcome.error.message,
        INCIDENTAL_RESUME_REFUSALS,
        `refusing for an unrelated reason is not this guard: ${outcome.error.message}`,
      );

      const named = OWN_CONTROL_REFUSAL.exec(outcome.error.message);
      assert.notEqual(
        named,
        null,
        `the refusal must be the graph's own words about ownership, not: ${outcome.error.message}`,
      );
      assert.equal(named[1], POLLUTED_FIELD, `the refusal named ${named?.[1]}`);

      // The property AIC-89 established and this route would otherwise lose:
      // a refusal must not leave behind a control the domain schema rejects.
      const persistedControl = await harness.control();
      assert.equal(
        IncidentStateControlSchema.safeParse(persistedControl).success,
        true,
        'the refusal must land before anything writes a control the schema rejects',
      );
      assert.equal(
        persistedControl[POLLUTED_FIELD],
        RETRY_EXPECTED_HUMAN_REVIEW,
        'the refused run must still be under human review',
      );
    } finally {
      harness.cleanup();
    }
  });
}

/**
 * What `reviewConclusion`'s own `assertOwnControlFields` still covers alone, and
 * the row that keeps it from being deleted as redundant.
 *
 * `assertRestoredControlFieldsPresent` runs right after it and refuses every
 * REQUIRED field it would have caught, so this row is the ONLY row that reddens
 * when the ownership call is removed. Two guards where one appears to do the
 * work is exactly how the surviving one gets deleted next year, so the residual
 * is written down and pinned rather than assumed.
 *
 * ⚠ Deliberately no suite total here. Three rounds running, this file carried a
 * pass count that a later commit's new rows made wrong, each time in a sentence
 * whose POINT was still true — the shape of the mutation and the name of the
 * row that answers it are what a reader needs, and they do not go stale when
 * the file grows.
 *
 * The residual is an OPTIONAL graph-owned field on the `confirm` route:
 * `stopKind` is skipped by the presence check because absence is legitimate for
 * it, and a `confirm` reaches END without entering a wrapped node, so
 * `pickGraphOwnedControl` never sees it either. Measured with the ownership
 * call removed: the run COMPLETES and the terminal stop kind is silently
 * dropped from disk — the optional field's damage is quiet, which is what AIC-89
 * recorded about `stopKind` and why it needs a row rather than an argument.
 */
test('refuses an inherited stopKind on the route where no wrapped node runs', async () => {
  const harness = createHarness({ runId: 'run-inherited-stop-kind-on-confirm' });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    let reads = 0;
    harness.rewriteEveryPersistedControl((persisted) => {
      reads += 1;
      return reads >= POLLUTED_FROM_SECOND_READ
        ? withInheritedField(persisted, 'stopKind', 'budget-exhausted')
        : persisted;
    });

    const outcome = await harness.resumeWith(pending.id, { action: 'confirm' });
    harness.rewriteEveryPersistedControl(undefined);

    assert.equal(
      'error' in outcome,
      true,
      'an inherited stopKind must be refused, not completed with the terminal stop kind silently dropped',
    );
    assert.doesNotMatch(
      outcome.error.message,
      INCIDENTAL_RESUME_REFUSALS,
      `refusing for an unrelated reason is not this guard: ${outcome.error.message}`,
    );
    const named = OWN_CONTROL_REFUSAL.exec(outcome.error.message);
    assert.notEqual(
      named,
      null,
      `the refusal must be the graph's own words about ownership, not: ${outcome.error.message}`,
    );
    assert.equal(named[1], 'stopKind', `the refusal named ${named?.[1]}`);

    const persistedControl = await harness.control();
    assert.equal(
      Object.hasOwn(persistedControl, 'stopKind'),
      true,
      'the refusal must leave the run its own terminal stop kind',
    );
    assert.equal(
      persistedControl.stopKind,
      'stalled',
      'the stop kind on disk must be the one the graph decided, not the prototype\'s',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * ⚠⚠ THE LIMIT OF EVERY OWNERSHIP CHECK IN THIS FILE, and it is a row rather
 * than a sentence because this repository's rule is that a claim about what a
 * mechanism does — or cannot do — is either generated or a pointer.
 *
 * All of these guards ask one question: *is this field the run's own data
 * property?* A prototype gadget can make the answer honestly YES and still
 * choose the value, by defining it ON THE TARGET from its setter:
 *
 * ```js
 * Object.defineProperty(Object.prototype, 'humanReview', {
 *   configurable: true,
 *   get() { return false; },
 *   set() { Object.defineProperty(this, 'humanReview', { value: false, ... }); },
 * });
 * ```
 *
 * `JsonPlusSerializer._reviver` assigns the checkpointed `true`; the inherited
 * setter takes the assignment and defines `false` as the target's own data
 * property. From that point the control is indistinguishable from an honest
 * one, and `pickGraphOwnedControl` reading a descriptor sees exactly what an
 * uncorrupted run would.
 *
 * So this row asserts the CURRENT, UNSAFE outcome on purpose. It is not an
 * endorsement and it is not a test of a feature: it is the limit, pinned, so
 * that the sentences elsewhere claiming the class is closed at the primitive
 * stay honest, and so that whoever closes it is told by a red row to update
 * them. Measured identically on `main` (d8bdea1) and here, so it is
 * pre-existing rather than introduced by AIC-92.
 *
 * The remedy is not another ownership check — there is nothing left to detect.
 * `JSON.parse` uses define semantics and is immune to this gadget where plain
 * assignment is not, which is measured by the first half of this row. That
 * makes a define-semantics serde the only remedy for this shape, and it is
 * filed rather than folded in here, because it lives in `packages/persistence`
 * and is a different layer's responsibility: AIC-93.
 */
test('documents the limit: an inherited setter that writes an own property is not refused', async () => {
  // First, the semantics the remedy would rest on, measured rather than
  // asserted from the specification.
  try {
    Object.defineProperty(Object.prototype, POLLUTED_FIELD, {
      configurable: true,
      get() {
        return false;
      },
      set() {
        Object.defineProperty(this, POLLUTED_FIELD, {
          value: false,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      },
    });

    const parsed = JSON.parse(`{"${POLLUTED_FIELD}":true}`);
    assert.equal(
      parsed[POLLUTED_FIELD],
      true,
      'JSON.parse must define rather than assign, or the remedy this row names would not work either',
    );

    const assigned = {};
    assigned[POLLUTED_FIELD] = true;
    assert.equal(
      assigned[POLLUTED_FIELD],
      false,
      'plain assignment must be the half that loses the value, or the gadget below is not the one described',
    );
    assert.equal(
      Object.hasOwn(assigned, POLLUTED_FIELD),
      true,
      'the substituted value must be an OWN property, or an ownership check would still catch it',
    );
  } finally {
    delete Object.prototype[POLLUTED_FIELD];
  }

  // Then the end-to-end consequence, against a real checkpointer.
  const harness = createHarness({ runId: 'run-own-writing-setter-limit' });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    let outcome;
    try {
      Object.defineProperty(Object.prototype, POLLUTED_FIELD, {
        configurable: true,
        get() {
          return false;
        },
        set() {
          Object.defineProperty(this, POLLUTED_FIELD, {
            value: false,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      });
      outcome = await harness.resumeWith(pending.id, { action: 'confirm' });
    } finally {
      delete Object.prototype[POLLUTED_FIELD];
    }

    assert.equal(
      'error' in outcome,
      false,
      'if this now refuses, the limit has been closed — update the claims in investigation.ts and the decision record, and close AIC-93',
    );

    const persistedControl = await harness.control();
    assert.equal(
      IncidentStateControlSchema.safeParse(persistedControl).success,
      true,
      'the substituted control parses, which is what makes this outcome invisible on disk',
    );
    assert.equal(
      persistedControl[POLLUTED_FIELD],
      false,
      'if this is no longer the gadget\'s value, the limit has moved — re-measure before editing the claims',
    );
    assert.equal(
      Object.hasOwn(persistedControl, POLLUTED_FIELD),
      true,
      'the substituted field is genuinely own, which is why no ownership check can see it',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The own-ACCESSOR half of `assertRestoredControlFieldsPresent`, which is the
 * half `assertOwnControlFields` cannot reach.
 *
 * `Object.hasOwn` is true for an own accessor, so the ownership check passes one
 * — its message says "accessor-supplied", which overstates it. The presence
 * check asks for a DESCRIPTOR CARRYING A VALUE, and that is what refuses this.
 *
 * The distinction is not academic under this ticket's own threat model: the
 * gadget in the limit row further up defines a property on its target from a
 * setter, and a gadget that defines an ACCESSOR there instead produces exactly
 * this shape — an own property whose value is computed on every read.
 *
 * Written because the claim was in the docstring with nothing behind it:
 * weakening the check to `Object.hasOwn(control, field)` left the whole suite
 * green.
 */
test('refuses a restored control field that is an own accessor rather than a value', async () => {
  const harness = createHarness({ runId: 'run-own-accessor-field' });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    let reads = 0;
    harness.rewriteEveryPersistedControl((persisted) => {
      reads += 1;
      if (reads < POLLUTED_FROM_SECOND_READ) return persisted;
      const descriptors = Object.getOwnPropertyDescriptors(persisted);
      delete descriptors[POLLUTED_FIELD];
      const rebuilt = Object.create(Object.prototype, descriptors);
      Object.defineProperty(rebuilt, POLLUTED_FIELD, {
        configurable: true,
        enumerable: true,
        get() {
          return false;
        },
      });
      return rebuilt;
    });

    const outcome = await harness.resumeWith(pending.id, { action: 'confirm' });
    harness.rewriteEveryPersistedControl(undefined);

    assert.equal(
      'error' in outcome,
      true,
      'an own accessor is not a value of the run\'s own, and must be refused rather than read',
    );
    assert.doesNotMatch(
      outcome.error.message,
      INCIDENTAL_RESUME_REFUSALS,
      `refusing for an unrelated reason is not this guard: ${outcome.error.message}`,
    );

    const named = OWN_CONTROL_REFUSAL.exec(outcome.error.message);
    assert.notEqual(
      named,
      null,
      `the refusal must be the graph's own words about ownership, not: ${outcome.error.message}`,
    );
    assert.equal(named[1], POLLUTED_FIELD, `the refusal named ${named?.[1]}`);

    const persistedControl = await harness.control();
    assert.equal(
      persistedControl[POLLUTED_FIELD],
      RETRY_EXPECTED_HUMAN_REVIEW,
      'the refused run must still be under human review',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * The same own-accessor shape on the route where `reviewConclusion` never runs,
 * which is what pins `pickGraphOwnedControl`'s OWN copy of the refusal.
 *
 * The row above reaches the presence check; this one reaches the primitive,
 * because an off-contract pause replays a WRAPPED node first. Without it,
 * deleting the descriptor test inside `pickGraphOwnedControl` leaves the whole
 * suite green — measured — and a guard nothing reddens is a guess.
 */
test('refuses an own accessor at the wrapped node, where no later check runs', async () => {
  const harness = createHarness({
    runId: 'run-own-accessor-at-wrapped-node',
    nodes: nodesPausingOffContract(),
  });

  try {
    const interrupted = await harness.startRaw();
    const [pending] = interrupted[INTERRUPT];

    let reads = 0;
    harness.rewriteEveryPersistedControl((persisted) => {
      reads += 1;
      if (reads < POLLUTED_FROM_SECOND_READ) return persisted;
      const descriptors = Object.getOwnPropertyDescriptors(persisted);
      delete descriptors[POLLUTED_FIELD];
      const rebuilt = Object.create(Object.prototype, descriptors);
      Object.defineProperty(rebuilt, POLLUTED_FIELD, {
        configurable: true,
        enumerable: true,
        get() {
          return false;
        },
      });
      return rebuilt;
    });

    const outcome = await harness.resumeWith(pending.id, { action: 'confirm' });
    harness.rewriteEveryPersistedControl(undefined);

    assert.equal(
      'error' in outcome,
      true,
      'a wrapped node must refuse an own accessor rather than invoke it to decide what the graph owns',
    );
    assert.doesNotMatch(
      outcome.error.message,
      INCIDENTAL_RESUME_REFUSALS,
      `refusing for an unrelated reason is not this guard: ${outcome.error.message}`,
    );

    const named = OWN_CONTROL_REFUSAL.exec(outcome.error.message);
    assert.notEqual(
      named,
      null,
      `the refusal must be the graph's own words about ownership, not: ${outcome.error.message}`,
    );
    assert.equal(named[1], POLLUTED_FIELD, `the refusal named ${named?.[1]}`);

    const persistedControl = await harness.control();
    assert.equal(
      persistedControl[POLLUTED_FIELD],
      RETRY_EXPECTED_HUMAN_REVIEW,
      'the refused run must still be under human review',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * What `execute`'s own ownership check covers alone: pollution that is present
 * for the FIRST checkpoint read and gone by the second.
 *
 * The two reads are the whole reason AIC-90 exists — `execute` validates what
 * `graph.getState` deserialized, and `graph.invoke` deserializes again. Every
 * other row in this file arms the SECOND read, because that is the object the
 * run is built from and the one the later guards see. This row arms only the
 * first: by the time `graph.invoke` reads, the checkpoint is clean, so nothing
 * downstream has anything to refuse and the run would complete on a control
 * that was fabricated when it was inspected.
 *
 * Without this row that call reddens nothing at all — every other guard sees
 * only the second read — which by this repository's own rule makes it a guess
 * rather than a guard.
 */
test('refuses pollution that is gone by the second checkpoint read', async () => {
  const harness = createHarness({ runId: 'run-polluted-first-read-only' });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    let reads = 0;
    harness.rewriteEveryPersistedControl((persisted) => {
      reads += 1;
      return reads === 1
        ? withInheritedField(persisted, POLLUTED_FIELD, false)
        : persisted;
    });

    const outcome = await harness.resumeWith(pending.id, { action: 'confirm' });
    harness.rewriteEveryPersistedControl(undefined);

    assert.equal(
      'error' in outcome,
      true,
      'a control that was not the run\'s own when it was inspected must be refused there, even though the next read is clean',
    );
    assert.doesNotMatch(
      outcome.error.message,
      INCIDENTAL_RESUME_REFUSALS,
      `refusing for an unrelated reason is not this guard: ${outcome.error.message}`,
    );

    const named = OWN_CONTROL_REFUSAL.exec(outcome.error.message);
    assert.notEqual(
      named,
      null,
      `the refusal must be the graph's own words about ownership, not: ${outcome.error.message}`,
    );
    assert.equal(named[1], POLLUTED_FIELD, `the refusal named ${named?.[1]}`);
  } finally {
    harness.cleanup();
  }
});

/**
 * The same limit on the route AIC-92 deliberately REOPENED, which is the sentence
 * in `execute` that concedes what allowing that route costs.
 *
 * The row above arms the gadget on a plain `confirm`. This one arms it on the
 * crashed-run retry — pause, reject, a node throws, retry the same id against a
 * thread waiting on zero interrupts — because that is the route the narrowed
 * refusal lets through, and a comment that says "this route IS a path to that
 * limit" has to be a pointer rather than a claim.
 *
 * The cost is real and the trade is still the right one: the row above shows
 * the same gadget reaching a plain `confirm`, which no form of that refusal
 * ever covered. Refusing here would remove one path to a limit that stays open
 * regardless, and would cost every crashed run its only way forward — pinned by
 * › "advances a run past a transient node failure when the caller retries the
 * same id". Both halves are rows, so neither can drift into the other's place.
 */
test('documents the limit on the crashed-run retry route the refusal lets through', async () => {
  assert.equal(
    POLLUTED_FIELD in {},
    false,
    `the prototype is already carrying ${POLLUTED_FIELD} before this run started: an earlier row leaked it`,
  );

  const { nodes, armFailure } = nodesWithTransientFailure();
  const harness = createHarness({ runId: 'run-gadget-on-crash-retry', nodes });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    armFailure('derive_predictions');
    const failed = await harness.resumeWith(pending.id, { action: 'reject' });
    assert.equal(
      'error' in failed,
      true,
      'the transient failure must reject the first resume, or this is not the reopened route',
    );

    const stranded = await harness.execution.getState(harness.config);
    assert.deepEqual(
      stranded.tasks.flatMap(({ interrupts }) => interrupts.map(({ id }) => id)),
      [],
      'the thread must be waiting on no interrupt, or the narrowed refusal would have answered instead',
    );

    let outcome;
    try {
      Object.defineProperty(Object.prototype, POLLUTED_FIELD, {
        configurable: true,
        get() {
          return false;
        },
        set() {
          Object.defineProperty(this, POLLUTED_FIELD, {
            value: false,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        },
      });
      outcome = await harness.resumeWith(pending.id, { action: 'reject' });
    } finally {
      delete Object.prototype[POLLUTED_FIELD];
    }

    assert.equal(
      'error' in outcome,
      false,
      'if this now refuses, the limit has been closed on this route — update the claims in investigation.ts and the decision record, and close AIC-93',
    );

    const persistedControl = await harness.control();
    assert.equal(
      persistedControl[POLLUTED_FIELD],
      false,
      'if this is no longer the gadget\'s value, the limit has moved — re-measure before editing the claims',
    );
    assert.equal(
      IncidentStateControlSchema.safeParse(persistedControl).success,
      true,
      'the substituted control parses, which is what makes this outcome invisible on disk',
    );
  } finally {
    harness.cleanup();
  }
});

/**
 * AIC-102 — the human's DECISION, not a control field: a prototype gadget on
 * `action` turns a `reject` into a `confirm`.
 *
 * Every guard above this point protects the control the graph owns. This
 * protects the one value the graph does not own and must not second-guess — what
 * the human said. Substituted, the run resolves at END, `review_conclusion`
 * never runs again, zero nodes replay, and the checkpoint records a completed,
 * reviewed-looking run.
 *
 * ⚠ THE PRECONDITION IS WARMTH, and it is armed here explicitly rather than
 * inherited from whatever ran before in this file. `ConclusionReviewDecisionSchema`
 * is a discriminated union whose `propValues` lookup zod builds LAZILY and then
 * memoises. Built while the gadget is armed, `propValues['action']` reads
 * `'confirm'` through the getter — not nullish — so the `Set` is never created
 * and `.add` throws. That COLD failure looks like a defence and is not one: it
 * is zod crashing on the pollution, and it evaporates the moment the process has
 * parsed one decision. A row that relied on test ordering to supply the warmth
 * would pass or fail by accident.
 *
 * Both gadget shapes are covered because an ownership check separates them and
 * is not sufficient for both: the read accessor leaves `action` NOT own, while
 * the own-writing setter leaves it own, with the attacker's value. What
 * discriminates both is the caller's own raw `action` — an object literal uses
 * `CreateDataProperty`, so `{ action: 'reject' }` keeps its own `'reject'` under
 * either gadget.
 */
const DECISION_ACTION_REFUSAL = /decision must carry its own action/;

/** One ordinary decision parse, so the union's lazy lookup is built with a
 * clean prototype — the state a long-lived process is in after its first
 * review, and the state this row is about. */
function warmDecisionSchema() {
  const parsed = ConclusionReviewDecisionSchema.safeParse({ action: 'confirm' });
  assert.equal(
    parsed.success,
    true,
    'the warm-up parse must succeed, or the rows below are measuring the cold path instead',
  );
}

function armDecisionGadget(shape) {
  Object.defineProperty(Object.prototype, 'action', {
    configurable: true,
    get() {
      return 'confirm';
    },
    set:
      shape === 'own-writing'
        ? function () {
            Object.defineProperty(this, 'action', {
              value: 'confirm',
              writable: true,
              enumerable: true,
              configurable: true,
            });
          }
        : () => {},
  });
}

for (const shape of ['read-accessor', 'own-writing']) {
  test(`refuses a human reject that a ${shape} gadget rewrites into a confirm`, async () => {
    assert.equal(
      'action' in {},
      false,
      'the prototype is already carrying action before this run started: an earlier row leaked it',
    );
    warmDecisionSchema();

    const harness = createHarness({ runId: `run-decision-gadget-${shape}` });

    try {
      const interrupted = await harness.start();
      const [pending] = interrupted[INTERRUPT];
      const traceBefore = harness.trace.length;

      let outcome;
      try {
        armDecisionGadget(shape);
        outcome = await harness.resumeWith(pending.id, { action: 'reject' });
      } finally {
        delete Object.prototype.action;
      }

      assert.equal(
        'error' in outcome,
        true,
        `a human reject rewritten into a confirm must be refused, not executed: the run ${
          'error' in outcome ? '' : 'completed'
        }`,
      );
      assert.match(
        outcome.error.message,
        DECISION_ACTION_REFUSAL,
        `the refusal must name the decision's own action: ${outcome.error.message}`,
      );

      assert.equal(
        harness.trace.length,
        traceBefore,
        'a refused decision must not advance the run by a single node',
      );

      const persistedControl = await harness.control();
      assert.equal(
        persistedControl.resumeCount,
        0,
        'a refused decision is not a resume the human spent',
      );
      assert.equal(
        persistedControl[POLLUTED_FIELD],
        RETRY_EXPECTED_HUMAN_REVIEW,
        'the run must still be under human review after the refusal',
      );

      const stillPending = await harness.execution.getState(harness.config);
      assert.equal(
        stillPending.tasks[0]?.interrupts[0]?.id,
        pending.id,
        'the review the human was answering must still be pending',
      );
    } finally {
      harness.cleanup();
    }
  });
}

/**
 * The window only `reviewConclusion`'s parse can see, and the reason the
 * boundary check is not enough on its own.
 *
 * `parseInvestigationExecutionInput` runs SYNCHRONOUSLY, at the top of
 * `execute`, before the first await. A gadget armed one microtask later is
 * therefore invisible to it — the caller's object was clean when the boundary
 * read it — and the substitution lands on the second parse, of the value
 * `interrupt()` hands back inside the node. That is the same two-read shape
 * AIC-90 found for the control, on the decision.
 *
 * Measured with the node-side check removed: every turn from 1 to 10, on both
 * gadget shapes, the human's `reject` is EXECUTED AS A CONFIRM — the run
 * resolves, `resumeCount` reaches 1, and nothing records it. Turn 1 is enough
 * and is deterministic: the boundary is already past by the first microtask, so
 * there is no window to search for.
 */
for (const shape of ['read-accessor', 'own-writing']) {
  test(`refuses a ${shape} gadget armed after the boundary has already read the decision`, async () => {
    assert.equal(
      'action' in {},
      false,
      'the prototype is already carrying action before this run started: an earlier row leaked it',
    );
    warmDecisionSchema();

    const harness = createHarness({ runId: `run-decision-late-${shape}` });

    try {
      const interrupted = await harness.start();
      const [pending] = interrupted[INTERRUPT];
      const traceBefore = harness.trace.length;

      let outcome;
      let chain;
      try {
        chain = scheduleMicrotaskChain({
          turns: 1,
          onTurn: () => armDecisionGadget(shape),
        });
        outcome = await harness.resumeWith(pending.id, { action: 'reject' });
      } finally {
        chain.cancel();
        delete Object.prototype.action;
      }

      assert.equal(
        chain.fired,
        true,
        'the chain never armed during the resume, so the boundary may simply have caught it — this row would then prove nothing',
      );
      assert.equal(
        'error' in outcome,
        true,
        'a decision substituted after the boundary read it must still be refused, at the node',
      );
      assert.match(
        outcome.error.message,
        DECISION_ACTION_REFUSAL,
        `the refusal must name the decision's own action: ${outcome.error.message}`,
      );
      assert.equal(
        harness.trace.length,
        traceBefore,
        'a refused decision must not advance the run by a single node',
      );

      const persistedControl = await harness.control();
      assert.equal(
        persistedControl.resumeCount,
        0,
        'a refused decision is not a resume the human spent',
      );
    } finally {
      harness.cleanup();
    }
  });
}

/**
 * The control arm: the same warm process, the same decision, no gadget. It
 * separates "the guard refuses a rewritten decision" from "the guard refuses
 * `reject`", which a comparison written the wrong way round would do.
 */
test('executes an ordinary reject in the same warm process', async () => {
  warmDecisionSchema();
  const harness = createHarness({ runId: 'run-decision-ordinary-reject' });

  try {
    const interrupted = await harness.start();
    const [pending] = interrupted[INTERRUPT];

    const outcome = await harness.resumeWith(pending.id, { action: 'reject' });
    assert.equal(
      'error' in outcome,
      false,
      `an ordinary reject must be executed: ${outcome.error?.message ?? ''}`,
    );
    assert.equal(
      isInterrupted(outcome.value),
      true,
      'a reject sends the run back for another conclusion, so it must pause again',
    );

    const control = await harness.control();
    assert.equal(control.resumeCount, 1, 'the human spent one resume');
  } finally {
    harness.cleanup();
  }
});

/**
 * The absent-field branch of the same guard, which is the one that must NOT
 * refuse.
 *
 * `stopKind` is graph-owned and legitimately absent on a run that has not
 * stopped, so a guard deciding on "not an own property" without separating
 * ABSENT from INHERITED would refuse every healthy run at its first wrapped
 * node. The whole suite would go red on that, but not by name — this row says
 * which branch broke, and proves the field really was absent where the guard
 * read it rather than inferring it from a green run.
 */
test('accepts a graph-owned field that is absent rather than inherited', async () => {
  const seen = [];
  const harness = createHarness({
    runId: 'run-absent-stop-kind',
    nodes: (trace) =>
      Object.fromEntries(
        lifecycleNodes.map((name) => [
          name,
          async (state) => {
            trace.push(name);
            seen.push({
              name,
              own: Object.hasOwn(state.control, 'stopKind'),
              reachable: 'stopKind' in state.control,
            });
            if (name === 'termination_check') return stalledTermination(state);
            if (name === 'propose_conclusion') {
              return { conclusion: proposedConclusion };
            }
            return {};
          },
        ]),
      ),
  });

  try {
    const interrupted = await harness.start();

    const before = seen[0];
    assert.equal(
      before?.name,
      'normalize_incident',
      'the first wrapped node must be the one this row inspects',
    );
    assert.equal(
      before.reachable,
      false,
      'the first node must see no stopKind at all, or this row is not testing the absent branch',
    );

    const resumed = await harness.resume(interrupted, { action: 'confirm' });
    assert.equal(
      'error' in resumed,
      false,
      `an absent graph-owned field must not be refused as inherited: ${resumed.error?.message ?? ''}`,
    );
  } finally {
    harness.cleanup();
  }
});
