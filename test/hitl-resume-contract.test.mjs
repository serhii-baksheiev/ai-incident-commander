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
