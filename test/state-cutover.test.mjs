/**
 * AIC-96 slice 2: the v0.2 -> v0.3 persisted-state cutover matrix.
 *
 * `IncidentSchema` moves from a bare `{ id }` to a required `primaryScope`
 * (`packages/domain/src/contracts.ts`), which bumps
 * `INCIDENT_STATE_SCHEMA_VERSION` from 3 to 4
 * (`packages/domain/src/status-rules.ts`). This file is the resume-side half
 * of that cutover: every family of persisted state this repository writes,
 * checked against what a resume on the CURRENT graph does with a checkpoint
 * an OLDER one wrote.
 *
 * The technique is `test/hitl-resume-contract.test.mjs`'s `createHarness`:
 * wrap the checkpointer's `getTuple` so a resume reads persisted state the
 * current code never wrote — the only way to exercise a resume against a
 * shape only an old writer produced. It is generalised here to rewrite the
 * whole `channel_values` object rather than only `control`, because this
 * cutover is about the `incident` channel losing a field, not only about
 * `control` gaining one.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { INCIDENT_STATE_SCHEMA_VERSION, STATUS_RULES_VERSION } from '@aic/domain';
import * as graphPackage from '@aic/graph';
import { createSqliteCheckpointer } from '@aic/persistence';
import { INTERRUPT, isInterrupted } from '@langchain/langgraph';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

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

const proposedConclusion = { kind: 'inconclusive', causes: [] };

const stalledTermination = async () => ({ route: 'terminal', stopKind: 'stalled' });

function reviewedRunNodes(trace, terminationCheck) {
  return Object.fromEntries(
    lifecycleNodes.map((name) => [
      name,
      async (state) => {
        trace.push(name);
        if (name === 'termination_check') return terminationCheck(state);
        if (name === 'challenge_hypothesis') {
          throw new Error('challenge must not run in this cutover fixture');
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
    incident: scopedIncident('incident-state-cutover'),
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
 * Like `hitl-resume-contract.test.mjs`'s `createHarness`, generalised to
 * rewrite any persisted CHANNEL rather than only `control`: these rows need
 * to remove `incident.primaryScope`, a field on a different channel.
 */
function createHarness({ runId, terminationCheck = stalledTermination, control = {}, nodes }) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-state-cutover-'));
  const checkpointer = createSqliteCheckpointer(join(temporaryRoot, 'checkpoints.sqlite'));
  const readTuple = checkpointer.getTuple.bind(checkpointer);
  let rewriteChannels;
  checkpointer.getTuple = async (config) => {
    const tuple = await readTuple(config);
    const channels = tuple?.checkpoint?.channel_values;
    if (rewriteChannels !== undefined && channels !== undefined) {
      tuple.checkpoint.channel_values = rewriteChannels(channels);
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
    rewritePersistedChannels(rewrite) {
      rewriteChannels = rewrite;
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
        .execute({ kind: 'resume', interruptId: current.id, decision }, config)
        .then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
    },
    cleanup() {
      checkpointer.db.close();
      rmSync(temporaryRoot, { recursive: true, force: true });
    },
  };
}

/**
 * What a persisted checkpoint looked like before `primaryScope` existed: the
 * control stamped at `version`, and an incident carrying only its id.
 */
function withoutPrimaryScopeAtVersion(version) {
  return (channels) => ({
    ...channels,
    incident: { id: channels.incident.id },
    control: { ...channels.control, schemaVersion: version },
  });
}

const namesTheVersionThisGraphReads = new RegExp(
  `this graph reads schema version ${INCIDENT_STATE_SCHEMA_VERSION}\\b`,
);
const namesNoPrimaryScope = /primaryScope|cannot be migrated/i;
const tellsCallerToStartOver = /start a new investigation/i;

/* -------------------------------------------------------------------------- */
/* paused-at-interrupt checkpoints written before primaryScope existed        */
/* -------------------------------------------------------------------------- */

