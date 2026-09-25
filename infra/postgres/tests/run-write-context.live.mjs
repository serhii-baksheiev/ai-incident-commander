/**
 * AIC-56, slice C — the half that needs a real database: the fenced write
 * context's `committed` replay/idempotency/integrity protocol, `complete` /
 * `fail` / `markWaitingHuman`, the zombie-worker acceptance row, and the
 * "`compute` runs outside any transaction" requirement no single-process
 * assertion can prove.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/run-store.live.mjs` — see that file's header for the
 * full rationale behind "why this file is not under `test/`", "it refuses; it
 * never skips", and "independent verification" (raw SQL against `store.pool`
 * rather than the write context's own methods, so a check that also went
 * through them could not tell "the context thinks it succeeded" from "it
 * actually happened in the database"). Not repeated here in full.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## Design choices this file assumes, beyond test/run-write-context.test.mjs
 *
 * `project(result)` returns `{ trials?: Trial[], evidence?: Evidence[] }` —
 * the domain's own `Trial` and `Evidence` (`@aic/domain`, `TrialSchema` /
 * `EvidenceSchema`), which is what the graph produces. They are projected into
 * `run_trials` (`run_id`, `trial_id` = the trial's `id`, `body` = its canonical
 * JSON) and `run_evidence` (`run_id`, `evidence_id` = the evidence's `id`,
 * `trial_id`, `body`).
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';

import * as domain from '@aic/domain';

/** A domain `Trial` the way the graph builds one. */
const domainTrial = (id, runId, evidenceIds = []) => ({
  id,
  runId,
  testId: `test-of-${id}`,
  attempt: 1,
  tool: 'logs.search',
  input: { query: 'error' },
  status: 'ok',
  durationMs: 5,
  evidenceIds,
});

/** A domain `Evidence` the way the graph builds one. */
const domainEvidence = (id, trialId) => ({
  id,
  trialId,
  kind: 'log',
  source: 'fixture',
  observedAt: '2026-09-24T00:00:00.000Z',
  statement: 'an error was logged',
  rawRef: `raw-${id}`,
});
import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place the fenced write
context's replay, idempotency, integrity and zombie-worker rows are measured
against a real PostgreSQL, so a skip would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const DEFAULT_OPTIONS = Object.freeze({ leaseMs: 30_000, maxExecutionAttempts: 5 });

