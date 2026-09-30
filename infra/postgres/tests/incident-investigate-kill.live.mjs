/**
 * AIC-146 sub-slice c5b: "kills and resumes the run without a second tool
 * call for a committed request" — the acceptance row c5a's own header leaves
 * to this file. Every helper this file drives (CLI onboarding, the stub lab,
 * the fake model port, and the built `createIncidentInvestigateDeps` /
 * `runIncidentInvestigateCommand` seam) is the exact one
 * `incident-investigate.live.mjs` (c5a) already pins, imported from
 * `fixtures/incident-investigate-shared.mjs` rather than copied
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * The FIRST run of every row below is a real spawned child process
 * (`fixtures/incident-investigate-worker.mjs`), so a kill is a real SIGKILL
 * of a real OS process rather than an in-process abort that could still be
 * reading state this test's own memory holds. The stub lab that process
 * talks to is owned by THIS file, not the child, and survives the kill — so
 * "release the stub" changes what the *next* request gets, independent of
 * whichever process sends it. The RESUME half of every row runs in-process
 * via `createIncidentInvestigateDeps`, the same convention
 * `incident-investigate.live.mjs`'s own "end to end" row uses, needing no
 * second spawn.
 *
 * ## The independent oracle
 *
 * Every "was this committed / called again" claim is read one of two ways,
 * never trusted from the resumed run's own summary alone:
 *   - a raw SQL query against `aic_app.node_results` / `run_trials` /
 *     `run_evidence` (`pool.query`, never through the command's own read
 *     path) for the tool-call rows;
 *   - the stub lab's own per-URL request counter, and the fresh in-process
 *     model port's own recorded `calls` (matched by the same role-identifying
 *     system-prompt substrings `createFullRunModelPort` uses), for the model
 *     role row — plus, for row 3, the key `generate_hypotheses`'s first call
 *     commits under, built by `@aic/domain`'s `buildExecKey` from parts the
 *     test chooses (with `@aic/roles`'s `REFERENCE_PROMPT_VERSION`), rather
 *     than read back from the database.
 *
 * Every synchronisation point below is a bounded poll (60s deadline, a named
 * failure message on timeout) against one of these same oracles — never a
 * fixed sleep, and the poll aborts immediately, with full spawn diagnostics,
 * the moment the worker child exits before the condition it was supposed to
 * reach.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5450 docker compose --project-name aic146c5b \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5450/aic \
 *     node --import ./test/fixtures/no-ambient-tracing.mjs --test \
 *     --test-concurrency=1 infra/postgres/tests/incident-investigate-kill.live.mjs
 *   docker compose --project-name aic146c5b \
 *     --file infra/postgres/compose.yaml down --volumes
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';

import { Pool } from 'pg';

import { buildExecKey } from '@aic/domain';
import { REFERENCE_PROMPT_VERSION } from '@aic/roles';

import { childEnv } from '../../../test/fixtures/child-env.mjs';
import {
  BAD_DEPLOYMENT_SCENARIO,
  CONNECTION_VARIABLE,
  createFullRunModelPort,
  createStubLab,
  depsModulePath,
  dropSchemas,
  investigateCommandModulePath,
  modelKeyShape,
  onboard,
  provisionCheckpointerSchema,
  requireConnectionString as sharedRequireConnectionString,
  runCliOk,
  workerPath,
} from './fixtures/incident-investigate-shared.mjs';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5450 docker compose --project-name aic146c5b --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5450/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place a real SIGKILL of
\`aic incident investigate\` mid-tool-call, and mid-model-call, is measured
against a real PostgreSQL substrate and a real lease takeover — a skip here
would report "kills and resumes without a second call" as met with nothing
actually killed.`;

function requireConnectionString() {
  return sharedRequireConnectionString(START_THE_SUBSTRATE);
}

/**
 * `BAD_DEPLOYMENT_SCENARIO`'s own canned observations cover only the
 * `deployments` and `logs` tool ids; `deployment-regression`'s own two
 * prediction templates (`packages/graph/src/prediction-templates.ts`) plan a
 * `deployments` test and a `metrics` test, and the row below needs evidence
 * from BOTH of the two requests it makes, so this adds one synthetic
 * `metrics` observation alongside the scenario's own real `deployments` one
 * — never replacing it, and never touching `incident-lab/` itself. The shape
 * (`kind: 'metric'`, the fields `EvidenceSchema` requires beyond `id`/
 * `trialId`, which the node itself derives) mirrors the scenario's own
 * `deployments`/`logs` entries exactly.
 */
