import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as graph from '@aic/graph';
import * as observability from '@aic/observability';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

// A credential SHAPE, assembled at runtime and never written as a literal —
// `.claude/rules/autonomy.md` ("Never") requires it of any fixture that needs one.
const fakeKeyBody = 'f'.repeat(32);
const fakeTracingValue = ['lsv2', 'pt', fakeKeyBody].join('_');

const TRACING_VARIABLES = [
  'LANGSMITH_TRACING',
  'LANGSMITH_API_KEY',
  'LANGSMITH_PROJECT',
  'LANGSMITH_ENDPOINT',
  'LANGCHAIN_TRACING_V2',
  'LANGCHAIN_API_KEY',
  'LANGCHAIN_PROJECT',
  'LANGCHAIN_ENDPOINT',
];

function requireFunction(packageNamespace, name, packageName) {
  assert.equal(
    typeof packageNamespace[name],
    'function',
    `${packageName} must export ${name}`,
  );
  return packageNamespace[name];
}

function resolveTracingConfig(env) {
  return requireFunction(
    observability,
    'resolveTracingConfig',
    '@aic/observability',
  )(env);
}

function buildInvocationConfig(input) {
  return requireFunction(graph, 'buildInvocationConfig', '@aic/graph')(input);
}

/** A process env with every tracing variable cleared, then the overrides applied. */
function tracingEnv(overrides) {
  const env = { ...process.env };
  for (const variable of TRACING_VARIABLES) delete env[variable];
  return { ...env, ...overrides };
}

function commandDiagnostics(args, result) {
  return `${process.execPath} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

/**
 * Runs the compiled CLI asynchronously — `spawnSync` would block this process's
 * event loop, and the ingest sink below serves from it.
 */
function runCli(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timeout = setTimeout(() => child.kill('SIGKILL'), 20_000);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('close', (status, signal) => {
      clearTimeout(timeout);
      resolveRun({ status, signal, stdout, stderr });
    });
  });
}

/** A local sink standing in for the LangSmith ingest endpoint — no network leaves the box. */
function startIngestSink() {
  const server = createServer((request, response) => {
    request.on('data', () => {});
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  server.unref();
  return new Promise((resolveServer) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveServer({
        endpoint: `http://127.0.0.1:${port}`,
        close: () => new Promise((closed) => server.close(closed)),
      });
    });
  });
}

test('reports tracing disabled when LANGSMITH_TRACING is unset', () => {
  const config = resolveTracingConfig({});

  assert.equal(
    config.enabled,
    false,
    'an env without LANGSMITH_TRACING must resolve to disabled tracing',
  );
});

test('enables tracing for both "true" and "1" and carries the configured project', () => {
  for (const flag of ['true', '1']) {
    const config = resolveTracingConfig({
      LANGSMITH_TRACING: flag,
      LANGSMITH_API_KEY: fakeTracingValue,
      LANGSMITH_PROJECT: 'aic-v0.1',
    });

    assert.equal(config.enabled, true, `LANGSMITH_TRACING=${flag} must enable tracing`);
    assert.equal(config.project, 'aic-v0.1');
  }
});

test('falls back to the LangSmith default project when none is configured', () => {
  const config = resolveTracingConfig({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: fakeTracingValue,
  });

  assert.equal(config.enabled, true);
  assert.equal(
    config.project,
    'default',
    'an absent LANGSMITH_PROJECT must resolve to the project LangSmith itself defaults to',
  );
});

test('reports tracing disabled for LANGSMITH_TRACING=false even with an api key present', () => {
  const config = resolveTracingConfig({
    LANGSMITH_TRACING: 'false',
    LANGSMITH_API_KEY: fakeTracingValue,
    LANGSMITH_PROJECT: 'aic-v0.1',
  });

  assert.equal(
    config.enabled,
    false,
    'an explicit false must disable tracing regardless of the rest of the env',
  );
});

test('refuses enabled tracing without an api key and names the missing variable', () => {
  assert.throws(
    () => resolveTracingConfig({ LANGSMITH_TRACING: 'true', LANGSMITH_PROJECT: 'aic-v0.1' }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(
        error.message,
        /LANGSMITH_API_KEY/,
        'the refusal must name the missing variable rather than tracing silently off',
      );
      return true;
    },
  );
});