/**
 * A store against a freshly (idempotently) provisioned `aic_app` schema, with
 * every table this slice touches truncated — one statement, so foreign keys
 * (if any) between them never dictate an order — and the pool closed at the
 * end of the row.
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
  const runId = `run-write-context-${randomUUID()}`;
  await store.createRun({ runId, input: {} });
  const claim = await store.claimNext(workerId);
  assert.equal(claim?.runId, runId, 'createAndClaim helper must actually claim the run it just created');
  return { runId, claim };
}

function sha256hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

/** A project() that writes no projection rows — for rows not exercising rows 6/10's projection assertions. */
function noProjection() {
  return {};
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
/* Row 5 — setupApplicationSchema creates every migration-2 table and column, */
/* and migration 1's own partial indexes carry over                          */
/* -------------------------------------------------------------------------- */

test('setupApplicationSchema creates every migration-2 table and column, and the catalog shows them', async (t) => {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const store = await persistence.createRunStore(connectionString, DEFAULT_OPTIONS);
  t.after(() => store.close());

  await assert.doesNotReject(
    () => persistence.assertApplicationSchemaVersion(store.pool),
    'after setupApplicationSchema the application schema must report exactly the current APP_SCHEMA_VERSION',
  );

  const { rows: tableRows } = await store.pool.query(
    `select table_name from information_schema.tables where table_schema = 'aic_app' order by table_name`,
  );
  const tableNames = new Set(tableRows.map((row) => row.table_name));
  for (const expected of [
    'runs',
    'node_results',
    'run_events',
    'run_event_counters',
    'run_trials',
    'run_evidence',
    'fence_rejections',
    'schema_migrations',
  ]) {
    assert.ok(tableNames.has(expected), `aic_app.${expected} must exist after setupApplicationSchema runs`);
  }

  const { rows: columnRows } = await store.pool.query(
    `select column_name from information_schema.columns where table_schema = 'aic_app' and table_name = 'runs'`,
  );
  assert.ok(
    columnRows.some((row) => row.column_name === 'interaction_id'),
    'aic_app.runs must gain an interaction_id column in migration 2 (an ALTER TABLE — migration 1 stays byte-identical, see test/run-write-context.test.mjs)',
  );

  const { rows: indexRows } = await store.pool.query(`select indexname from pg_indexes where schemaname = 'aic_app'`);
  const indexNames = new Set(indexRows.map((row) => row.indexname));
  const { rows: indexDefs } = await store.pool.query(
    `select indexdef from pg_indexes where schemaname = 'aic_app'`,
  );
  const defs = indexDefs.map((row) => row.indexdef);
  assert.ok(
    defs.some((def) => /UNIQUE INDEX .* ON aic_app\.runs .*\(interaction_id\) WHERE \(interaction_id IS NOT NULL\)/.test(def)),
    'an interaction id must name at most one run, so a human reply is never ambiguous between two runs',
  );
  assert.ok(
    defs.some((def) => /ON aic_app\.fence_rejections .*\(run_id, at\)/.test(def)),
    'fence_rejections is read per run; without an index every read of that evidence is a sequential scan',
  );
  assert.ok(
    indexNames.has('runs_queued_created_at_idx'),
    'migration 1\'s partial index over queued runs (slice B) must still exist once migration 2 (and any migration appended after it) is applied',
  );
  assert.ok(
    indexNames.has('runs_running_lease_idx'),
    'migration 1\'s partial index over running leases (slice B) must still exist once migration 2 (and any migration appended after it) is applied',
  );
  for (const table of ['node_results', 'run_events', 'run_event_counters', 'run_trials', 'run_evidence']) {
    assert.ok(indexNames.has(`${table}_pkey`), `aic_app.${table} must carry its own primary key`);
  }
});

/* -------------------------------------------------------------------------- */
/* Row 6 — first committed calls compute once, writes the result row, the    */
/* projection rows and one node_result.committed event                       */
/* -------------------------------------------------------------------------- */

test('first committed calls compute exactly once, returns its result, and writes the result row, the projection rows, and one node_result.committed event', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-commit-1');
  const context = await persistence.openRunWriteContext(store, claim);

  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'first-commit', trialAttempt: 1 });
  const resultValue = { observed: 'ok', score: 1 };
  let computeCalls = 0;
  const compute = async () => {
    computeCalls += 1;
    return resultValue;
  };
  const trialId = 'trial-first-commit';
  const evidenceId = 'evidence-first-commit';
  const trial = domainTrial(trialId, runId, [evidenceId]);
  const evidence = domainEvidence(evidenceId, trialId);
  assert.equal(domain.TrialSchema.safeParse(trial).success, true, 'the fixture must be a valid domain Trial');
  assert.equal(domain.EvidenceSchema.safeParse(evidence).success, true, 'the fixture must be a valid domain Evidence');
  const project = () => ({ trials: [trial], evidence: [evidence] });

  const returned = await context.committed(execKey, compute, { project });

  assert.equal(computeCalls, 1, 'compute must be called exactly once for a first commit');
  assert.deepEqual(returned, resultValue, "committed must return compute's own result on a first commit");

  const { rows: resultRows } = await store.pool.query(
    'select op, result_json, result_sha, produced_by_attempt from aic_app.node_results where run_id = $1 and exec_key = $2',
    [runId, execKey],
  );
  assert.equal(resultRows.length, 1, 'exactly one node_results row must exist for (run_id, exec_key) after a first commit');
  const row = resultRows[0];
  assert.equal(row.op, 'tool.trial', "the stored op must be the exec key's own operation");
  assert.equal(
    Number(row.produced_by_attempt),
    claim.executionAttempt,
    'produced_by_attempt must be the committing claim\'s execution attempt (provenance only)',
  );
  const expectedCanonicalJson = JSON.stringify(domain.canonicalJson(resultValue));
  assert.equal(
    row.result_json,
    expectedCanonicalJson,
    'result_json must be the canonical JSON text of the committed result — canonicalJson is the one place canonical JSON lives in this codebase',
  );
  assert.equal(row.result_sha, sha256hex(expectedCanonicalJson), 'result_sha must be the sha256 of the canonical JSON text');

  const { rows: trialRows } = await store.pool.query('select trial_id, body from aic_app.run_trials where run_id = $1', [runId]);
  assert.deepEqual(
    trialRows.map((r) => [r.trial_id, r.body]),
    [[trialId, JSON.stringify(domain.canonicalJson(trial))]],
    "the projection's trial must be written into run_trials as its id and its canonical JSON",
  );

  const { rows: evidenceRows } = await store.pool.query(
    'select evidence_id, trial_id from aic_app.run_evidence where run_id = $1',
    [runId],
  );
  assert.deepEqual(
    evidenceRows.map((r) => [r.evidence_id, r.trial_id]),
    [[evidenceId, trialId]],
    "the projection's evidence row must be written into run_evidence",
  );

  const { rows: eventRows } = await store.pool.query(
    'select type, execution_attempt from aic_app.run_events where run_id = $1 order by seq',
    [runId],
  );
  assert.equal(eventRows.length, 1, 'exactly one run event must be appended for a first commit');
  assert.equal(eventRows[0].type, 'node_result.committed');
  assert.equal(Number(eventRows[0].execution_attempt), claim.executionAttempt);
});

