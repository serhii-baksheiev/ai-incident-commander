import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = resolve(projectRoot, 'test');
const fixturePath = resolve(testRoot, 'fixtures/child-env.mjs');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

// A credential SHAPE, assembled at runtime and never written as a literal —
// `.claude/rules/autonomy.md` ("Never") requires it of any fixture that needs one.
const fakeTracingValue = ['lsv2', 'pt', 'f'.repeat(32)].join('_');

/**
 * The ambient environment of the operator whose `npm run check` went red: tracing
 * on, a real key exported, and a project that is a real LangSmith workspace.
 *
 * `LANGSMITH_RUNS_ENDPOINTS` is in the list because it is the variable that costs
 * the most and that no deny-list here ever named — in its array form the SDK skips
 * its endpoint-conflict check and replicates every run to each listed endpoint.
 */
const HOSTILE_AMBIENT = {
  LANGSMITH_TRACING: 'true',
  LANGCHAIN_TRACING_V2: 'true',
  LANGSMITH_API_KEY: fakeTracingValue,
  LANGCHAIN_API_KEY: fakeTracingValue,
  LANGSMITH_PROJECT: 'operator-real-workspace',
  LANGCHAIN_PROJECT: 'operator-real-workspace',
  LANGSMITH_RUNS_ENDPOINTS: JSON.stringify({ 'https://replica.invalid': fakeTracingValue }),
  LANGCHAIN_CALLBACKS_BACKGROUND: 'true',
  OPENAI_API_KEY: fakeTracingValue,
};

/** The only ambient variable names the fixture is allowed to pass through. */
function isAllowedPassthrough(name) {
  return name === 'PATH' || name === 'HOME' || name.startsWith('NODE_');
}