test('accepts LANGCHAIN_API_KEY as the api key fallback', () => {
  const config = resolveTracingConfig({
    LANGSMITH_TRACING: 'true',
    LANGCHAIN_API_KEY: fakeTracingValue,
    LANGSMITH_PROJECT: 'aic-v0.1',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.project, 'aic-v0.1');
});

test('never carries the api key value into the resolved tracing config', () => {
  for (const variable of ['LANGSMITH_API_KEY', 'LANGCHAIN_API_KEY']) {
    const config = resolveTracingConfig({
      LANGSMITH_TRACING: 'true',
      [variable]: fakeTracingValue,
      LANGSMITH_PROJECT: 'aic-v0.1',
    });
    const serialised = JSON.stringify(config);

    assert.equal(
      serialised.includes(fakeTracingValue),
      false,
      `the config resolved from ${variable} must not carry the credential`,
    );
    assert.equal(
      serialised.includes(fakeKeyBody),
      false,
      `the config resolved from ${variable} must not carry a fragment of the credential`,
    );
  }
});

test('reads only its argument and never process.env', () => {
  const saved = Object.fromEntries(
    TRACING_VARIABLES.map((variable) => [variable, process.env[variable]]),
  );

  try {
    process.env.LANGSMITH_TRACING = 'true';
    process.env.LANGSMITH_API_KEY = fakeTracingValue;
    process.env.LANGSMITH_PROJECT = 'ambient-project';

    const config = resolveTracingConfig({});

    assert.equal(
      config.enabled,
      false,
      'an ambient process.env must not enable tracing for an env argument that does not',
    );
  } finally {
    for (const [variable, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[variable];
      else process.env[variable] = value;
    }
  }
});

test('builds the unchanged thread-only invocation config when no trace is requested', () => {
  assert.deepEqual(
    buildInvocationConfig({ runId: 'run-1' }),
    { configurable: { thread_id: 'run-1' } },
    'the untraced config must stay byte-for-byte what checkpoint resume already relies on',
  );
});

test('keeps configurable.thread_id equal to the runId when a trace is attached', () => {
  const config = buildInvocationConfig({
    runId: 'run-2',
    trace: {
      runName: 'aic-investigation',
      project: 'aic-v0.1',
      tags: ['aic'],
      metadata: { scenarioId: 'scenario-1' },
    },
  });

  assert.equal(
    config.configurable.thread_id,
    'run-2',
    'tracing must never displace the thread_id checkpoint resume reads',
  );
});

test('carries the run name, tags and runId metadata of the requested trace', () => {
  const config = buildInvocationConfig({
    runId: 'run-3',
    trace: {
      runName: 'aic-investigation',
      project: 'aic-v0.1',
      tags: ['aic', 'v0.1'],
      metadata: { scenarioId: 'scenario-1' },
    },
  });

  assert.equal(config.runName, 'aic-investigation');
  assert.deepEqual(config.tags, ['aic', 'v0.1']);
  assert.equal(
    config.metadata.runId,
    'run-3',
    'a traced run must be findable in LangSmith by the runId it was started with',
  );
  assert.equal(config.metadata.scenarioId, 'scenario-1');
});

test('merges caller metadata without letting it overwrite the runId', () => {
  const config = buildInvocationConfig({
    runId: 'run-4',
    trace: { metadata: { runId: 'impostor-run', scenarioId: 'scenario-2' } },
  });

  assert.equal(
    config.metadata.runId,
    'run-4',
    'caller metadata must not be able to relabel the run it belongs to',
  );
  assert.equal(config.metadata.scenarioId, 'scenario-2');
  assert.equal(config.configurable.thread_id, 'run-4');
});

test('leaves the caller trace metadata object unmutated', () => {
  const metadata = { scenarioId: 'scenario-3' };
  const trace = { runName: 'aic-investigation', metadata };

  buildInvocationConfig({ runId: 'run-5', trace });

  assert.deepEqual(
    metadata,
    { scenarioId: 'scenario-3' },
    'building a config must not write the runId back into the caller metadata',
  );
});

test('refuses to start when tracing is enabled without an api key', { timeout: 30_000 }, async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-tracing-no-key-'));
  const sink = await startIngestSink();

  try {
    const args = [
      cliPath,
      'start',
      '--run-id',
      'run-tracing-no-key',
      '--checkpoint',
      join(temporaryRoot, 'checkpoints.sqlite'),
    ];
    const executed = await runCli(
      args,
      tracingEnv({
        LANGSMITH_TRACING: 'true',
        LANGSMITH_PROJECT: 'aic-v0.1',
        LANGSMITH_ENDPOINT: sink.endpoint,
        LANGCHAIN_ENDPOINT: sink.endpoint,
      }),
    );

    assert.notEqual(
      executed.status,
      0,
      `tracing requested without a key must fail loudly, not run untraced\n${commandDiagnostics(args, executed)}`,
    );
    assert.match(
      executed.stderr,
      /LANGSMITH_API_KEY/,
      commandDiagnostics(args, executed),
    );
  } finally {
    await sink.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('never prints the api key on stdout or stderr', { timeout: 30_000 }, async () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-tracing-cli-'));
  const sink = await startIngestSink();
  const runId = 'run-tracing-cli';

  try {
    const args = [
      cliPath,
      'start',
      '--run-id',
      runId,
      '--checkpoint',
      join(temporaryRoot, 'checkpoints.sqlite'),
    ];
    const executed = await runCli(
      args,
      tracingEnv({
        LANGSMITH_TRACING: 'true',
        LANGSMITH_API_KEY: fakeTracingValue,
        LANGCHAIN_API_KEY: fakeTracingValue,
        LANGSMITH_PROJECT: 'aic-v0.1',
        LANGSMITH_ENDPOINT: sink.endpoint,
        LANGCHAIN_ENDPOINT: sink.endpoint,
      }),
    );

    assert.equal(executed.status, 0, commandDiagnostics(args, executed));
    assert.equal(JSON.parse(executed.stdout).runId, runId);

    for (const [stream, text] of [
      ['stdout', executed.stdout],
      ['stderr', executed.stderr],
    ]) {
      assert.equal(
        text.includes(fakeTracingValue),
        false,
        `${stream} must never carry the api key value`,
      );
      assert.equal(
        text.includes(fakeKeyBody),
        false,
        `${stream} must never carry a fragment of the api key value`,
      );
    }
  } finally {
    await sink.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