/* -------------------------------------------------------------------------- */
/* Row 7 — replay: same context, and a new context after a takeover, never   */
/* re-call compute; produced_by_attempt stays the ORIGINAL committing attempt */
/* -------------------------------------------------------------------------- */

test('replay does not call compute again — in the same context, and again after sweep+reclaim hands the run to a new attempt', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-replay-a');
  const context = await persistence.openRunWriteContext(store, claim);
  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'replay', trialAttempt: 1 });
  const resultValue = { observed: 'replay-me' };
  let computeCalls = 0;
  const compute = async () => {
    computeCalls += 1;
    return resultValue;
  };

  const first = await context.committed(execKey, compute, { project: noProjection });
  assert.equal(computeCalls, 1);

  const second = await context.committed(execKey, compute, { project: noProjection });
  assert.equal(computeCalls, 1, 'a replay in the SAME context must not call compute again');
  assert.deepEqual(second, first, 'a replay must return a value deep-equal to the stored result');

  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  await store.sweepExpired();
  const claim2 = await store.claimNext('worker-replay-b');
  assert.equal(claim2.runId, runId);
  assert.equal(claim2.executionAttempt, 2, 'the takeover must be a second attempt');
  const context2 = await persistence.openRunWriteContext(store, claim2);

  const third = await context2.committed(execKey, compute, { project: noProjection });
  assert.equal(
    computeCalls,
    1,
    'a replay after a takeover must still not call compute again: the committed result is reused, not recomputed by the new attempt',
  );
  assert.deepEqual(third, first);

  const { rows } = await store.pool.query(
    'select produced_by_attempt from aic_app.node_results where run_id = $1 and exec_key = $2',
    [runId, execKey],
  );
  assert.equal(rows.length, 1, 'replay must never create a second node_results row for the same key');
  assert.equal(
    Number(rows[0].produced_by_attempt),
    1,
    'produced_by_attempt is provenance of the ORIGINAL committing attempt and must not change on replay',
  );

  const { rows: eventRows } = await store.pool.query('select type from aic_app.run_events where run_id = $1 order by seq', [
    runId,
  ]);
  assert.deepEqual(
    eventRows.map((r) => r.type),
    ['node_result.committed', 'node_result.reused', 'node_result.reused'],
    'each replay must append its own node_result.reused event, fenced, even though it writes no new result',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 8 — a different key (re-observation) calls compute again              */
/* -------------------------------------------------------------------------- */

test('a different exec_key (re-observation) calls compute again and writes a second node_results row', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-second-key');
  const context = await persistence.openRunWriteContext(store, claim);
  let calls = 0;
  const compute = async () => {
    calls += 1;
    return { attempt: calls };
  };

  const key1 = domain.buildExecKey('tool.trial', { runId, testId: 're-observe', trialAttempt: 1 });
  const key2 = domain.buildExecKey('tool.trial', { runId, testId: 're-observe', trialAttempt: 2 });

  const r1 = await context.committed(key1, compute, { project: noProjection });
  const r2 = await context.committed(key2, compute, { project: noProjection });

  assert.equal(calls, 2, 'a distinct exec_key (a new Trial attempt) must call compute again: re-observation, not replay');
  assert.notDeepEqual(r1, r2, "the two committed values must differ: each call's own compute() ran");

  const { rows } = await store.pool.query(
    'select exec_key from aic_app.node_results where run_id = $1 order by exec_key',
    [runId],
  );
  assert.equal(rows.length, 2, 'two distinct exec_keys must produce two distinct node_results rows');
});

/* -------------------------------------------------------------------------- */
/* Row 9 — integrity: a different inputFingerprint, and a concurrent commit   */
/* racing to insert a different (and, separately, the same) result           */
/* -------------------------------------------------------------------------- */