for (const version of [1, 2, 3]) {
  test(`refuses to resume a schema-version-${version} checkpoint paused at the HITL interrupt, because it predates primaryScope`, async () => {
    const harness = createHarness({ runId: `run-cutover-paused-v${version}` });

    try {
      const interrupted = await harness.start();
      const traceBeforeResume = [...harness.trace];
      harness.rewritePersistedChannels(withoutPrimaryScopeAtVersion(version));

      const outcome = await harness.resume(interrupted, { action: 'confirm' });

      assert.equal(
        'error' in outcome,
        true,
        `a schema-version-${version} checkpoint predates primaryScope and must be refused, not resumed to completion`,
      );
      assert.match(
        outcome.error.message,
        new RegExp(`^incompatible persisted state: schema version ${version}\\b`),
        `the refusal must start by naming the persisted version it refused on: ${outcome.error.message}`,
      );
      assert.match(
        outcome.error.message,
        namesTheVersionThisGraphReads,
        `the refusal must name the version this graph reads, taken from the constant: ${outcome.error.message}`,
      );
      assert.match(
        outcome.error.message,
        namesNoPrimaryScope,
        `the refusal must say the persisted incident has no primaryScope or cannot be migrated: ${outcome.error.message}`,
      );
      assert.match(
        outcome.error.message,
        tellsCallerToStartOver,
        `the refusal must tell the caller to start a new investigation: ${outcome.error.message}`,
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

/* -------------------------------------------------------------------------- */
/* a FINISHED run whose checkpoint predates primaryScope                     */
/* -------------------------------------------------------------------------- */

/**
 * `investigation.ts`'s resume entry point reads `getState` only to check for a
 * pending interrupt; a FINISHED run has none, so it never reaches
 * `assertPersistedStateVersion` at all and the resume resolves as a no-op —
 * see `investigation.ts` around the `readOwnControl` check and its neighbour
 * comment on the FINISHED-run case. That gap is what this row is against: a
 * finished v3 checkpoint that predates `primaryScope` must not be handed back
 * silently.
 */
test('refuses a resume of a FINISHED v3 checkpoint that predates primaryScope, rather than treating it as a no-op', async () => {
  const harness = createHarness({ runId: 'run-cutover-finished-v3' });

  try {
    const interrupted = await harness.start();
    const confirmed = await harness.resume(interrupted, { action: 'confirm' });
    assert.equal(
      'error' in confirmed,
      false,
      `the first confirm must complete the run, or this row proves nothing: ${confirmed.error?.message ?? ''}`,
    );

    harness.rewritePersistedChannels(withoutPrimaryScopeAtVersion(3));

    const [pending] = interrupted[INTERRUPT];
    const again = await harness.execution
      .execute(
        { kind: 'resume', interruptId: pending.id, decision: { action: 'confirm' } },
        harness.config,
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );

    assert.equal(
      'error' in again,
      true,
      'a FINISHED run whose checkpoint predates primaryScope must be refused, not resolved as a silent no-op',
    );
    assert.match(
      again.error.message,
      /^incompatible persisted state: schema version 3\b/,
      `the refusal on a finished run must still name the persisted version it refused on: ${again.error?.message}`,
    );
  } finally {
    harness.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* a checkpoint persisted under an older status-rules version (AIC-119 s1)    */
/* -------------------------------------------------------------------------- */

/**
 * `assertPersistedStateVersion` checks `schemaVersion` and then
 * `statusRulesVersion` (`packages/graph/src/investigation.ts`). No other row
 * exercises the second half of that guard — this row does, independently of
 * the `primaryScope` cutover above: only `control.statusRulesVersion` is
 * rewritten, so a failure here can only be about the status-rules branch.
 */
function withStaleStatusRulesVersion(version) {
  return (channels) => ({
    ...channels,
    control: { ...channels.control, statusRulesVersion: version },
  });
}

const namesTheStatusRulesVersionThisGraphReads = new RegExp(
  `this graph reads status-rules version ${STATUS_RULES_VERSION}\\b`,
);

test('refuses to resume a checkpoint persisted under status-rules version v0.1, naming the status-rules version', async () => {
  const harness = createHarness({ runId: 'run-cutover-stale-status-rules-v0.1' });

  try {
    const interrupted = await harness.start();
    const traceBeforeResume = [...harness.trace];
    harness.rewritePersistedChannels(withStaleStatusRulesVersion('v0.1'));

    const outcome = await harness.resume(interrupted, { action: 'confirm' });

    assert.equal(
      'error' in outcome,
      true,
      'a checkpoint persisted under status-rules version v0.1 must be refused, not resumed to completion',
    );
    assert.match(
      outcome.error.message,
      /^incompatible persisted state: status-rules version v0\.1\b/,
      `the refusal must start by naming the persisted status-rules version it refused on: ${outcome.error.message}`,
    );
    assert.match(
      outcome.error.message,
      namesTheStatusRulesVersionThisGraphReads,
      `the refusal must name the status-rules version this graph reads, taken from the constant: ${outcome.error.message}`,
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

/* -------------------------------------------------------------------------- */
/* the control row: a current-version, scoped checkpoint still resumes        */
/* -------------------------------------------------------------------------- */

/**
 * A rejection above only proves the cutover if a checkpoint at the CURRENT
 * version, carrying a scope, still resumes normally. This is a pin, not a red
 * row: it already passes on current code, and it has to keep passing once the
 * schema bumps, or every rejection in this file would prove nothing.
 */
test('resumes normally a current-version checkpoint that carries a primaryScope', async () => {
  const harness = createHarness({ runId: 'run-cutover-current-version-with-scope' });

  try {
    const interrupted = await harness.start();
    const outcome = await harness.resume(interrupted, { action: 'confirm' });
    assert.equal(
      'error' in outcome,
      false,
      `a current-version checkpoint carrying a primaryScope must resume, not be refused: ${outcome.error?.message ?? ''}`,
    );
  } finally {
    harness.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* a start input whose incident has no primaryScope                          */
/* -------------------------------------------------------------------------- */

/**
 * `parseInvestigationExecutionInput` parses `start.state` through
 * `IncidentStateSchema`, which validates `incident` through `IncidentSchema` —
 * so once `primaryScope` is required there, a start input whose incident lacks
 * one fails that parse and falls through to the graph's one opaque input
 * refusal, `invalid investigation execution input`
 * (`packages/graph/src/investigation.ts`).
 */
test('refuses a kind: start input whose incident has no primaryScope', async () => {
  const harness = createHarness({ runId: 'run-cutover-start-no-scope' });

  try {
    const state = initialState('run-cutover-start-no-scope');
    state.incident = { id: state.incident.id };

    await assert.rejects(
      () => harness.execution.execute({ kind: 'start', state }, harness.config),
      (error) => {
        assert.equal(
          error.message,
          'invalid investigation execution input',
          `a start input whose incident lacks primaryScope must be refused as invalid input: ${error.message}`,
        );
        return true;
      },
      'a start input whose incident has no primaryScope must be refused, not accepted as scope-less',
    );
  } finally {
    harness.cleanup();
  }
});

/* -------------------------------------------------------------------------- */
/* the spike runner: lossless identity on a stale stamped version (a pin)    */
/* -------------------------------------------------------------------------- */

/**
 * The spike runner (`createPersistentInvestigationRunner`,
 * `packages/graph/src/index.ts`) carries no `incident` at all — its state is
 * `schemaVersion`, `runId`, `test`, `attempt`, `trials`, `evidence` — and
 * nothing on its resume path validates the stamped `schemaVersion`; it is
 * echoed back verbatim (see the ⚠ comment above `toResult` in that file). So a
 * checkpoint stamped at schema version 3 resumes and returns its trials and
 * evidence unchanged today, and must keep doing so after the cutover: this is
 * a PIN, not a red row, because nothing about `primaryScope` touches a state
 * that has no incident.
 */
test('resumes a spike-runner checkpoint stamped at schema version 3 and returns its trials/evidence unchanged (pin: this state carries no incident)', async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-state-cutover-spike-'));
  const checkpointer = createSqliteCheckpointer(join(temporaryRoot, 'checkpoints.sqlite'));
  const readTuple = checkpointer.getTuple.bind(checkpointer);
  checkpointer.getTuple = async (config) => {
    const tuple = await readTuple(config);
    if (tuple?.checkpoint?.channel_values?.schemaVersion !== undefined) {
      tuple.checkpoint.channel_values = {
        ...tuple.checkpoint.channel_values,
        schemaVersion: 3,
      };
    }
    return tuple;
  };

  try {
    const runId = 'run-cutover-spike-runner';
    const runner = graphPackage.createPersistentInvestigationRunner({
      checkpointer,
      async executeInvestigation() {
        return {
          trial: { status: 'ok', durationMs: 1 },
          evidence: {
            kind: 'log',
            source: 'fixture-tool',
            observedAt: '2026-01-01T00:00:00.000Z',
            statement: 'fixture result',
            rawRef: 'fixture://result',
          },
          payloadFingerprint: 'fixture-payload-v1',
        };
      },
    });

    const started = await runner.start({
      runId,
      test: { id: 'test-cutover', tool: 'fixture-tool', input: { service: 'checkout' } },
    });

    const resumed = await runner.resume({ runId });

    assert.deepEqual(
      resumed.trials,
      started.trials,
      'a checkpoint stamped at a stale schema version must still return its trials unchanged',
    );
    assert.deepEqual(
      resumed.evidence,
      started.evidence,
      'a checkpoint stamped at a stale schema version must still return its evidence unchanged',
    );
  } finally {
    checkpointer.db.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
