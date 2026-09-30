/**
 * AIC-146 sub-slice c5b: the helpers `infra/postgres/tests/incident-investigate.live.mjs`
 * (c5a) first wrote for itself, extracted here so the kill/resume rows in
 * `incident-investigate-kill.live.mjs` can reuse the exact same CLI onboarding,
 * stub lab, model-port fake and independent-oracle helpers rather than a second,
 * silently-drifting copy (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation"). c5a imports from here now too; its own rows are unchanged.
 *
 * `createStubLab` gained two members beyond c5a's own use of it —
 * `holdAfter(count)` and `release()` — so a kill row can make the stub hold
 * one observation request open (never answering it) until the row explicitly
 * releases it, while every request before that threshold still answers
 * exactly as c5a's own rows require. Nothing about c5a's own behaviour
 * changes: with `holdAfter` never called, `heldCount()` stays 0 and every
 * request is answered exactly as before.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPostgresCheckpointer } from '@aic/persistence';

import { childEnv } from '../../../../test/fixtures/child-env.mjs';
import { LIVE_SCENARIOS } from '../../../../incident-lab/scenario-definitions.mjs';

export const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

export function requireConnectionString(startMessage) {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, startMessage);
  return value;
}

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
export const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');
export const depsModulePath = resolve(projectRoot, 'apps/cli/dist/commands/incident-investigate-deps.js');
export const investigateCommandModulePath = resolve(projectRoot, 'apps/cli/dist/commands/incident-investigate.js');
export const workerPath = resolve(projectRoot, 'infra/postgres/tests/fixtures/incident-investigate-worker.mjs');

export const CLI_TIMEOUT_MS = 30_000;

export function runCli(args, connectionString) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: CLI_TIMEOUT_MS,
    env: childEnv({ [CONNECTION_VARIABLE]: connectionString }),
  });
}

export function commandDiagnostics(args, result) {
  return `aic ${args.join(' ')} exited ${result.status} (signal ${result.signal ?? 'none'}, error ${result.error?.code ?? result.error?.message ?? 'none'})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

export function runCliOk(args, connectionString) {
  const result = runCli(args, connectionString);
  assert.equal(result.status, 0, commandDiagnostics(args, result));
  return result;
}

export function parseLines(stdout) {
  return stdout
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

export async function dropSchemas(pool) {
  await pool.query('DROP SCHEMA IF EXISTS "aic_app" CASCADE');
  await pool.query('DROP SCHEMA IF EXISTS "langgraph" CASCADE');
}

export async function provisionCheckpointerSchema(connectionString) {
  const checkpointer = createPostgresCheckpointer(connectionString);
  await checkpointer.setup();
  await checkpointer.pool.end();
}

/**
 * A shape only: `--roles model` reads `ANTHROPIC_API_KEY` before any injected
 * `createModelPort` override ever runs (`requireModelConfig`), but neither
 * `createFullRunModelPort` nor `createHoldingModelPort` below ever sends it
 * anywhere — assembled from parts rather than written as one literal, following
 * this repository's own convention for a credential SHAPE a fixture needs (see
 * registry-store.live.mjs's "a note on the fixture values below").
 */
export const modelKeyShape = ['not', 'a', 'real', 'anthropic', 'key', 'shape'].join('-');

export const BAD_DEPLOYMENT_SCENARIO = LIVE_SCENARIOS.find((scenario) => scenario.id === 'bad-deployment');
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
 *
 * `holdAfter(count)` marks every observation request from the `count`-th
 * (0-based, `/health` excluded) onward as held: the handler neither answers
 * it nor drops it, it just never calls `response.end()`, so the requester's
 * own fetch stays pending until `release()` answers every request currently
 * held and turns future requests back into ordinary immediate answers.
 */
export function createStubLab(scenario) {
  const outputByToolId = new Map(scenario.observations.map((observation) => [observation.toolId, observation.output]));
  const requestCounts = new Map();
  let denyAll = false;
  let holdThreshold = Infinity;
  let observationIndex = 0;
  const pending = [];
  let server;

  function respond(request, response) {
    if (denyAll) {
      response.writeHead(403, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'denied' }));
      return;
    }
    const toolId = request.url.replace(/^\/observations\//, '').split('?')[0];
    const output = outputByToolId.get(toolId) ?? [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(output));
  }

  const handler = (request, response) => {
    requestCounts.set(request.url, (requestCounts.get(request.url) ?? 0) + 1);
    if (request.url === '/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
      return;
    }
    const index = observationIndex;
    observationIndex += 1;
    if (index >= holdThreshold) {
      // A killed requester's socket errors when the process dies; swallow it
      // so the stub's own server process never sees an unhandled 'error'.
      response.on('error', () => {});
      pending.push({ request, response });
      return;
    }
    respond(request, response);
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
    /** Requests for evidence only — `/health` is not a tool call. */
    observationRequests() {
      let total = 0;
      for (const [url, count] of requestCounts) if (url !== '/health') total += count;
      return total;
    },
    /** Every observation request from this 0-based index onward is held open rather than answered, until release() is called. Requests before it answer normally, exactly as when holdAfter is never called at all. */
    holdAfter(count) {
      holdThreshold = count;
    },
    /** Requests currently held open, awaiting release() or a kill of the requester that sent them. */
    heldCount() {
      return pending.length;
    },
    /** The exact `url` (path plus query) of every request currently held open. */
    heldUrls() {
      return pending.map(({ request }) => request.url);
    },
    /** Answers every currently held request normally and stops holding future ones. */
    release() {
      holdThreshold = Infinity;
      const toRelease = pending.splice(0, pending.length);
      for (const { request, response } of toRelease) respond(request, response);
    },
    /** A snapshot of every `url` seen so far and how many times, independent of hold/release state. */
    urlCounts() {
      return Object.fromEntries(requestCounts);
    },
  };
}

export function jsonCompletion(document) {
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
export function createFullRunModelPort() {
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
 * `createFullRunModelPort`, except every call from the `holdAfterCalls`-th
 * onward (1-based: `holdAfterCalls = 1` answers the first call and holds the
 * second) never resolves at all, so whatever role made that call stays
 * pending forever — the same convention `postgres-run-worker.mjs`'s own
 * `start-hang` mode documents (AIC-68): a promise with nothing else pending
 * would let the process exit on its own before a kill lands, so a held call
 * refs the IPC channel first. `holdAfterCalls = Infinity` (the default) never
 * holds at all.
 */
export function createHoldingModelPort(holdAfterCalls = Infinity) {
  const inner = createFullRunModelPort();
  let count = 0;
  return {
    calls: inner.calls,
    async complete(request) {
      count += 1;
      if (count > holdAfterCalls) {
        if (typeof process.channel?.ref === 'function') process.channel.ref();
        await new Promise(() => {});
      }
      return inner.complete(request);
    },
  };
}

/**
 * Onboards one Service/Environment/SourceBinding/Incident through the real
 * spawned CLI, and returns the ids the test needs. Each row calls this after
 * its own `dropSchemas` + `aic db migrate`, so distinct rows never share
 * registry state even though they share one PostgreSQL container.
 */
export function onboard(connectionString, baseUrl) {
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
export function sortKeysDeep(value) {
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

export function handComputedRequestFingerprint(operation, input) {
  const envelope = JSON.stringify(sortKeysDeep({ input, operation }));
  return `sha256:${createHash('sha256').update(envelope).digest('hex')}`;
}