test('a different inputFingerprint for an already-committed key throws ExecutionIntegrityViolation before calling compute again, and leaves the stored row unchanged', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-integrity-fingerprint');
  const context = await persistence.openRunWriteContext(store, claim);
  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'fingerprint', trialAttempt: 1 });
  const resultValue = { observed: 'first' };
  const compute1 = async () => resultValue;

  await context.committed(execKey, compute1, { project: noProjection, inputFingerprint: 'fingerprint-a' });

  const { rows: before } = await store.pool.query(
    'select result_json, result_sha from aic_app.node_results where run_id = $1 and exec_key = $2',
    [runId, execKey],
  );
  assert.equal(before.length, 1);

  let compute2Calls = 0;
  const compute2 = async () => {
    compute2Calls += 1;
    return { observed: 'should never be stored' };
  };

  await assert.rejects(
    () => context.committed(execKey, compute2, { project: noProjection, inputFingerprint: 'fingerprint-b' }),
    (error) => error instanceof domain.ExecutionIntegrityViolation && error.execKey === execKey,
    'a different inputFingerprint for an already-committed key must throw ExecutionIntegrityViolation, naming the execKey',
  );
  assert.equal(
    compute2Calls,
    0,
    'the input-fingerprint check happens BEFORE calling compute again (protocol step 1, before step 2) — replay/integrity is decided from the stored row, never from a fresh computation',
  );

  const { rows: after } = await store.pool.query(
    'select result_json, result_sha from aic_app.node_results where run_id = $1 and exec_key = $2',
    [runId, execKey],
  );
  assert.deepEqual(
    after,
    before,
    'the stored row must be byte-for-byte unchanged after a refused integrity violation: a committed result is immutable',
  );

  const { rows: violations } = await store.pool.query(
    "select payload from aic_app.run_events where run_id = $1 and type = 'execution.integrity_violation'",
    [runId],
  );
  assert.equal(
    violations.length,
    1,
    'a refused input-fingerprint mismatch is an integrity event decision 12 records as durable evidence, not only an exception the caller may drop',
  );
  assert.equal(violations[0].payload.execKey, execKey);
});

test('a concurrent commit for the same key with a DIFFERENT result throws ExecutionIntegrityViolation, leaves the stored bytes unchanged, and records an execution.integrity_violation event', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-integrity-race');
  const context = await persistence.openRunWriteContext(store, claim);
  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'race', trialAttempt: 1 });

  const settledByOther = { value: 'settled-by-someone-else' };
  const settledJson = JSON.stringify(domain.canonicalJson(settledByOther));
  const settledSha = sha256hex(settledJson);

  const compute = async () => {
    // Two real RunWriteContexts cannot hold the same run's fence at the same
    // time outside a takeover (row 7 already covers a takeover's replay).
    // This simulates the race directly: compute()'s own side effect inserts
    // the "other" committer's row with raw SQL before returning a DIFFERENT
    // value of its own, so committed()'s own insert collides with it.
    await store.pool.query(
      `insert into aic_app.node_results (run_id, exec_key, op, input_sha, result_json, result_sha, produced_by_attempt)
       values ($1, $2, 'tool.trial', null, $3, $4, $5)`,
      [runId, execKey, settledJson, settledSha, claim.executionAttempt],
    );
    return { value: 'mine' };
  };

  await assert.rejects(
    () => context.committed(execKey, compute, { project: noProjection }),
    (error) => error instanceof domain.ExecutionIntegrityViolation && error.execKey === execKey,
    'racing to insert a different result for the same key must surface as ExecutionIntegrityViolation, never as a raw unique-constraint error leaking out of the store',
  );

  const { rows } = await store.pool.query(
    'select result_json, result_sha from aic_app.node_results where run_id = $1 and exec_key = $2',
    [runId, execKey],
  );
  assert.equal(rows.length, 1, 'the race must never produce two rows for the same key');
  assert.equal(rows[0].result_json, settledJson, 'the stored row must be whichever result WON the race — never overwritten by the losing commit');
  assert.equal(rows[0].result_sha, settledSha);

  const { rows: eventRows } = await store.pool.query('select type from aic_app.run_events where run_id = $1 order by seq', [
    runId,
  ]);
  assert.ok(
    eventRows.some((r) => r.type === 'execution.integrity_violation'),
    'the losing commit must append an execution.integrity_violation event, fenced, as durable evidence of the rejection (decision 12)',
  );
});

