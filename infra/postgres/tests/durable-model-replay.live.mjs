/**
 * AIC-56 slice D2's own acceptance row, on real PostgreSQL: the MODEL half of
 * "Kill between result transaction and LangGraph checkpoint -> replay returns
 * the exact committed result and does not call LLM/tool twice", proven
 * against a real `RunStore` claim, a real `RunWriteContext`, and a real lease
 * takeover - the same fenced write-context protocol
 * `infra/postgres/tests/run-write-context.live.mjs` already proves for the
 * `tool.trial` operation, applied here to `model.role` through the reference
 * model roles themselves (`@aic/roles`).
 *
 * Copied in shape and convention from `run-write-context.live.mjs`'s own row
 * 7 ("replay does not call compute again ... in the same context, and again
 * after sweep+reclaim hands the run to a new attempt") and from
 * `durable-tool-replay.live.mjs` - see those files' headers for "why this
 * file is not under `test/`", "it refuses; it never skips", and "independent
 * verification". Not repeated here in full.
 *
 * Unlike `durable-tool-replay.live.mjs`, this row needs no second OS process:
 * a role is a pure function of `{ port, execution }` plus the state it is
 * called with, so a takeover is exercised the same way
 * `run-write-context.live.mjs` already does it - two `RunWriteContext`
 * objects, `contextA` and `contextB`, opened against the SAME store around a
 * force-expired lease and a sweep - never a claim that a real crash was
 * simulated at the process level.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## The independent oracle
 *
 * "Was the model actually called" is read from a counting stub port's own
 * call counter, never from anything the execution port or the role claims.
 * "What got committed" is read with a raw SQL query against `store.pool`,
 * independent of `committed()`'s own read path - the same convention
 * `run-write-context.live.mjs` uses throughout.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as persistence from '@aic/persistence';
import * as roles from '@aic/roles';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place AIC-56's
model.role replay acceptance row is measured against a real PostgreSQL and a
real lease takeover, so a skip would report it as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every table this row touches truncated, and the pool closed at the end of
 * the row - copied from `run-write-context.live.mjs`'s own `freshStore`.
 */
async function freshStore(t, options = DEFAULT_OPTIONS) {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const store = await persistence.createRunStore(connectionString, options);
  t.after(async () => {
    await store.close();
  });
  await store.pool.query(
    'truncate table aic_app.runs, aic_app.node_results, aic_app.run_events, aic_app.run_event_counters, aic_app.run_trials, aic_app.run_evidence, aic_app.fence_rejections',
  );
  return store;
}