const KILL_ROW_SCENARIO = {
  ...BAD_DEPLOYMENT_SCENARIO,
  observations: [
    ...BAD_DEPLOYMENT_SCENARIO.observations,
    {
      toolId: 'metrics',
      input: { service: 'checkout', window: 'incident', metric: 'error-rate' },
      output: [
        {
          id: 'checkout-metrics-error-rate-elevated',
          trialId: 'trial-checkout-metrics-error-rate-elevated',
          kind: 'metric',
          source: 'metrics/checkout',
          observedAt: '2026-08-26T15:05:00.000Z',
          statement: 'checkout error rate rose during the incident window',
          rawRef: 'replay://metrics/checkout/error-rate-elevated',
        },
      ],
      owner: 'api',
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Spawning the worker — copied in shape from durable-tool-replay.live.mjs    */
/* -------------------------------------------------------------------------- */

function spawnWorker(args, connectionString) {
  const child = spawn(process.execPath, [workerPath, ...args], {
    cwd: process.cwd(),
    env: childEnv({ [CONNECTION_VARIABLE]: connectionString, ANTHROPIC_API_KEY: modelKeyShape }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let stdout = '';
  let stderr = '';
  const messages = [];
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  child.on('message', (message) => messages.push(message));
  return { child, messages, diagnostics: () => `stdout:\n${stdout}\nstderr:\n${stderr}` };
}

function workerErrorMessage(worker) {
  const found = worker.messages.find((message) => message?.type === 'worker-error');
  if (found === undefined) return undefined;
  return `${found.message}\n${found.stack ?? ''}\n${worker.diagnostics()}`;
}

function waitForExit(worker, timeoutMs = 20_000) {
  const { child, diagnostics } = worker;
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`worker did not exit within ${timeoutMs}ms\n${diagnostics()}`));
    }, timeoutMs);
    function onExit(code, signal) {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    }
    child.once('exit', onExit);
    child.once('error', reject);
  });
}

function killIfAlive(worker) {
  if (worker && worker.child.exitCode === null && worker.child.signalCode === null) {
    worker.child.kill('SIGKILL');
  }
}

/**
 * Polls `check` (which may itself be async) until it returns true, aborting
 * immediately — never waiting out the rest of the deadline — the moment
 * `worker` has already exited, since a condition this file waits for is
 * always something the STILL-RUNNING worker is supposed to reach. Never a
 * fixed sleep: the interval is only how often the oracle is re-read.
 */