test('a concurrent commit for the same key with the SAME result is idempotent: no throw, the stored result is returned, and no second row is written', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-integrity-race-same-sha');
  const context = await persistence.openRunWriteContext(store, claim);
  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'race-same-sha', trialAttempt: 1 });

  const shared = { value: 'shared' };
  const sharedJson = JSON.stringify(domain.canonicalJson(shared));
  const sharedSha = sha256hex(sharedJson);

  const compute = async () => {
    await store.pool.query(
      `insert into aic_app.node_results (run_id, exec_key, op, input_sha, result_json, result_sha, produced_by_attempt)
       values ($1, $2, 'tool.trial', null, $3, $4, $5)`,
      [runId, execKey, sharedJson, sharedSha, claim.executionAttempt],
    );
    return shared; // exactly what was just inserted: same canonical JSON, same sha
  };

  const returned = await context.committed(execKey, compute, { project: noProjection });
  assert.deepEqual(returned, shared, 'a same-sha race must be idempotent: return the (already-)stored result rather than throwing');

  const { rows } = await store.pool.query(
    'select result_json from aic_app.node_results where run_id = $1 and exec_key = $2',
    [runId, execKey],
  );
  assert.equal(rows.length, 1, 'a same-sha race must never produce two rows');
});

/* -------------------------------------------------------------------------- */
/* Row 10 — zombie: a worker that has lost its lease and been superseded     */
/* cannot write domain records or events; fence_rejections records the       */
/* attempts; a merely-expired (not yet swept) lease is refused too           */
/* -------------------------------------------------------------------------- */

test('a zombie worker after lease loss cannot write domain records or events, and fence_rejections records the attempts', async (t) => {
  const store = await freshStore(t);
  const { runId, claim: claimA } = await createAndClaim(store, 'worker-zombie-a');
  const contextA = await persistence.openRunWriteContext(store, claimA);

  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  await store.sweepExpired();
  const claimB = await store.claimNext('worker-zombie-b');
  assert.equal(claimB.runId, runId);
  assert.equal(claimB.executionAttempt, 2, 'the takeover must be a second attempt');

  const staleExecKey = domain.buildExecKey('tool.trial', { runId, testId: 'zombie', trialAttempt: 1 });
  const compute = async () => ({ value: 'must never land' });
  const project = () => ({ trials: [domainTrial('zombie-trial', runId)] });

  await assert.rejects(
    () => contextA.committed(staleExecKey, compute, { project }),
    (error) => error instanceof domain.StaleOwnerError,
    "A's committed() after losing the lease and being superseded must throw StaleOwnerError",
  );
  await assert.rejects(
    () => contextA.complete('done'),
    (error) => error instanceof domain.StaleOwnerError,
    "A's complete() after losing the lease must throw StaleOwnerError",
  );
  await assert.rejects(
    () => contextA.markWaitingHuman('some-interaction'),
    (error) => error instanceof domain.StaleOwnerError,
    "A's markWaitingHuman() after losing the lease must throw StaleOwnerError",
  );

  const { rows: resultRows } = await store.pool.query(
    'select 1 from aic_app.node_results where run_id = $1 and produced_by_attempt = 1',
    [runId],
  );
  assert.equal(resultRows.length, 0, 'no node_results row may exist with produced_by_attempt = 1: A never held valid write authority after the takeover');

  const { rows: trialRows } = await store.pool.query('select 1 from aic_app.run_trials where run_id = $1', [runId]);
  assert.equal(trialRows.length, 0, "A's attempted projection must never have landed in run_trials");

  const { rows: evidenceRows } = await store.pool.query('select 1 from aic_app.run_evidence where run_id = $1', [runId]);
  assert.equal(evidenceRows.length, 0, "A's attempted projection must never have landed in run_evidence");

  const { rows: eventRows } = await store.pool.query(
    'select 1 from aic_app.run_events where run_id = $1 and execution_attempt = 1',
    [runId],
  );
  assert.equal(
    eventRows.length,
    0,
    'a stale attempt writes no run event at all — the ticket\'s own invariant: "stale attempt cannot commit run-scoped domain/event writes"',
  );

  const { rows: runRows } = await store.pool.query('select status from aic_app.runs where run_id = $1', [runId]);
  assert.equal(runRows[0].status, 'running', "A's refused complete() must not have moved the run to completed");

  const { rows: rejectionRows } = await store.pool.query(
    'select kind from aic_app.fence_rejections where run_id = $1 and owner_worker_id = $2 and execution_attempt = 1 order by at',
    [runId, claimA.ownerWorkerId],
  );
  assert.equal(
    rejectionRows.length,
    3,
    'each of the three refused calls (committed, complete, markWaitingHuman) must record its own fence_rejections row, even though none of them may write a run_events row',
  );
  for (const row of rejectionRows) {
    assert.equal(typeof row.kind, 'string', 'fence_rejections.kind must be a non-null string naming what was refused');
    assert.ok(row.kind.length > 0);
  }
});

