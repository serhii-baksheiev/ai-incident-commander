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
 * Limit two, and this one is a gap rather than a guarantee — pinned so it is a
 * known gap rather than a surprise.
 *
 * `control` present but MALFORMED — `null` — is not caught: the guard tests for
 * `undefined`, and `null !== undefined`. It reaches `assertInteractiveRunIdentity`
 * and raises the same raw TypeError this ticket removed for the absent case.
 * Unchanged from before the guard existed. If someone widens the guard to catch
 * it, this row goes red and they can delete it deliberately.
 */
test('leaves a malformed control to the identity check, unrefused here', async () => {
  const harness = createHarness({ runId: 'run-checkpoint-with-null-control' });

  try {
    const interrupted = await harness.start();
    harness.rewriteEveryPersistedControl(() => null);

    const outcome = await harness.resume(interrupted, { action: 'confirm' });

    assert.equal('error' in outcome, true);
    assert.match(
      outcome.error.message,
      /Cannot read properties of null/,
      'a malformed control is a gap in this guard, and the gap is pinned rather than described',
    );
    assert.doesNotMatch(
      outcome.error.message,
      namesTheMissingRun,
      'the guard must not be claiming to have handled a case it did not see',
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
