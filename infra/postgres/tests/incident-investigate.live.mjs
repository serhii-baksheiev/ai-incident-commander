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
 * — the exact real wiring `apps/cli/src/index.ts`'s `incident investigate`
 * branch builds inline (`createConnectedRunSession`,
 * `createConnectedCheckpointers`, the directory secret resolver,
 * `globalThis.fetch`, a random `workerId`, `new Date().toISOString`), pulled
 * out so `index.ts` can call it too and so this file can drive it without a
 * spawned process for the investigate step itself. Every row below imports
 * this module at the top of its own body, before any database or CLI call
 * happens: a missing module reports its own absence as the failure, never a
 * harness defect in this file's own onboarding, stub or fake-model-port
 * plumbing — each of those three was independently proven against a real
 * PostgreSQL and a real spawned CLI binary, using this file's own helpers,
 * wired through the equivalent of `apps/cli/src/index.ts`'s inline
 * construction.
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
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { Pool } from 'pg';

import { createPostgresCheckpointer } from '@aic/persistence';

import { childEnv } from '../../../test/fixtures/child-env.mjs';
import { LIVE_SCENARIOS } from '../../../incident-lab/scenario-definitions.mjs';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5440 docker compose --project-name aic146c5a --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5440/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place \`aic incident
investigate\` is measured end to end against a real onboarded SourceBinding, a
real PostgreSQL substrate and a real spawned CLI — a skip here reports these
rows as met with nothing actually run.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');
const depsModulePath = resolve(projectRoot, 'apps/cli/dist/commands/incident-investigate-deps.js');
const investigateCommandModulePath = resolve(projectRoot, 'apps/cli/dist/commands/incident-investigate.js');

const CLI_TIMEOUT_MS = 30_000;

function runCli(args, connectionString) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: childEnv({ [CONNECTION_VARIABLE]: connectionString }),
  });
}

function commandDiagnostics(args, result) {
  return `aic ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

function runCliOk(args, connectionString) {
  const result = runCli(args, connectionString);
  assert.equal(result.status, 0, commandDiagnostics(args, result));
  return result;
}

function parseLines(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

async function dropSchemas(pool) {
  await pool.query('DROP SCHEMA IF EXISTS "aic_app" CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS "langgraph" CASCADE');
}

async function provisionCheckpointerSchema(connectionString) {
  const checkpointer = createPostgresCheckpointer(connectionString);
  await checkpointer.setup();
  await checkpointer.pool.end();
}

/**
 * A shape only: `--roles model` reads `ANTHROPIC_API_KEY` before this file's
 * injected `createModelPort` ever runs (`requireModelConfig`), but the
 * injected port never sends it anywhere — assembled from parts rather than
 * written as one literal, following this repository's own convention for a
 * credential SHAPE a fixture needs (see registry-store.live.mjs's "a note on
 * the fixture values below").
 */
const modelKeyShape = ['not', 'a', 'real', 'anthropic', 'key', 'shape'].join('-');

const BAD_DEPLOYMENT_SCENARIO = LIVE_SCENARIOS.find((scenario) => scenario.id === 'bad-deployment');
assert.notEqual(BAD_DEPLOYMENT_SCENARIO, undefined, 'the bad-deployment v1 scenario must still be registered');

/**
 * A test-owned lab@1 stub on a loopback port: answers `/health` ok, answers
 * every `/observations/<toolId>` with the bad-deployment scenario's own
 * recorded observation output for that tool id (ignoring the query string —
 * this is a stub answering "whatever is asked", the same convention
 * test/bound-port-investigation-e2e.test.mjs's own header names, never a
 * second recorded fixture), and can be switched to answer 403 to every
 * observation request instead. Counts requests by their exact `url` (path
 * plus query), so "no second call for the same request" is checkable
 * per-request rather than only in aggregate.
 */
function createStubLab(scenario) {
  const outputByToolId = new Map(scenario.observations.map((observation) => [observation.toolId, observation.output]));
  const requestCounts = new Map();
  let denyAll = false;
  let server;

  const handler = (request, response) => {
    requestCounts.set(request.url, (requestCounts.get(request.url) ?? 0) + 1);
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    if (denyAll) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'denied' }));
      return;
    }
    const toolId = request.url.replace(/^\/observations\//, '').split('?')[0];
    const output = outputByToolId.get(toolId) ?? [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(output));
  };

  return {
    async start() {
      server = createServer(handler);
      await new Promise((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
      });
      const address = server.address();
      return `http://127.0.0.1:${address.port}`;
    },
    async stop() {
      await new Promise((resolveClose) => server.close(resolveClose));
    },
    setDenyAll(value) {
      denyAll = value;
    },
    requestCountFor(pathAndQuery) {
      return requestCounts.get(pathAndQuery) ?? 0;
    },
    totalRequests() {
      let total = 0;
      for (const count of requestCounts.values()) total += count;
      return total;
    },
  };
}