test('a context whose lease merely expired, with no sweep yet, is refused too', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-expired-no-sweep');
  const context = await persistence.openRunWriteContext(store, claim);

  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  // Deliberately no sweepExpired() call: the row still says status = 'running'
  // and owner_worker_id = this worker. The fence must still refuse, because it
  // checks lease_expires_at > clock_timestamp() directly rather than relying
  // on the sweeper having already moved the row to queued.

  await assert.rejects(
    () => context.assertOwner(),
    (error) => error instanceof domain.StaleOwnerError,
    'an expired lease is lost authority the instant it expires (decision 3), independent of whether a sweep has run yet',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 11 — compute runs OUTSIDE any transaction                              */
/* -------------------------------------------------------------------------- */

test('compute runs OUTSIDE any transaction: a concurrent FOR UPDATE on the run row is not blocked while compute is pending', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-outside-tx');
  const context = await persistence.openRunWriteContext(store, claim);
  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'outside-tx', trialAttempt: 1 });

  let releaseCompute;
  const computeGate = new Promise((resolve) => {
    releaseCompute = resolve;
  });
  const compute = async () => {
    await computeGate;
    return { value: 'released' };
  };

  const committedPromise = context.committed(execKey, compute, { project: noProjection });

  // Released inside this test's own finally, not through `t.after`: the hooks
  // run in registration order, so a release queued after `freshStore`'s
  // `store.close()` would wait behind `pool.end()`, which waits for this very
  // client — the lane hangs rather than fails (the lesson from
  // run-store.live.mjs's row 9b).
  const lockClient = await store.pool.connect();
  try {
    await lockClient.query('begin');
    await lockClient.query("set local lock_timeout = '500ms'");
    await assert.doesNotReject(
      () => lockClient.query('select run_id from aic_app.runs where run_id = $1 for update', [runId]),
      "while compute() is still pending, no lock on the run row may be held by the write context: a concurrent FOR UPDATE must succeed immediately rather than hit lock_timeout",
    );
  } finally {
    await lockClient.query('rollback');
    lockClient.release();
  }

  releaseCompute();
  const result = await committedPromise;
  assert.deepEqual(result, { value: 'released' });
});

/* -------------------------------------------------------------------------- */
/* Row 12 — markWaitingHuman / complete / fail, and strictly increasing seq   */
/* -------------------------------------------------------------------------- */

test('markWaitingHuman moves running to waiting_human, clears owner and lease, and stores the interaction id', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-waiting-human');
  const context = await persistence.openRunWriteContext(store, claim);

  await context.markWaitingHuman('interaction-42');

  const { rows } = await store.pool.query(
    'select status, owner_worker_id, lease_expires_at, interaction_id from aic_app.runs where run_id = $1',
    [runId],
  );
  assert.deepEqual(
    {
      status: rows[0].status,
      ownerWorkerId: rows[0].owner_worker_id,
      leaseExpiresAt: rows[0].lease_expires_at,
      interactionId: rows[0].interaction_id,
    },
    { status: 'waiting_human', ownerWorkerId: null, leaseExpiresAt: null, interactionId: 'interaction-42' },
    'markWaitingHuman must move running->waiting_human, clear owner_worker_id and lease_expires_at (decision 4: waiting for a human owns no worker), and store the interaction id',
  );
});

/**
 * AIC-56 slice D1 carry-over from slice C: `interaction_id` names at most one
 * run (migration 2's own unique partial index, pinned structurally by "the
 * catalog shows them" row above) - this is the behavioural half, at the
 * `markWaitingHuman` method itself, that no existing row in this file
 * exercises: every other `markWaitingHuman` row here uses a distinct
 * interaction id per run.
 */