/** Runs `body` with `HOSTILE_AMBIENT` exported, and restores whatever was there. */
async function withHostileAmbientEnvironment(body) {
  const saved = Object.fromEntries(
    Object.keys(HOSTILE_AMBIENT).map((name) => [name, process.env[name]]),
  );
  Object.assign(process.env, HOSTILE_AMBIENT);
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function runNode(args, env) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: projectRoot,
      env: childEnv(env),
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

function commandDiagnostics(args, result) {
  return `${process.execPath} ${args.join(' ')} exited ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`;
}

/** A local sink standing in for the LangSmith ingest endpoint; it counts requests. */
function startIngestSink() {
  const requests = [];
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      requests.push(`${request.method} ${request.url ?? ''}`);
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

async function withIngestSink(body) {
  const sink = await startIngestSink();
  try {
    return await body(sink);
  } finally {
    await sink.close();
  }
}

async function withCheckpointDirectory(prefix, body) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), prefix));
  try {
    return await body(join(temporaryRoot, 'checkpoints.sqlite'));
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/* -------------------------------------------------------------------------- */
/* The static audit of the suite's own spawn sites                            */
/* -------------------------------------------------------------------------- */

function testSources() {
  const sources = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.mjs')) {
        sources.push({ path: relative(projectRoot, path), text: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(testRoot);
  // ⚠ `scripts/` too, and it was not here before. Both commands under it spawn
  // `git`, and both correctly pass `env: childEnv()` — but the audit walked
  // `test/` only, so a future edit dropping that argument would go unnoticed in
  // exactly the two files that run beside a live provider credential. Found by
  // a cold security review of the AIC-19 gate branch; the gap predates it.
  walk(join(projectRoot, 'scripts'));
  return sources;
}

/**
 * Removes comments and import statements so the scan below cannot be fooled by a
 * `spawnSync` named in prose or in an import list. It is deliberately crude: a
 * false positive here costs one explicit `env:`, which every spawn site wants
 * anyway.
 */
function scannableSource(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
    .replace(/^import[\s\S]*?;$/gm, '');
}

/**
 * Bare-identifier calls only — a leading `.` is excluded so `regex.exec(…)` is not
 * mistaken for `child_process.exec(…)`. That leaves namespaced access invisible to
 * the scan, which the import test below closes rather than papers over.
 */
const CHILD_PROCESS_CALL =
  /(?<![\w$.])(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/g;

/** The text between a call's parentheses, or `null` if they never balance. */
function callArguments(source, openParenIndex) {
  let depth = 0;
  for (let index = openParenIndex; index < source.length; index += 1) {
    const character = source[index];
    if (character === '(') depth += 1;
    else if (character === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex + 1, index);
    }
  }
  return null;
}

function spawnSites() {
  const sites = [];
  for (const { path, text } of testSources()) {
    const source = scannableSource(text);
    for (const match of source.matchAll(CHILD_PROCESS_CALL)) {
      const openParenIndex = match.index + match[0].length - 1;
      const line = source.slice(0, match.index).split('\n').length;
      sites.push({
        path,
        line,
        callee: match[1],
        args: callArguments(source, openParenIndex),
      });
    }
  }
  return sites;
}

test('publishes one shared child-environment fixture for the whole suite', () => {
  assert.equal(
    typeof childEnv,
    'function',
    'test/fixtures/child-env.mjs must export childEnv',
  );
});

test('withholds every ambient variable the allow-list does not name', async () => {
  await withHostileAmbientEnvironment(() => {
    const env = childEnv();

    for (const name of Object.keys(HOSTILE_AMBIENT)) {
      assert.equal(
        name in env,
        false,
        `${name} is exported in the ambient shell and must not reach a spawned child`,
      );
    }
  });
});

test('passes through only PATH, HOME and NODE_* from the ambient environment', async () => {
  await withHostileAmbientEnvironment(() => {
    const leaked = Object.keys(childEnv()).filter((name) => !isAllowedPassthrough(name));

    assert.deepEqual(
      leaked,
      [],
      'the fixture is an allow-list, so an unnamed ambient variable must never appear',
    );
  });
});

test('carries PATH and HOME through so a spawned process can still run', () => {
  const env = childEnv();

  for (const name of ['PATH', 'HOME']) {
    assert.equal(
      env[name],
      process.env[name],
      `${name} is what node itself needs, so it must survive the allow-list`,
    );
  }
});

test('lets an explicit override supply a variable the allow-list withholds', async () => {
  await withHostileAmbientEnvironment(() => {
    const env = childEnv({ LANGSMITH_ENDPOINT: 'http://127.0.0.1:1', CI: '1' });

    assert.equal(env.LANGSMITH_ENDPOINT, 'http://127.0.0.1:1');
    assert.equal(env.CI, '1');
    assert.equal(
      env.LANGSMITH_API_KEY,
      undefined,
      'naming one variable must not readmit the rest of the ambient shell',
    );
  });
});

test('lets an override replace an allow-listed variable rather than merging with it', () => {
  const env = childEnv({ PATH: '/fixture/bin' });

  assert.equal(
    env.PATH,
    '/fixture/bin',
    'a hermetic probe that supplies its own PATH must get exactly that PATH',
  );
});

test('returns a fresh object rather than a view onto process.env', () => {
  const env = childEnv();
  env.AIC_CHILD_ENV_PROBE = 'written-by-a-test';

  assert.equal(
    process.env.AIC_CHILD_ENV_PROBE,
    undefined,
    'the fixture must not hand out process.env itself, or a caller edits the parent',
  );
});

test('gives a spawned child none of the ambient tracing variables', async () => {
  await withHostileAmbientEnvironment(async () => {
    const args = ['-e', 'process.stdout.write(JSON.stringify(process.env))'];
    const executed = await runNode(args, {});

    assert.equal(executed.status, 0, commandDiagnostics(args, executed));
    const childView = JSON.parse(executed.stdout);
    const leaked = Object.keys(childView).filter((name) => name in HOSTILE_AMBIENT);

    assert.deepEqual(
      leaked,
      [],
      'the child process, not just the object, must be free of the ambient shell',
    );
  });
});

test('builds the environment of every child process in the suite from the shared fixture', () => {
  const sites = spawnSites();

  assert.ok(
    sites.length > 0,
    'the scan must find the suite\'s spawn sites, or it is asserting nothing',
  );

  const unguarded = sites
    .filter((site) => site.args === null || !/\benv:\s*childEnv\(/.test(site.args))
    .map((site) => `${site.path}:${site.line} ${site.callee}(…)`);

  assert.deepEqual(
    unguarded,
    [],
    'every child process spawned by a test must get its environment from test/fixtures/child-env.mjs, or the ambient shell decides what it does',
  );
});

test('imports node:child_process only as named bindings the spawn scan can see', () => {
  const namespaced = testSources()
    .filter(({ text }) =>
      /import\s+\*\s+as\s+\w+\s+from\s+'node:child_process'/.test(text),
    )
    .map(({ path }) => path);

  assert.deepEqual(
    namespaced,
    [],
    'a namespace import hides every spawn site from the audit above, so the audit would report clean while looking nowhere',
  );
});

test('keeps the child environment allow-list in exactly one implementation', () => {
  const duplicates = testSources()
    .filter(({ path }) => resolve(projectRoot, path) !== fixturePath)
    .filter(({ text }) => /(?:function|const|let)\s+childEnv\b/.test(text))
    .map(({ path }) => path);

  assert.deepEqual(
    duplicates,
    [],
    'a second copy of the allow-list is the copy that stops matching the SDK — import the fixture instead',
  );
});

test('imports the child-environment fixture in every file that spawns a child process', () => {
  const spawningFiles = new Set(spawnSites().map((site) => site.path));

  const notImporting = [...spawningFiles].filter((path) => {
    const text = readFileSync(resolve(projectRoot, path), 'utf8');
    // The optional `test/` segment is what a file OUTSIDE the test tree needs:
    // `scripts/` reaches the fixture as `../test/fixtures/child-env.mjs`. Added
    // with the walk over `scripts/` above — without it the widened audit would
    // have reported two files that do exactly the right thing.
    return !/from\s+'(?:\.\.?\/)+(?:test\/)?fixtures\/child-env\.mjs'/.test(text);
  });

  assert.deepEqual(
    notImporting,
    [],
    'a file that spawns a child process must import the shared allow-list fixture',
  );
});

/* -------------------------------------------------------------------------- */
/* The end-to-end proof: the defect this fixture exists to stop                */
/* -------------------------------------------------------------------------- */

test(
  'runs the compiled CLI with no outbound call while the parent shell has tracing enabled',
  { timeout: 30_000 },
  async () => {
    await withIngestSink(async (sink) => {
      await withCheckpointDirectory('aic-child-env-', async (checkpoint) => {
        await withHostileAmbientEnvironment(async () => {
          // The ambient endpoint points AT the sink, so a leaked variable is a
          // counted request rather than a timeout that depends on the network.
          process.env.LANGSMITH_ENDPOINT = sink.endpoint;
          process.env.LANGCHAIN_ENDPOINT = sink.endpoint;

          const runId = 'run-child-env-hermetic';
          const args = [cliPath, 'start', '--run-id', runId, '--checkpoint', checkpoint];
          const executed = await runNode(args, {});

          assert.equal(executed.status, 0, commandDiagnostics(args, executed));
          assert.equal(
            JSON.parse(executed.stdout).runId,
            runId,
            'the run must really have happened, or zero requests proves nothing',
          );
          assert.deepEqual(
            sink.requests,
            [],
            'a unit-test run must not trace, whatever the developer exported in their shell',
          );
        });
      });
    });
  },
);