async function waitUntil(worker, check, { timeoutMs = 60_000, intervalMs = 100, step }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) {
      const workerError = workerErrorMessage(worker);
      throw new Error(
        `worker exited before reaching "${step}" (code=${worker.child.exitCode} signal=${worker.child.signalCode})` +
          (workerError !== undefined ? `\n${workerError}` : `\n${worker.diagnostics()}`),
      );
    }
    if (await check()) return;
    if (Date.now() >= deadline) {
      const workerError = workerErrorMessage(worker);
      throw new Error(
        `timed out after ${timeoutMs}ms waiting for "${step}"\n${worker.diagnostics()}` +
          (workerError !== undefined ? `\n${workerError}` : ''),
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
}

/* -------------------------------------------------------------------------- */
/* Shared row setup                                                           */
/* -------------------------------------------------------------------------- */

async function setUpRow(t) {
  const connectionString = requireConnectionString();
  const pool = new Pool({ connectionString });
  t.after(() => pool.end());
  await dropSchemas(pool);
  runCliOk(['db', 'migrate'], connectionString);
  await provisionCheckpointerSchema(connectionString);

  const stub = createStubLab(KILL_ROW_SCENARIO);
  const baseUrl = await stub.start();
  t.after(() => stub.stop());

  const { incidentId } = onboard(connectionString, baseUrl);

  return { connectionString, pool, stub, baseUrl, incidentId };
}

async function countToolTrialRows(pool, runId) {
  const { rows } = await pool.query(
    "select count(*)::int as n from aic_app.node_results where run_id = $1 and op = 'tool.trial'",
    [runId],
  );
  return rows[0].n;
}

async function currentRunId(pool) {
  const { rows } = await pool.query('select run_id from aic_app.runs');
  return rows.length === 1 ? rows[0].run_id : undefined;
}

async function forceExpireLease(pool, runId) {
  await pool.query(
    `update aic_app.runs set lease_expires_at = clock_timestamp() - interval '1 second' where run_id = $1`,
    [runId],
  );
}

async function runStatus(pool, runId) {
  const { rows } = await pool.query('select status from aic_app.runs where run_id = $1', [runId]);
  assert.equal(rows.length, 1, `expected exactly one aic_app.runs row for ${runId}`);
  return rows[0].status;
}

/* -------------------------------------------------------------------------- */
/* refuses rather than skips                                                  */
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
/* row 1: kill after a committed tool call                                   */
/* -------------------------------------------------------------------------- */

test(
  'kill after a committed tool call, resume without a second call for it',
  { timeout: 90_000 },
  async (t) => {
    const { connectionString, pool, stub, incidentId, baseUrl } = await setUpRow(t);

    // The FIRST planned test's observation request answers normally; every
    // one from the second (0-based index 1) onward is held open.
    stub.holdAfter(1);

    let worker;
    try {
      worker = spawnWorker([incidentId, baseUrl], connectionString);

      await waitUntil(
        worker,
        async () => (await currentRunId(pool)) !== undefined,
        { step: 'aic_app.runs row created' },
      );
      const runId = await currentRunId(pool);
      assert.notEqual(runId, undefined, 'the run row must exist once the worker has started');

      await waitUntil(
        worker,
        async () => (await countToolTrialRows(pool, runId)) >= 1 && stub.heldCount() >= 1,
        { step: 'first tool.trial committed and the second request held open' },
      );

      // Captured now, before the kill: the exec key(s) already committed at
      // this point — independent of anything the resumed run later adds,
      // since the run keeps making further tool calls (challenge rounds) all
      // the way to completion.
      const { rows: committedBeforeKill } = await pool.query(
        "select exec_key, produced_by_attempt from aic_app.node_results where run_id = $1 and op = 'tool.trial'",
        [runId],
      );
      assert.equal(
        committedBeforeKill.length,
        1,
        `expected exactly one tool.trial row committed before the kill, got: ${JSON.stringify(committedBeforeKill)}`,
      );
      assert.equal(Number(committedBeforeKill[0].produced_by_attempt), 1);

      assert.equal(worker.child.kill('SIGKILL'), true, 'the test must kill the worker process');
      const killed = await waitForExit(worker);
      assert.equal(
        killed.signal,
        'SIGKILL',
        `the worker exited on its own before the kill landed (code=${worker.child.exitCode})\n${worker.diagnostics()}`,
      );

      const heldUrlsAtKill = stub.heldUrls();
      assert.equal(heldUrlsAtKill.length, 1, `expected exactly one held request at kill time, got: ${JSON.stringify(heldUrlsAtKill)}`);
      const [heldUrl] = heldUrlsAtKill;

      // The request the stub answered before the kill — the one whose result
      // was committed — read from the stub's own counter, not the database.
      const answeredUrlsAtKill = Object.entries(stub.urlCounts())
        .filter(([url]) => url !== '/health' && url !== heldUrl)
        .map(([url]) => url);
      assert.equal(
        answeredUrlsAtKill.length,
        1,
        `expected exactly one answered evidence request at kill time, got: ${JSON.stringify(stub.urlCounts())}`,
      );
      const [answeredUrl] = answeredUrlsAtKill;

      await forceExpireLease(pool, runId);
      stub.release();

      const resumeModelPort = createFullRunModelPort();
      const stdoutLines = [];
      const { createIncidentInvestigateDeps } = await import(depsModulePath);
      const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);
      const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShape };
      const { deps, close } = createIncidentInvestigateDeps(env, {
        createModelPort: () => resumeModelPort,
        stdout: (text) => stdoutLines.push(text),
        workerId: `kill-row1-resume-${process.pid}`,
      });
      t.after(() => close());

      await runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'model'], deps);

      assert.equal(stdoutLines.length, 1, 'the resumed command must print exactly one summary line');
      const summary = JSON.parse(stdoutLines[0]);
      assert.equal(summary.runId, runId, 'the resumed run must keep the same runId');

      assert.equal(await runStatus(pool, runId), 'completed');

      // The run keeps investigating past this point (challenge rounds derive
      // further tests), so the WHOLE run's request/row counts only grow from
      // here — the acceptance this row proves is about the two requests that
      // were in flight at kill time specifically, read by URL (independent of
      // exec keys) and by the exec key captured before the kill.
      const urlCounts = stub.urlCounts();
      const [committedKeyBeforeKill] = committedBeforeKill;
      assert.equal(
        urlCounts[heldUrl],
        2,
        `the held, never-committed request (${heldUrl}) must have been fetched again after the kill, got: ${JSON.stringify(urlCounts)}`,
      );
      assert.equal(
        urlCounts[answeredUrl],
        1,
        `the request committed before the kill (${answeredUrl}) must not be fetched again by the resumed run, got: ${JSON.stringify(urlCounts)}`,
      );

      const { rows: keyRowAfterResume } = await pool.query(
        'select produced_by_attempt from aic_app.node_results where run_id = $1 and exec_key = $2',
        [runId, committedKeyBeforeKill.exec_key],
      );
      assert.equal(
        keyRowAfterResume.length,
        1,
        'the pre-kill committed tool.trial row must still be the only row for that exec key: no second call for it',
      );
      assert.equal(
        Number(keyRowAfterResume[0].produced_by_attempt),
        1,
        'the pre-kill committed tool.trial row must keep produced_by_attempt 1, never rewritten by the resumed attempt',
      );

      const { rows: nodeResultRows } = await pool.query(
        "select exec_key from aic_app.node_results where run_id = $1 and op = 'tool.trial'",
        [runId],
      );
      assert.equal(
        new Set(nodeResultRows.map((row) => row.exec_key)).size,
        nodeResultRows.length,
        `expected no duplicate node_results row for any tool.trial key across the whole run, got: ${JSON.stringify(nodeResultRows)}`,
      );
      assert.ok(
        nodeResultRows.length >= 2,
        'expected at least the two tool.trial rows from before the kill (one already committed, one committed after resume)',
      );

      const { rows: trialRows } = await pool.query('select trial_id, body from aic_app.run_trials where run_id = $1', [runId]);
      assert.ok(trialRows.length >= 2, 'expected at least one run_trials row per planned test, including the two from before the kill');
      for (const row of trialRows) {
        const trial = JSON.parse(row.body);
        assert.equal(trial.status, 'ok', `expected an ok trial, got: ${JSON.stringify(trial)}`);
      }

      const { rows: evidenceRows } = await pool.query('select trial_id from aic_app.run_evidence where run_id = $1', [runId]);
      const evidenceTrialIds = new Set(evidenceRows.map((row) => row.trial_id));
      assert.ok(
        evidenceTrialIds.size >= 2,
        `expected evidence recorded against at least both of the pre-kill trials, got evidence for: ${JSON.stringify([...evidenceTrialIds])}`,
      );
      assert.ok(
        Array.isArray(summary.evidence) && summary.evidence.length === evidenceRows.length,
        `the summary's own evidence count must equal aic_app.run_evidence's row count, got summary=${summary.evidence?.length} rows=${evidenceRows.length}`,
      );
    } finally {
      killIfAlive(worker);
    }
  },
);