test('markWaitingHuman refuses an interaction id another run already holds, and that other run stays running with its owner', async (t) => {
  const store = await freshStore(t);
  const { runId: runIdA, claim: claimA } = await createAndClaim(store, 'worker-dup-interaction-a');
  const { runId: runIdB, claim: claimB } = await createAndClaim(store, 'worker-dup-interaction-b');
  const contextA = await persistence.openRunWriteContext(store, claimA);
  const contextB = await persistence.openRunWriteContext(store, claimB);

  await contextA.markWaitingHuman('interaction-dup');

  await assert.rejects(
    () => contextB.markWaitingHuman('interaction-dup'),
    'run B must be refused: interaction-dup is already held by run A, and the unique partial index on aic_app.runs(interaction_id) must refuse the second row and roll back the transaction',
  );

  const { rows: rowsB } = await store.pool.query(
    'select status, owner_worker_id, execution_attempt from aic_app.runs where run_id = $1',
    [runIdB],
  );
  assert.deepEqual(
    { status: rowsB[0].status, ownerWorkerId: rowsB[0].owner_worker_id, executionAttempt: Number(rowsB[0].execution_attempt) },
    { status: 'running', ownerWorkerId: claimB.ownerWorkerId, executionAttempt: claimB.executionAttempt },
    "run B's refused markWaitingHuman must roll back entirely: run B keeps its own owner and lease, exactly as if the call had never been made",
  );

  const { rows: rowsA } = await store.pool.query(
    'select status, interaction_id from aic_app.runs where run_id = $1',
    [runIdA],
  );
  assert.deepEqual(
    { status: rowsA[0].status, interactionId: rowsA[0].interaction_id },
    { status: 'waiting_human', interactionId: 'interaction-dup' },
    "run A's own successful markWaitingHuman must be unaffected by run B's later, refused attempt",
  );
});

test('complete moves running to completed', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-complete');
  const context = await persistence.openRunWriteContext(store, claim);

  await context.complete('reached terminal result');

  const { rows } = await store.pool.query('select status from aic_app.runs where run_id = $1', [runId]);
  assert.equal(rows[0].status, 'completed', 'complete() must move running->completed');
});

test('fail moves running to failed and stores the given reason', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-fail');
  const context = await persistence.openRunWriteContext(store, claim);

  await context.fail('boom');

  const { rows } = await store.pool.query('select status, terminal_reason from aic_app.runs where run_id = $1', [runId]);
  assert.equal(rows[0].status, 'failed', 'fail() must move running->failed');
  assert.equal(rows[0].terminal_reason, 'boom', 'fail() must store the given reason as terminal_reason');
});

test('each fenced write appends an event with a strictly increasing seq per run', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-seq');
  const context = await persistence.openRunWriteContext(store, claim);
  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'seq', trialAttempt: 1 });
  const compute = async () => ({ value: 'x' });

  await context.committed(execKey, compute, { project: noProjection });
  await context.complete('done');

  const { rows } = await store.pool.query('select seq from aic_app.run_events where run_id = $1 order by seq', [runId]);
  assert.ok(rows.length >= 2, 'both the commit and the complete must each append an event');
  const seqs = rows.map((row) => Number(row.seq));
  for (let i = 1; i < seqs.length; i += 1) {
    assert.ok(seqs[i] > seqs[i - 1], `seq must strictly increase per run: ${seqs[i - 1]} then ${seqs[i]}`);
  }
});

/* -------------------------------------------------------------------------- */
/* Round-1 review rows                                                         */
/* -------------------------------------------------------------------------- */

test('more concurrent fence refusals than the pool has connections all end in StaleOwnerError instead of wedging the pool', async (t) => {
  const store = await freshStore(t);
  const { runId, claim: claimA } = await createAndClaim(store, 'worker-storm-a');
  const contextA = await persistence.openRunWriteContext(store, claimA);
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
  await store.sweepExpired();
  await store.claimNext('worker-storm-b');

  const refusals = 25; // pg's default pool max is 10
  let timer;
  const outcome = await Promise.race([
    Promise.allSettled(
      Array.from({ length: refusals }, (_, i) =>
        contextA.committed(
          domain.buildExecKey('tool.trial', { runId, testId: `storm-${i}`, trialAttempt: 1 }),
          async () => ({ i }),
          { project: noProjection },
        ),
      ),
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), 15_000);
    }),
  ]);
  clearTimeout(timer);
  if (outcome === 'timeout') {
    // A wedged pool never hands its clients back, so the store's own close in
    // t.after would wait forever and hang the lane instead of failing it.
    // Destroy the held clients (pg-pool's internal list) so the row fails.
    assert.ok(
      Array.isArray(store.pool._clients),
      'the teardown reads pg-pool\'s private client list; if it moved, fail here rather than hang in t.after',
    );
    for (const client of [...store.pool._clients]) client.release(new Error('wedged pool torn down by the test'));
  }
  assert.notEqual(outcome, 'timeout', 'concurrent fence refusals must not wedge the pool');
  assert.equal(
    outcome.every((result) => result.status === 'rejected' && result.reason instanceof domain.StaleOwnerError),
    true,
    'every refused commit must surface as StaleOwnerError',
  );
  const { rows } = await store.pool.query('select count(*)::int as n from aic_app.fence_rejections where run_id = $1', [runId]);
  assert.equal(rows[0].n, refusals, 'each refusal is still recorded as evidence');
});

