/**
 * AIC-146 sub-slice c5a: `aic incident investigate` over a REAL onboarded
 * lab@1 SourceBinding, a real PostgreSQL substrate, and a real spawned CLI
 * binary for onboarding — the live-lane row the design's acceptance mapping
 * calls "onboards Incident Lab" / "investigates end to end, provenance on
 * every Evidence" / "denied shown as untestable".
 *
 * No paid model call: `--roles model` runs through `runIncidentInvestigateCommand`
 * IN PROCESS (never the spawned binary) with a deterministic fake model port
 * injected through `createIncidentInvestigateDeps`'s own `createModelPort`
 * override — every role answers a schema-valid, locally-computed JSON
 * document, so `ANTHROPIC_API_KEY` below is a SHAPE, never read by anything
 * that reaches a network.
 *
 * No real Incident Lab: a test-owned `node:http` stub on `127.0.0.1:0`
 * answers whatever `lab@1` requests with the `bad-deployment` scenario's own
 * recorded observation data (`incident-lab/scenario-definitions.mjs`), and
 * can be switched to answer 403 for every request instead. It counts
 * requests by `url` (path plus query) so a re-run's "no second call" claim is
 * checkable.
 *
 * Production seam this file pins: `apps/cli/src/commands/incident-investigate-deps.ts`,
 * exporting
 *
 *   function createIncidentInvestigateDeps(
 *     env: NodeJS.ProcessEnv,
 *     overrides?: {
 *       createModelPort?: typeof createReferenceModelPort;
 *       fetch?: typeof fetch;
 *       stdout?: (text: string) => void;
 *       now?: () => string;
 *       workerId?: string;
 *     },
 *   ): { deps: IncidentInvestigateDeps; close(): Promise<void> }
 *
 * — the real wiring `apps/cli/src/index.ts`'s `incident investigate` branch
 * used to build inline (`createConnectedRunSession`,
 * `createConnectedCheckpointers`, the directory secret resolver,
 * `globalThis.fetch`, a random `workerId`, `new Date().toISOString`), pulled
 * out so `index.ts` can call it too and so this file can drive it without a
 * spawned process for the investigate step itself. Every row below imports
 * this module at the top of its own body, before any database or CLI call
 * happens, so a missing module reports its own absence as the failure.
 *
 * Onboarding goes through the REAL spawned CLI binary (`aic db migrate`,
 * `aic service add`, `aic env add`, `aic source add`, `aic incident start`),
 * the same convention every sibling `infra/postgres/tests/*.live.mjs` file
 * uses (see `cli-apply.live.mjs`'s header for "why this file is not under
 * `test/`" and "it refuses; it never skips" — not repeated here). The
 * `langgraph` checkpointer schema is provisioned by the TEST itself
 * (`createPostgresCheckpointer(url).setup()`), since no `aic` command
 * provisions it yet (owner decision D4 of the design this slice implements).
 *
 * AIC-146 c5b: every helper below (CLI onboarding, the stub lab, the fake
 * model port, the independent request-fingerprint oracle) now lives in
 * `fixtures/incident-investigate-shared.mjs`, reused by the kill/resume rows
 * in `incident-investigate-kill.live.mjs`. This file's own rows are
 * unchanged.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5440 docker compose --project-name aic146c5a \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5440/aic \
 *     node --import ./test/fixtures/no-ambient-tracing.mjs --test \
 *     --test-concurrency=1 infra/postgres/tests/incident-investigate.live.mjs
 *   docker compose --project-name aic146c5a \
 *     --file infra/postgres/compose.yaml down --volumes
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import {
  BAD_DEPLOYMENT_SCENARIO,
  CONNECTION_VARIABLE,
  createFullRunModelPort,
  createStubLab,
  depsModulePath,
  dropSchemas,
  handComputedRequestFingerprint,
  investigateCommandModulePath,
  modelKeyShape,
  onboard,
  provisionCheckpointerSchema,
  requireConnectionString as sharedRequireConnectionString,
  runCliOk,
} from './fixtures/incident-investigate-shared.mjs';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5440 docker compose --project-name aic146c5a --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5440/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place \`aic incident
investigate\` is measured end to end against a real onboarded SourceBinding, a
real PostgreSQL substrate and a real spawned CLI — a skip here reports these
rows as met with nothing actually run.`;

function requireConnectionString() {
  return sharedRequireConnectionString(START_THE_SUBSTRATE);
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", a failure surfacing later and further from the cause`,
  );
});

/* -------------------------------------------------------------------------- */
/* end to end                                                                 */
/* -------------------------------------------------------------------------- */