/* -------------------------------------------------------------------------- */
/* row 2: kill while the only request is in flight                           */
/* -------------------------------------------------------------------------- */

test(
  'kill while the only request is in flight',
  { timeout: 90_000 },
  async (t) => {
    const { connectionString, pool, stub, incidentId, baseUrl } = await setUpRow(t);

    // Every observation request from the very first (0-based index 0) is
    // held open — there is only ever one request in flight at a time, so
    // this holds exactly the first and only request this run makes before
    // the kill.
    stub.holdAfter(0);

    let worker;
    try {
      worker = spawnWorker([incidentId, baseUrl], connectionString);

      await waitUntil(
        worker,
        async () => (await currentRunId(pool)) !== undefined,
        { step: 'aic_app.runs row created' },
      );
      const runId = await currentRunId(pool);
      assert.notEqual(runId, undefined, 'the run row must exist once the worker has started');

      await waitUntil(worker, async () => stub.heldCount() >= 1, { step: 'the only request held open' });
      assert.equal(
        await countToolTrialRows(pool, runId),
        0,
        'no tool.trial row may exist yet: the only request in flight must not have committed',
      );

      assert.equal(worker.child.kill('SIGKILL'), true, 'the test must kill the worker process');
      const killed = await waitForExit(worker);
      assert.equal(
        killed.signal,
        'SIGKILL',
        `the worker exited on its own before the kill landed (code=${worker.child.exitCode})\n${worker.diagnostics()}`,
      );

      const heldUrlsAtKill = stub.heldUrls();
      assert.equal(heldUrlsAtKill.length, 1, `expected exactly one held request at kill time, got: ${JSON.stringify(heldUrlsAtKill)}`);
      const [heldUrl] = heldUrlsAtKill;

      await forceExpireLease(pool, runId);
      stub.release();

      const resumeModelPort = createFullRunModelPort();
      const stdoutLines = [];
      const { createIncidentInvestigateDeps } = await import(depsModulePath);
      const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);
      const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShape };
      const { deps, close } = createIncidentInvestigateDeps(env, {
        createModelPort: () => resumeModelPort,
        stdout: (text) => stdoutLines.push(text),
        workerId: `kill-row2-resume-${process.pid}`,
      });
      t.after(() => close());

      await runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'model'], deps);

      assert.equal(stdoutLines.length, 1, 'the resumed command must print exactly one summary line');
      const summary = JSON.parse(stdoutLines[0]);
      assert.equal(summary.runId, runId, 'the resumed run must keep the same runId');
      assert.equal(await runStatus(pool, runId), 'completed');

      const urlCounts = stub.urlCounts();
      assert.equal(
        urlCounts[heldUrl],
        2,
        `the held request (${heldUrl}) must have been fetched again after the kill, since it was never committed, got: ${JSON.stringify(urlCounts)}`,
      );

      const { rows: nodeResultRows } = await pool.query(
        "select exec_key, produced_by_attempt from aic_app.node_results where run_id = $1 and op = 'tool.trial'",
        [runId],
      );
      assert.equal(
        new Set(nodeResultRows.map((row) => row.exec_key)).size,
        nodeResultRows.length,
        `expected no duplicate node_results row for any tool.trial key, got: ${JSON.stringify(nodeResultRows)}`,
      );
      assert.ok(nodeResultRows.length >= 1, 'expected at least the one committed tool.trial row for the resumed request');
    } finally {
      killIfAlive(worker);
    }
  },
);