test('complete and fail release the run: a terminal run has no owner and no lease', async (t) => {
  const store = await freshStore(t);
  for (const [finish, status] of [
    [(context) => context.complete('done'), 'completed'],
    [(context) => context.fail('broken'), 'failed'],
  ]) {
    const { runId, claim } = await createAndClaim(store, `worker-release-${status}`);
    const context = await persistence.openRunWriteContext(store, claim);
    await finish(context);
    const { rows } = await store.pool.query(
      'select status, owner_worker_id, lease_expires_at from aic_app.runs where run_id = $1',
      [runId],
    );
    assert.deepEqual(rows[0], { status, owner_worker_id: null, lease_expires_at: null });
  }
});

test('replay refuses a stored result whose text no longer matches its result_sha', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-tamper');
  const context = await persistence.openRunWriteContext(store, claim);
  const execKey = domain.buildExecKey('tool.trial', { runId, testId: 'tamper', trialAttempt: 1 });
  await context.committed(execKey, async () => ({ verdict: 'original' }), { project: noProjection });
  await store.pool.query(
    `update aic_app.node_results set result_json = '{"verdict":"altered"}' where run_id = $1 and exec_key = $2`,
    [runId, execKey],
  );
  let computeCalls = 0;
  await assert.rejects(
    () =>
      context.committed(
        execKey,
        async () => {
          computeCalls += 1;
          return { verdict: 'recomputed' };
        },
        { project: noProjection },
      ),
    (error) => error instanceof domain.ExecutionIntegrityViolation && error.execKey === execKey,
    'a stored result that no longer hashes to its result_sha must not be replayed as authoritative',
  );
  assert.equal(computeCalls, 0, 'a corrupted committed result is refused, never silently recomputed');
});

test('a fence refusal whose rejection cannot be recorded still ends in StaleOwnerError, carrying the recording failure as its cause', async (t) => {
  const store = await freshStore(t);
  const { runId, claim: claimA } = await createAndClaim(store, 'worker-unrecorded-a');
  const contextA = await persistence.openRunWriteContext(store, claimA);
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );

  await store.pool.query('alter table aic_app.fence_rejections rename to fence_rejections_unavailable');
  try {
    await assert.rejects(
      () =>
        contextA.committed(
          domain.buildExecKey('tool.trial', { runId, testId: 'unrecorded', trialAttempt: 1 }),
          async () => ({ value: 'never lands' }),
          { project: noProjection },
        ),
      (error) =>
        error instanceof domain.StaleOwnerError &&
        error.cause instanceof Error &&
        /fence_rejections/.test(error.cause.message),
      'the refusal is still the answer, and the lost evidence is observable as its cause (decision 12: never silently)',
    );
  } finally {
    await store.pool.query('alter table aic_app.fence_rejections_unavailable rename to fence_rejections');
  }
});

/**
 * AIC-56 slice F carry-over from slice E: `assertOwner()` — the bare fence
 * the fenced checkpointer calls before every checkpoint write
 * (`fenced-checkpointer.ts`'s `#guard`) — shares `recordFenceRejection` with
 * `runFenced`'s own refusal path (both call it, and both attach a recording
 * failure as `cause` rather than letting it vanish — see the row above for
 * `committed()`, and `run-write-context.ts`'s `assertOwner` function for the
 * same shape). This row exercises the SAME "the recording table itself is
 * unavailable" fault through `assertOwner()` directly, rather than through a
 * fenced write, so the shared behaviour is checked at both call sites rather
 * than assumed from one of them.
 */
test('assertOwner whose rejection record fails still throws StaleOwnerError, carrying the recording failure as its cause', async (t) => {
  const store = await freshStore(t);
  const { runId, claim } = await createAndClaim(store, 'worker-unrecorded-assert-owner');
  const context = await persistence.openRunWriteContext(store, claim);
  await store.pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );

  await store.pool.query('alter table aic_app.fence_rejections rename to fence_rejections_unavailable');
  try {
    await assert.rejects(
      () => context.assertOwner('checkpoint'),
      (error) =>
        error instanceof domain.StaleOwnerError &&
        error.cause instanceof Error &&
        /fence_rejections/.test(error.cause.message),
      'assertOwner must still refuse with StaleOwnerError when its rejection cannot be recorded, carrying the recording failure as cause — the same contract committed() carries above, because both share recordFenceRejection',
    );
  } finally {
    await store.pool.query('alter table aic_app.fence_rejections_unavailable rename to fence_rejections');
  }
});
