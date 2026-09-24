import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as graph from '@aic/graph';
import * as observability from '@aic/observability';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

// A credential SHAPE, assembled at runtime and never written as a literal —
// `.claude/rules/autonomy.md` ("Never") requires it of any fixture that needs one.
const fakeKeyBody = 'f'.repeat(32);
const fakeTracingValue = ['lsv2', 'pt', fakeKeyBody].join('_');

/**
 * The flag names `@langchain/core`'s `isTracingEnabled` honours. Duplicated here
 * on purpose: reading the list from `@aic/observability` would make every test
 * below agree with the implementation by construction, including when the
 * implementation is wrong.
 */
const TRACING_FLAG_VARIABLES = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
];

/**
 * Values that look like an operator meant "on" and that the tracer does not
 * accept: it compares with `=== 'true'`. Resolving any of these to enabled is
 * the silently-untraced-run failure in its other direction — the run stops on a
 * missing key it never needed, or reports tracing the tracer never installed.
 */
const REJECTED_FLAG_VALUES = ['1', 'TRUE', 'True', 'yes', 'on', 'false', ''];

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

function commandDiagnostics(args, result) {
  return `${process.execPath} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

/**
 * Runs the compiled CLI asynchronously — `spawnSync` would block this process's
 * event loop, and the ingest sink below serves from it.
 */
function runCli(args, overrides) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: childEnv(overrides),
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

/**
 * A local sink standing in for the LangSmith ingest endpoint. It COUNTS every
 * request and KEEPS every body: a sink that discards both can only prove that
 * nothing crashed, which is what let a run with no trace wiring at all pass.
 */
function startIngestSink() {
  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        url: request.url ?? '',
        contentType: request.headers['content-type'],
        body: Buffer.concat(chunks),
      });
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
        requests,
        close: () => new Promise((closed) => server.close(closed)),
      });
    });
  });
}

/** Split one `multipart/form-data` body into its named parts. */
function multipartParts(request) {
  const boundary = /boundary=(?<boundary>[^;]+)/.exec(
    request.contentType ?? '',
  )?.groups?.boundary;
  assert.ok(
    boundary,
    `an ingest request must be multipart, got content-type: ${request.contentType}`,
  );
  const parts = new Map();
  for (const segment of request.body.toString('utf8').split(`--${boundary}`)) {
    const separator = segment.indexOf('\r\n\r\n');
    if (separator < 0) continue;
    const name = /name="(?<name>[^"]+)"/.exec(segment.slice(0, separator))
      ?.groups?.name;
    if (name === undefined) continue;
    parts.set(name, segment.slice(separator + 4).replace(/\r\n$/, ''));
  }
  return parts;
}

/**
 * The runs the CLI actually posted, as `{id, name, tags, parentRunId, metadata}`.
 *
 * The LangSmith ingest protocol carries one part per run (`post.<id>`) plus a
 * sibling part per field, of which `extra` holds the metadata — see the
 * multipart encoder in `langsmith/dist/client.js`.
 */
function ingestedRuns(sink) {
  const runs = [];
  for (const request of sink.requests) {
    if (!request.url.endsWith('/runs/multipart')) continue;
    const parts = multipartParts(request);
    for (const [name, value] of parts) {
      const id = /^post\.(?<id>[^.]+)$/.exec(name)?.groups?.id;
      if (id === undefined) continue;
      const payload = JSON.parse(value);
      const extra = parts.get(`post.${id}.extra`);
      runs.push({
        id: payload.id,
        name: payload.name,
        tags: payload.tags ?? [],
        parentRunId: payload.parent_run_id,
        metadata: extra === undefined ? {} : (JSON.parse(extra).metadata ?? {}),
      });
    }
  }
  return runs;
}

function runNamed(runs, name) {
  const found = runs.filter((run) => run.name === name);
  assert.equal(
    found.length,
    1,
    `expected exactly one ingested run named ${name}, got: ${JSON.stringify(runs.map((run) => run.name))}`,
  );
  return found[0];
}

/** A temporary checkpoint directory, removed however the test ends. */
async function withCheckpointDirectory(prefix, body) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(join(temporaryRoot, 'checkpoints.sqlite'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** A sink, closed however the test ends. */
async function withIngestSink(body) {
  const sink = await startIngestSink();
  try {
    return await body(sink);
  } finally {
    await sink.close();
  }
}

test('reports tracing disabled when no tracing flag is set', () => {
  const config = resolveTracingConfig({});

  assert.equal(
    config.enabled,
    false,
    'an env with no tracing flag must resolve to disabled tracing',
  );
});

test('enables tracing for every flag name the langchain tracer honours', () => {
  for (const flag of TRACING_FLAG_VARIABLES) {
    const config = resolveTracingConfig({
      [flag]: 'true',
      LANGSMITH_API_KEY: fakeTracingValue,
      LANGSMITH_PROJECT: 'aic-v0.1',
    });

    assert.equal(
      config.enabled,
      true,
      `${flag}=true installs the tracer, so it must resolve to enabled`,
    );
    assert.equal(config.project, 'aic-v0.1');
  }
});

test('reports tracing disabled for a flag value the langchain tracer rejects', () => {
  for (const flag of TRACING_FLAG_VARIABLES) {
    for (const value of REJECTED_FLAG_VALUES) {
      const config = resolveTracingConfig({
        [flag]: value,
        LANGSMITH_API_KEY: fakeTracingValue,
        LANGSMITH_PROJECT: 'aic-v0.1',
      });

      assert.equal(
        config.enabled,
        false,
        `${flag}=${JSON.stringify(value)} does not install the tracer, so it must resolve to disabled`,
      );
    }
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

test('accepts LANGCHAIN_PROJECT as the project fallback', () => {
  const config = resolveTracingConfig({
    LANGSMITH_TRACING: 'true',
    LANGSMITH_API_KEY: fakeTracingValue,
    LANGCHAIN_PROJECT: 'aic-legacy',
  });

  assert.equal(
    config.project,
    'aic-legacy',
    'the legacy project variable the SDK still reads must resolve the same way here',
  );
});

test('refuses enabled tracing without an api key and names the missing variable', () => {
  for (const flag of TRACING_FLAG_VARIABLES) {
    assert.throws(
      () => resolveTracingConfig({ [flag]: 'true', LANGSMITH_PROJECT: 'aic-v0.1' }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          /LANGSMITH_API_KEY/,
          `${flag}=true with no key must name the missing variable rather than tracing silently off`,
        );
        return true;
      },
    );
  }
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
  const ambient = [
    ...TRACING_FLAG_VARIABLES,
    'LANGSMITH_API_KEY',
    'LANGSMITH_PROJECT',
  ];
  const saved = Object.fromEntries(
    ambient.map((variable) => [variable, process.env[variable]]),
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

test('names an unnamed trace "investigation" rather than leaving it to LangGraph', () => {
  const config = buildInvocationConfig({
    runId: 'run-6',
    trace: { tags: ['aic'] },
  });

  assert.equal(
    config.runName,
    'investigation',
    'a trace without a run name must still be filterable by name in LangSmith',
  );
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

test(
  'makes no outbound call when no tracing flag is set',
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-tracing-offline-', async (checkpoint) => {
        const runId = 'run-tracing-offline';
        const args = [cliPath, 'dev', 'spike', 'start', '--run-id', runId, '--checkpoint', checkpoint];
        // The endpoint is pointed AT the sink on purpose: the run stays offline
        // because no flag enabled tracing, not because it had nowhere to send.
        const executed = await runCli(args, {
          LANGSMITH_API_KEY: fakeTracingValue,
          LANGSMITH_PROJECT: 'aic-v0.1',
          LANGSMITH_ENDPOINT: sink.endpoint,
          LANGCHAIN_ENDPOINT: sink.endpoint,
        });

        assert.equal(executed.status, 0, commandDiagnostics(args, executed));
        assert.equal(
          JSON.parse(executed.stdout).runId,
          runId,
          'the run must really have happened, or zero requests proves nothing',
        );
        assert.deepEqual(
          sink.requests.map((request) => `${request.method} ${request.url}`),
          [],
          'an untraced run must make no outbound call at all',
        );
      });
    });
  },
);

test(
  'sends a root run named for the command whose tags and runId every graph step inherits',
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-tracing-ingest-', async (checkpoint) => {
        const runId = 'run-tracing-ingest';
        const args = [cliPath, 'dev', 'spike', 'start', '--run-id', runId, '--checkpoint', checkpoint];
        const executed = await runCli(args, {
          LANGSMITH_TRACING: 'true',
          LANGSMITH_API_KEY: fakeTracingValue,
          LANGSMITH_PROJECT: 'aic-v0.1',
          LANGSMITH_ENDPOINT: sink.endpoint,
          LANGCHAIN_ENDPOINT: sink.endpoint,
        });

        assert.equal(executed.status, 0, commandDiagnostics(args, executed));

        const runs = ingestedRuns(sink);
        const root = runNamed(runs, 'aic-start');
        const step = runNamed(runs, 'execute_investigation');

        assert.equal(root.parentRunId, undefined, 'aic-start must be the root run');
        assert.deepEqual(
          root.tags,
          ['aic', 'aic-start'],
          'the root run must carry exactly the tags the CLI names it with',
        );
        assert.equal(
          root.metadata.runId,
          runId,
          'the root run must be findable by the runId it was started with',
        );

        assert.equal(
          step.parentRunId,
          root.id,
          'the graph step must hang off the root run, not start a second trace',
        );
        for (const tag of ['aic', 'aic-start']) {
          assert.ok(
            step.tags.includes(tag),
            `the graph step must inherit the tag ${tag}, got: ${JSON.stringify(step.tags)}`,
          );
        }
        assert.equal(
          step.metadata.runId,
          runId,
          'the graph step must inherit the runId metadata of the invocation',
        );
      });
    });
  },
);

test(
  'blocks background trace delivery so a short-lived run cannot exit before it sends',
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-tracing-flush-', async (checkpoint) => {
        const args = [
          cliPath,
          'dev',
          'spike',
          'start',
          '--run-id',
          'run-tracing-flush',
          '--checkpoint',
          checkpoint,
        ];
        const executed = await runCli(args, {
          LANGSMITH_TRACING: 'true',
          LANGSMITH_API_KEY: fakeTracingValue,
          LANGSMITH_PROJECT: 'aic-v0.1',
          LANGSMITH_ENDPOINT: sink.endpoint,
          LANGCHAIN_ENDPOINT: sink.endpoint,
        });

        assert.equal(executed.status, 0, commandDiagnostics(args, executed));
        // The SDK echoes the non-sensitive LANGSMITH_*/LANGCHAIN_* variables it
        // saw into every run's metadata, which is where the value the CLI chose
        // becomes observable from outside the process.
        assert.equal(
          runNamed(ingestedRuns(sink), 'aic-start').metadata
            .LANGCHAIN_CALLBACKS_BACKGROUND,
          'false',
          'a traced run of a process that exits immediately must send before it exits',
        );
      });
    });
  },
);

test(
  "keeps an operator's explicit LANGCHAIN_CALLBACKS_BACKGROUND value",
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-tracing-bg-', async (checkpoint) => {
        const args = [
          cliPath,
          'dev',
          'spike',
          'start',
          '--run-id',
          'run-tracing-bg',
          '--checkpoint',
          checkpoint,
        ];
        const executed = await runCli(args, {
          LANGSMITH_TRACING: 'true',
          LANGSMITH_API_KEY: fakeTracingValue,
          LANGSMITH_PROJECT: 'aic-v0.1',
          LANGSMITH_ENDPOINT: sink.endpoint,
          LANGCHAIN_ENDPOINT: sink.endpoint,
          LANGCHAIN_CALLBACKS_BACKGROUND: 'true',
        });

        assert.equal(executed.status, 0, commandDiagnostics(args, executed));
        assert.equal(
          runNamed(ingestedRuns(sink), 'aic-start').metadata
            .LANGCHAIN_CALLBACKS_BACKGROUND,
          'true',
          'the CLI may supply a default for this, never overrule the operator',
        );
      });
    });
  },
);

test(
  'refuses to start when tracing is enabled without an api key',
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-tracing-no-key-', async (checkpoint) => {
        const args = [
          cliPath,
          'dev',
          'spike',
          'start',
          '--run-id',
          'run-tracing-no-key',
          '--checkpoint',
          checkpoint,
        ];
        const executed = await runCli(args, {
          LANGSMITH_TRACING: 'true',
          LANGSMITH_PROJECT: 'aic-v0.1',
          LANGSMITH_ENDPOINT: sink.endpoint,
          LANGCHAIN_ENDPOINT: sink.endpoint,
        });

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
        // The refusal has to land BEFORE any work: the README states the run
        // stops "before any checkpoint is written", and only this assertion
        // holds that half of the claim. `createSqliteCheckpointer` is what
        // creates the file, so its absence is the observable.
        assert.equal(
          existsSync(checkpoint),
          false,
          `the refusal must precede the checkpoint, leaving no file behind\n${commandDiagnostics(args, executed)}`,
        );
      });
    });
  },
);

test(
  'never prints the api key on stdout or stderr',
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-tracing-cli-', async (checkpoint) => {
        const runId = 'run-tracing-cli';
        const args = [cliPath, 'dev', 'spike', 'start', '--run-id', runId, '--checkpoint', checkpoint];
        const executed = await runCli(args, {
          LANGSMITH_TRACING: 'true',
          LANGSMITH_API_KEY: fakeTracingValue,
          LANGCHAIN_API_KEY: fakeTracingValue,
          LANGSMITH_PROJECT: 'aic-v0.1',
          LANGSMITH_ENDPOINT: sink.endpoint,
          LANGCHAIN_ENDPOINT: sink.endpoint,
        });

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
      });
    });
  },
);

test(
  'never sends the api key inside a trace payload',
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-tracing-payload-', async (checkpoint) => {
        const args = [
          cliPath,
          'dev',
          'spike',
          'start',
          '--run-id',
          'run-tracing-payload',
          '--checkpoint',
          checkpoint,
        ];
        const executed = await runCli(args, {
          LANGSMITH_TRACING: 'true',
          LANGSMITH_API_KEY: fakeTracingValue,
          LANGSMITH_PROJECT: 'aic-v0.1',
          LANGSMITH_ENDPOINT: sink.endpoint,
          LANGCHAIN_ENDPOINT: sink.endpoint,
        });

        assert.equal(executed.status, 0, commandDiagnostics(args, executed));
        const bodies = sink.requests
          .map((request) => request.body.toString('utf8'))
          .join('\n');
        assert.ok(bodies.length > 0, 'the traced run must have sent something');
        assert.equal(
          bodies.includes(fakeKeyBody),
          false,
          'the api key belongs in the request header, never in a run payload',
        );
      });
    });
  },
);