function jsonCompletion(document) {
  return { text: JSON.stringify(document), modelId: 'live-lane-fake-model', usage: { inputTokens: 10, outputTokens: 5 } };
}

/**
 * Drives a full canonical run to completion: every one of the four
 * reasoning roles answers a schema-valid JSON document, matched by the
 * unique sentence each role's own system prompt carries
 * (`packages/roles/src/investigation-roles.ts`) rather than by call order —
 * `challenge_hypothesis` may run zero or more times depending on the run's
 * own termination decisions, and `interpret_residual_evidence` runs once per
 * loop pass. Ids are unique per call so a repeated call never collides with
 * an id an earlier call already claimed.
 */
function createFullRunModelPort() {
  const calls = [];
  let challengeCounter = 0;
  return {
    calls,
    async complete(request) {
      calls.push(request);
      if (request.system.includes('Propose distinct, falsifiable causal hypotheses')) {
        return jsonCompletion({
          hypotheses: [
            {
              id: `h-live-${calls.length}`,
              statement: 'the checkout deploy changed the database endpoint',
              cause: { component: 'checkout', mechanism: 'deployment-regression' },
            },
          ],
        });
      }
      if (request.system.includes('reading evidence against hypotheses')) {
        return jsonCompletion({ assessments: [] });
      }
      if (request.system.includes('red-team reviewer challenging')) {
        challengeCounter += 1;
        return jsonCompletion({
          alternative: {
            id: `h-live-alt-${challengeCounter}`,
            statement: `an unrelated alternative cause #${challengeCounter}`,
            cause: { component: 'dependency-pool', mechanism: 'connection-pool-exhaustion' },
          },
          discriminatingTests: [
            {
              id: `dt-live-${challengeCounter}`,
              predictionId: 'prediction-placeholder',
              tool: 'metrics',
              input: { service: 'checkout', window: 'incident', metric: 'connection-pool' },
              cost: 'cheap',
            },
          ],
        });
      }
      if (request.system.includes('composing the final conclusion')) {
        return jsonCompletion({ kind: 'inconclusive', causes: [] });
      }
      throw new Error(`fake model port: unrecognised role request (system starts: ${request.system.slice(0, 100)})`);
    },
  };
}

/**
 * Onboards one Service/Environment/SourceBinding/Incident through the real
 * spawned CLI, and returns the ids the test needs. Each row calls this after
 * its own `dropSchemas` + `aic db migrate`, so distinct rows never share
 * registry state even though they share one PostgreSQL container.
 */
function onboard(connectionString, baseUrl) {
  runCliOk(['service', 'add', 'checkout'], connectionString);
  runCliOk(['env', 'add', 'checkout', 'staging'], connectionString);
  const sourceResult = parseLines(
    runCliOk(
      ['source', 'add', 'checkout', 'staging', 'lab-primary', '--adapter', 'lab@1', '--config', `baseUrl=${baseUrl}`],
      connectionString,
    ).stdout,
  )[0];
  const incidentResult = parseLines(
    runCliOk(
      [
        'incident',
        'start',
        'checkout',
        'staging',
        '--title',
        'checkout failures',
        '--started-at',
        '2026-09-29T10:00:00Z',
        '--signal',
        'pagerduty=checkout error rate spike',
      ],
      connectionString,
    ).stdout,
  )[0];
  return { sourceBindingId: sourceResult.id, incidentId: incidentResult.incident.id };
}

/** The same hand-built envelope test/bound-port-investigation-e2e.test.mjs uses for its independent requestFingerprint oracle — a deliberately separate, from-scratch re-sort, never @aic/domain's canonicalJson or @aic/tools's createRequestFingerprint (`.claude/rules/invariants.md`, "the independent-oracle invariant"). */
function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = sortKeysDeep(value[key]);
    }
    return sorted;
  }
  return value;
}

function handComputedRequestFingerprint(operation, input) {
  const envelope = JSON.stringify(sortKeysDeep({ input, operation }));
  return `sha256:${createHash('sha256').update(envelope).digest('hex')}`;
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
    stub.totalRequests(),
    'exactly one committed tool.trial node_results row per stub request the run actually made',
  );
  assert.ok(stub.totalRequests() > 0, 'the stub must have received at least one request');
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

  stdoutLines.length = 0;
  await runIncidentInvestigateCommand(argv, deps);

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