/** Creates one queued run and claims it, asserting the claim actually landed. */
async function createAndClaim(store, workerId) {
  const runId = `run-model-replay-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext(workerId);
  assert.equal(claim?.runId, runId, 'createAndClaim helper must actually claim the run it just created');
  return { runId, claim };
}

/** Force-expires `runId`'s lease and sweeps it, the way every other live row here reclaims a run. */
async function forceExpireAndSweep(store, runId) {
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  const swept = await store.sweepExpired();
  assert.deepEqual(swept, [runId], 'sweepExpired must reclaim exactly this run');
}

/** A `ModelCompletion` carrying a scripted JSON document as its `text`. */
function jsonCompletion(document) {
  return {
    text: JSON.stringify(document),
    modelId: 'claude-under-test',
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/** A port that always answers the same completion and counts how many times it was called. */
function countingPort(completion) {
  let callCount = 0;
  return {
    get calls() {
      return callCount;
    },
    async complete() {
      callCount += 1;
      return completion;
    },
  };
}

/** The smallest `IncidentState` `generate_hypotheses` can run against, pinned to a real run's id. `extraIncidentFields` lets a row vary the request without touching the control counters an exec key is built from. */
function buildState(runId, extraIncidentFields = {}) {
  return {
    incident: {
      id: `incident-${runId}`,
      primaryScope: {
        serviceId: '11111111-1111-4111-8111-111111111111',
        environmentId: '22222222-2222-4222-8222-222222222222',
      },
      ...extraIncidentFields,
    },
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: {
      runId,
      schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: domain.STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6 - takeover: B reuses A's committed model.role result, never re-asks  */
/* -------------------------------------------------------------------------- */

test(
  'a lease taken over after a model role committed: the second worker reuses the committed result, the model is called exactly once in total, and node_results/run_events show one committed row followed by a reuse',
  { timeout: 60_000 },
  async (t) => {
    const store = await freshStore(t);
    const { runId, claim: claimA } = await createAndClaim(store, 'worker-model-replay-a');
    const contextA = await persistence.openRunWriteContext(store, claimA);

    const port = countingPort(
      jsonCompletion({ hypotheses: [{ id: 'h-1', statement: 'the checkout deploy changed the db endpoint' }] }),
    );
    const state = buildState(runId);
    const nodeA = roles.createModelGenerateHypotheses({ port, execution: contextA });

    const resultA = await nodeA(state);

    await forceExpireAndSweep(store, runId);
    const claimB = await store.claimNext('worker-model-replay-b');
    assert.equal(claimB.runId, runId);
    assert.equal(claimB.executionAttempt, 2, 'the takeover must be a second attempt');
    const contextB = await persistence.openRunWriteContext(store, claimB);

    const nodeB = roles.createModelGenerateHypotheses({ port, execution: contextB });
    const resultB = await nodeB(state);

    assert.equal(
      port.calls,
      1,
      'the model must have been called exactly once in TOTAL across both attempts: B must reuse the committed result rather than re-ask the model',
    );
    assert.deepEqual(resultB, resultA, "B's node result must be exactly A's: both were parsed from the SAME committed completion");

    const expectedExecKey = domain.buildExecKey('model.role', {
      runId,
      role: 'generate_hypotheses',
      promptVersion: roles.REFERENCE_PROMPT_VERSION,
      iterationsUsed: state.control.iterationsUsed,
      challengeRounds: state.control.challengeRounds,
      resumeCount: state.control.resumeCount,
    });

    // Independent oracle: read the committed row with a raw query against
    // store.pool, never through the write context's own committed() read path.
    const { rows: resultRows } = await store.pool.query(
      'select op, produced_by_attempt from aic_app.node_results where run_id = $1 and exec_key = $2',
      [runId, expectedExecKey],
    );
    assert.equal(resultRows.length, 1, 'exactly one node_results row may exist for this run and exec_key');
    assert.equal(resultRows[0].op, 'model.role', "the stored op must be the exec key's own operation");
    assert.equal(
      Number(resultRows[0].produced_by_attempt),
      1,
      'the committed row must have been produced by the FIRST worker (execution_attempt 1), never re-written by the second',
    );

    const { rows: eventRows } = await store.pool.query(
      'select type, execution_attempt from aic_app.run_events where run_id = $1 order by seq',
      [runId],
    );
    const eventTypes = eventRows.map((row) => row.type);
    assert.deepEqual(
      eventTypes,
      ['node_result.committed', 'node_result.reused'],
      `run_events must show node_result.committed (attempt 1) then node_result.reused (attempt 2), got: ${JSON.stringify(eventRows)}`,
    );
    assert.equal(Number(eventRows[0].execution_attempt), 1);
    assert.equal(Number(eventRows[1].execution_attempt), 2);
  },
);

/* -------------------------------------------------------------------------- */
/* Row 7 - integrity: same exec key, a different request, refused before      */
/* calling the model again, recorded as durable evidence                      */
/* -------------------------------------------------------------------------- */

test(
  'a request that differs while the control counters (and so the exec key) stay the same is refused as ExecutionIntegrityViolation, never calls the model again, and records execution.integrity_violation',
  { timeout: 60_000 },
  async (t) => {
    const store = await freshStore(t);
    const { runId, claim: claimA } = await createAndClaim(store, 'worker-model-integrity-a');
    const contextA = await persistence.openRunWriteContext(store, claimA);

    const port = countingPort(
      jsonCompletion({ hypotheses: [{ id: 'h-1', statement: 'the checkout deploy changed the db endpoint' }] }),
    );
    const stateA = buildState(runId);
    const nodeA = roles.createModelGenerateHypotheses({ port, execution: contextA });
    await nodeA(stateA);
    assert.equal(port.calls, 1);

    await forceExpireAndSweep(store, runId);
    const claimB = await store.claimNext('worker-model-integrity-b');
    assert.equal(claimB.executionAttempt, 2, 'the takeover must be a second attempt');
    const contextB = await persistence.openRunWriteContext(store, claimB);

    // Same runId, same iterationsUsed/challengeRounds/resumeCount - so the
    // SAME model.role exec key - but a different request: an incident field
    // the domain's IncidentSchema (a looseObject) accepts but which changes
    // what generate_hypotheses's own prompt describes.
    const stateB = buildState(runId, { note: 'a fact the first request never carried' });
    const nodeB = roles.createModelGenerateHypotheses({ port, execution: contextB });

    await assert.rejects(
      () => nodeB(stateB),
      (error) => error instanceof domain.ExecutionIntegrityViolation,
      'a different request under the same exec key must be refused as an integrity violation, never silently replayed as if it were the same call',
    );

    assert.equal(
      port.calls,
      1,
      'the integrity check happens BEFORE calling the model again: the model must not have been called a second time',
    );

    const { rows: violationRows } = await store.pool.query(
      "select payload from aic_app.run_events where run_id = $1 and type = 'execution.integrity_violation'",
      [runId],
    );
    assert.equal(
      violationRows.length,
      1,
      'a refused input-fingerprint mismatch is an integrity event recorded as durable evidence, not only an exception the caller may drop',
    );

    const expectedExecKey = domain.buildExecKey('model.role', {
      runId,
      role: 'generate_hypotheses',
      promptVersion: roles.REFERENCE_PROMPT_VERSION,
      iterationsUsed: stateA.control.iterationsUsed,
      challengeRounds: stateA.control.challengeRounds,
      resumeCount: stateA.control.resumeCount,
    });
    assert.equal(violationRows[0].payload.execKey, expectedExecKey);

    const { rows: resultRows } = await store.pool.query(
      'select count(*)::int as n from aic_app.node_results where run_id = $1 and exec_key = $2',
      [runId, expectedExecKey],
    );
    assert.equal(resultRows[0].n, 1, "the refused commit must never have created a second node_results row: A's committed row stays as it was");
  },
);