/* -------------------------------------------------------------------------- */
/* row 3: model roles                                                        */
/* -------------------------------------------------------------------------- */

test(
  'a committed model.role answer is not asked again after a kill',
  { timeout: 90_000 },
  async (t) => {
    const { connectionString, pool, incidentId, baseUrl } = await setUpRow(t);

    let worker;
    try {
      // Answers the first model-role call (generate_hypotheses) normally and
      // commits it, then never resolves the second (interpret_residual_evidence) —
      // no tool call happens before either, so the stub is never involved.
      worker = spawnWorker([incidentId, baseUrl, '1'], connectionString);

      await waitUntil(
        worker,
        async () => (await currentRunId(pool)) !== undefined,
        { step: 'aic_app.runs row created' },
      );
      const runId = await currentRunId(pool);
      assert.notEqual(runId, undefined, 'the run row must exist once the worker has started');

      await waitUntil(
        worker,
        async () => {
          const { rows } = await pool.query(
            "select count(*)::int as n from aic_app.node_results where run_id = $1 and op = 'model.role'",
            [runId],
          );
          return Number(rows[0].n) >= 1;
        },
        { step: 'the first model.role answer committed' },
      );

      const expectedFirstRoleKey = buildExecKey('model.role', {
        runId,
        role: 'generate_hypotheses',
        promptVersion: REFERENCE_PROMPT_VERSION,
        iterationsUsed: 0,
        challengeRounds: 0,
        resumeCount: 0,
      });
      const { rows: committedBeforeKill } = await pool.query(
        "select exec_key, produced_by_attempt from aic_app.node_results where run_id = $1 and op = 'model.role'",
        [runId],
      );
      assert.deepEqual(
        committedBeforeKill.map((row) => row.exec_key),
        [expectedFirstRoleKey],
        `expected exactly the independently-derived generate_hypotheses exec key to be committed before the kill, got: ${JSON.stringify(committedBeforeKill)}`,
      );
      assert.equal(Number(committedBeforeKill[0].produced_by_attempt), 1);

      assert.equal(worker.child.kill('SIGKILL'), true, 'the test must kill the worker process');
      const killed = await waitForExit(worker);
      assert.equal(
        killed.signal,
        'SIGKILL',
        `the worker exited on its own before the kill landed (code=${worker.child.exitCode})\n${worker.diagnostics()}`,
      );

      await forceExpireLease(pool, runId);

      const resumeModelPort = createFullRunModelPort();
      const stdoutLines = [];
      const { createIncidentInvestigateDeps } = await import(depsModulePath);
      const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);
      const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShape };
      const { deps, close } = createIncidentInvestigateDeps(env, {
        createModelPort: () => resumeModelPort,
        stdout: (text) => stdoutLines.push(text),
        workerId: `kill-row3-resume-${process.pid}`,
      });
      t.after(() => close());

      await runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'model'], deps);

      assert.equal(stdoutLines.length, 1, 'the resumed command must print exactly one summary line');
      const summary = JSON.parse(stdoutLines[0]);
      assert.equal(summary.runId, runId, 'the resumed run must keep the same runId');
      assert.equal(await runStatus(pool, runId), 'completed');

      assert.ok(
        resumeModelPort.calls.every(
          (call) => !call.system.includes('Propose distinct, falsifiable causal hypotheses'),
        ),
        'the resumed run must never call the model port for the generate_hypotheses role again: its answer was already committed',
      );

      const { rows: keyRowAfterResume } = await pool.query(
        'select produced_by_attempt from aic_app.node_results where run_id = $1 and exec_key = $2',
        [runId, expectedFirstRoleKey],
      );
      assert.equal(keyRowAfterResume.length, 1, 'the pre-kill committed row must still be the only row for that exec key');
      assert.equal(
        Number(keyRowAfterResume[0].produced_by_attempt),
        1,
        'the pre-kill committed row must keep produced_by_attempt 1, never rewritten by the resumed attempt',
      );

      const { rows: allModelRoleRows } = await pool.query(
        "select count(*)::int as n from aic_app.node_results where run_id = $1 and op = 'model.role'",
        [runId],
      );
      assert.ok(
        Number(allModelRoleRows[0].n) > 1,
        'the resumed run must have made progress past generate_hypotheses (more model.role rows committed)',
      );
    } finally {
      killIfAlive(worker);
    }
  },
);