test('end to end: a full run over a real onboarded lab@1 SourceBinding completes, with non-empty evidence and independently verifiable provenance on every run_evidence row', async (t) => {
  const connectionString = requireConnectionString();
  const { createIncidentInvestigateDeps } = await import(depsModulePath);

  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await dropSchemas(pool);
  runCliOk(['db', 'migrate'], connectionString);
  await provisionCheckpointerSchema(connectionString);

  const stub = createStubLab(BAD_DEPLOYMENT_SCENARIO);
  const baseUrl = await stub.start();
  t.after(() => stub.stop());

  const { sourceBindingId, incidentId } = onboard(connectionString, baseUrl);

  const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShape };
  const fullRunPort = createFullRunModelPort();
  const stdoutLines = [];
  const { deps, close } = createIncidentInvestigateDeps(env, {
    createModelPort: () => fullRunPort,
    stdout: (text) => stdoutLines.push(text),
    workerId: `live-e2e-${randomUUID()}`,
  });
  t.after(() => close());

  const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);

  const before = new Date().toISOString();
  await runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'model'], deps);
  const after = new Date().toISOString();

  assert.equal(stdoutLines.length, 1, 'the command must print exactly one summary line');
  const summary = JSON.parse(stdoutLines[0]);
  assert.ok(
    Array.isArray(summary.evidence) && summary.evidence.length > 0,
    `expected non-empty evidence, got: ${JSON.stringify(summary)}`,
  );

  const { rows: runRows } = await pool.query('select status from aic_app.runs where run_id = $1', [summary.runId]);
  assert.equal(runRows.length, 1);
  assert.equal(runRows[0].status, 'completed');

  const { rows: trialRows } = await pool.query('select trial_id, body from aic_app.run_trials where run_id = $1', [
    summary.runId,
  ]);
  assert.ok(trialRows.length > 0, 'expected at least one aic_app.run_trials row');
  const trialsById = new Map(trialRows.map((row) => [row.trial_id, JSON.parse(row.body)]));

  const { rows: evidenceRows } = await pool.query('select body from aic_app.run_evidence where run_id = $1', [
    summary.runId,
  ]);
  assert.ok(evidenceRows.length > 0, 'expected at least one aic_app.run_evidence row');
  for (const row of evidenceRows) {
    const evidence = JSON.parse(row.body);
    assert.equal(evidence.provenance.sourceBindingId, sourceBindingId);
    assert.equal(evidence.provenance.adapter, 'lab@1');
    assert.equal(evidence.provenance.credentialRefId, null);
    assert.ok(
      evidence.provenance.fetchedAt >= before && evidence.provenance.fetchedAt <= after,
      `fetchedAt ${evidence.provenance.fetchedAt} must fall within [${before}, ${after}]`,
    );
    const producingTrial = trialsById.get(evidence.trialId);
    assert.ok(producingTrial, `evidence must point at a trial actually present in aic_app.run_trials: ${evidence.trialId}`);
    assert.equal(
      evidence.provenance.requestFingerprint,
      handComputedRequestFingerprint(producingTrial.tool, producingTrial.input),
      'requestFingerprint must equal an independently hand-computed sha256 over the canonical envelope of the producing trial\'s own tool and input',
    );
  }

  const { rows: nodeResultRows } = await pool.query(
    "select count(*)::int as n from aic_app.node_results where run_id = $1 and op = 'tool.trial'",
    [summary.runId],
  );
  assert.equal(
    nodeResultRows[0].n,
    stub.observationRequests(),
    'exactly one committed tool.trial node_results row per evidence request the run actually made',
  );
  assert.ok(stub.observationRequests() > 0, 'the stub must have received at least one evidence request');
});

/* -------------------------------------------------------------------------- */
/* denied                                                                     */
/* -------------------------------------------------------------------------- */

test('denied: a lab@1 stub answering 403 to every request ends tools-unavailable with empty evidence, and every trial carries a typed denied refusal naming the binding', async (t) => {
  const connectionString = requireConnectionString();
  const { createIncidentInvestigateDeps } = await import(depsModulePath);

  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await dropSchemas(pool);
  runCliOk(['db', 'migrate'], connectionString);
  await provisionCheckpointerSchema(connectionString);

  const stub = createStubLab(BAD_DEPLOYMENT_SCENARIO);
  stub.setDenyAll(true);
  const baseUrl = await stub.start();
  t.after(() => stub.stop());

  const { sourceBindingId, incidentId } = onboard(connectionString, baseUrl);

  const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShape };
  const stdoutLines = [];
  const { deps, close } = createIncidentInvestigateDeps(env, {
    createModelPort: () => createFullRunModelPort(),
    stdout: (text) => stdoutLines.push(text),
    workerId: `live-denied-${randomUUID()}`,
  });
  t.after(() => close());

  const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);
  await runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'model'], deps);

  const summary = JSON.parse(stdoutLines.at(-1));
  assert.equal(summary.stopKind, 'tools-unavailable', `expected tools-unavailable, got: ${JSON.stringify(summary)}`);
  assert.deepEqual(summary.evidence, []);

  const { rows: trialRows } = await pool.query('select body from aic_app.run_trials where run_id = $1', [
    summary.runId,
  ]);
  assert.ok(trialRows.length > 0, 'expected at least one aic_app.run_trials row');
  for (const row of trialRows) {
    const trial = JSON.parse(row.body);
    assert.equal(trial.status, 'unavailable');
    assert.deepEqual(trial.refusal, { reason: 'denied', sourceBindingId });
  }
});

