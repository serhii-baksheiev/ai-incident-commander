/**
 * The child process AIC-146 c5b's kill/resume rows restart: a separate OS
 * process that runs `aic incident investigate --roles model` over a REAL
 * PostgreSQL substrate and a REAL lab@1 stub (owned by the parent test, not
 * this process), exactly the way the real `aic` binary would, but importing
 * the built `createIncidentInvestigateDeps` / `runIncidentInvestigateCommand`
 * seam directly rather than spawning the CLI binary a second time — so the
 * fake model port below can be injected without a paid call, the same
 * convention `incident-investigate.live.mjs`'s own "end to end" row uses for
 * its in-process run, applied here to a process the test can SIGKILL.
 *
 * Like `postgres-run-worker.mjs`, this file has no side effect on import: it
 * reads argv, and runs `main()` only when `process.send` exists, so it is
 * inert to any test runner that picks it up as a file.
 *
 * argv: `<incidentId> <baseUrl> [holdModelAfterCalls]`
 *
 *   incidentId            the already-onboarded incident's id (the parent
 *                         onboarded it through the real CLI before spawning)
 *   baseUrl               the parent's own lab@1 stub's base URL — this
 *                         process makes real HTTP requests against it,
 *                         exactly like the real bound executor would
 *   holdModelAfterCalls   optional; when given, every model-port `complete()`
 *                         call from the (n+1)-th onward never resolves (see
 *                         `createHoldingModelPort` in the shared fixture) —
 *                         omitted or "none" means the port never holds
 *
 * `AIC_POSTGRES_URL` and `ANTHROPIC_API_KEY` come from `childEnv`, exactly as
 * every sibling worker in this directory requires them.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [, , incidentId, baseUrl, holdModelAfterArg] = process.argv;

const fixturesDir = dirname(fileURLToPath(import.meta.url));
const depsModulePath = resolve(fixturesDir, '../../../../apps/cli/dist/commands/incident-investigate-deps.js');
const investigateCommandModulePath = resolve(fixturesDir, '../../../../apps/cli/dist/commands/incident-investigate.js');
const sharedFixturePath = resolve(fixturesDir, 'incident-investigate-shared.mjs');

function requireEnvVar(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(
      `${name} is not set in this child process: the parent must pass it through childEnv({ ${name} }), because the allow-list forwards nothing it is not told to`,
    );
  }
  return value;
}

function parseHoldModelAfter(value) {
  if (value === undefined || value === 'none') return Infinity;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`holdModelAfterCalls must be a non-negative number or "none", got: ${JSON.stringify(value)}`);
  }
  return parsed;
}

async function main() {
  if (typeof incidentId !== 'string' || incidentId === '') {
    throw new Error('incident-investigate-worker.mjs requires <incidentId> as its first argument');
  }
  if (typeof baseUrl !== 'string' || baseUrl === '') {
    throw new Error('incident-investigate-worker.mjs requires <baseUrl> as its second argument');
  }
  const holdModelAfter = parseHoldModelAfter(holdModelAfterArg);

  const connectionString = requireEnvVar('AIC_POSTGRES_URL');
  const modelKeyShapeValue = requireEnvVar('ANTHROPIC_API_KEY');
  void modelKeyShapeValue; // read only so requireModelConfig's own check finds it; never sent anywhere.

  const { createIncidentInvestigateDeps } = await import(depsModulePath);
  const { runIncidentInvestigateCommand } = await import(investigateCommandModulePath);
  const { createHoldingModelPort } = await import(sharedFixturePath);

  const env = { AIC_POSTGRES_URL: connectionString, ANTHROPIC_API_KEY: modelKeyShapeValue };
  const { deps, close } = createIncidentInvestigateDeps(env, {
    createModelPort: () => createHoldingModelPort(holdModelAfter),
    workerId: `worker-kill-${process.pid}`,
  });

  try {
    await runIncidentInvestigateCommand(['checkout', 'staging', incidentId, '--roles', 'model'], deps);
  } finally {
    await close().catch(() => {});
  }
  process.send({ type: 'completed' }, () => process.exit(0));
}

if (typeof process.send === 'function') {
  main().catch((error) => {
    process.send(
      {
        type: 'worker-error',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      },
      () => process.exit(1),
    );
  });
}