/* -------------------------------------------------------------------------- */
/* not provisioned                                                            */
/* -------------------------------------------------------------------------- */

test('not provisioned: aic_app migrated but the langgraph checkpointer schema absent is refused checkpointer-not-provisioned, never a raw database error', async (t) => {
  const connectionString = requireConnectionString();
  const { createIncidentInvestigateDeps } = await import(depsModulePath);
  const { IncidentInvestigateRefusal } = await import(investigateCommandModulePath);

  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await dropSchemas(pool);
  runCliOk(['db', 'migrate'], connectionString);
  // Deliberately no provisionCheckpointerSchema call: the langgraph schema
  // stays absent, which is the one condition this row exists to measure.

  const stub = createStubLab(BAD_DEPLOYMENT_SCENARIO);
  const baseUrl = await stub.start();
  t.after(() => stub.stop());

  const { incidentId } = onboard(connectionString, baseUrl);

  const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShape };
  const stdoutLines = [];
  const { deps, close } = createIncidentInvestigateDeps(env, {
    createModelPort: () => createFullRunModelPort(),
    stdout: (text) => stdoutLines.push(text),
    workerId: `live-not-provisioned-${randomUUID()}`,
  });
  t.after(() => close());

  const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);
  await assert.rejects(
    () => runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'model'], deps),
    (error) => {
      assert.ok(error instanceof IncidentInvestigateRefusal, `expected an IncidentInvestigateRefusal, got: ${error}`);
      assert.equal(error.reason, 'checkpointer-not-provisioned');
      return true;
    },
  );
  assert.equal(stdoutLines.length, 0, 'a refused command must print no summary line');
});

/* -------------------------------------------------------------------------- */
/* re-running a completed run                                                 */
/* -------------------------------------------------------------------------- */

async function countCheckpointRows(pool, threadId) {
  const { rows } = await pool.query('select count(*)::int as n from langgraph.checkpoints where thread_id = $1', [threadId]);
  return rows[0].n;
}

test('re-running a completed run prints the same summary and makes no stub request and no model call', async (t) => {
  const connectionString = requireConnectionString();
  const { createIncidentInvestigateDeps } = await import(depsModulePath);

  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await dropSchemas(pool);
  runCliOk(['db', 'migrate'], connectionString);
  await provisionCheckpointerSchema(connectionString);

  const stub = createStubLab(BAD_DEPLOYMENT_SCENARIO);
  const baseUrl = await stub.start();
  t.after(() => stub.stop());

  const { incidentId } = onboard(connectionString, baseUrl);

  const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShape };
  const fullRunPort = createFullRunModelPort();
  const stdoutLines = [];
  const { deps, close } = createIncidentInvestigateDeps(env, {
    createModelPort: () => fullRunPort,
    stdout: (text) => stdoutLines.push(text),
    workerId: `live-rerun-${randomUUID()}`,
  });
  t.after(() => close());

  const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);
  const argv = ['checkout', 'staging', incidentId, '--roles', 'model'];

  await runIncidentInvestigateCommand(argv, deps);
  const firstSummary = JSON.parse(stdoutLines.at(-1));
  const requestsAfterFirstRun = stub.totalRequests();
  const modelCallsAfterFirstRun = fullRunPort.calls.length;
  assert.ok(requestsAfterFirstRun > 0, 'the first run must actually have reached the stub');
  assert.ok(modelCallsAfterFirstRun > 0, 'the first run must actually have called the fake model port');

  const checkpointRowsBefore = await countCheckpointRows(pool, firstSummary.runId);

  stdoutLines.length = 0;
  await runIncidentInvestigateCommand(argv, deps);

  assert.equal(
    await countCheckpointRows(pool, firstSummary.runId),
    checkpointRowsBefore,
    're-running a completed run must write no checkpoint',
  );

  assert.equal(stdoutLines.length, 1, 're-running a completed run must print exactly one summary line');
  const secondSummary = JSON.parse(stdoutLines[0]);
  assert.deepEqual(secondSummary, firstSummary, 're-running a completed run must print the exact same summary');
  assert.equal(
    stub.totalRequests(),
    requestsAfterFirstRun,
    're-running a completed run must make no new stub request',
  );
  assert.equal(
    fullRunPort.calls.length,
    modelCallsAfterFirstRun,
    're-running a completed run must make no new model call',
  );
});
