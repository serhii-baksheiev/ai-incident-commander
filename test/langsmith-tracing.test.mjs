import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readmePath = resolve(projectRoot, 'README.md');
const cliPath = resolve(projectRoot, 'apps/cli/dist/index.js');

function runCli(args, env) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: projectRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('close', (status, signal) => resolveResult({ signal, status, stderr, stdout }));
  });
}

test('documents how to enable LangGraph auto-tracing without committing a LangSmith key', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const tracingShellBlock = [...readme.matchAll(/```(?:bash|sh)\n[\s\S]*?```/g)]
    .map(([block]) => block)
    .find(
      (block) =>
        block.includes('LANGSMITH_TRACING=true') &&
        block.includes('LANGSMITH_API_KEY=') &&
        block.includes('LANGSMITH_PROJECT='),
    );

  assert.notEqual(
    tracingShellBlock,
    undefined,
    'README must include one shell block with LANGSMITH_TRACING=true, LANGSMITH_API_KEY, and LANGSMITH_PROJECT',
  );
  assert.match(
    tracingShellBlock,
    /LANGSMITH_API_KEY=(?:<[^>\n]+>|\$\{?LANGSMITH_API_KEY\}?)/,
    'the API key assignment must use a placeholder or an already exported variable',
  );
  assert.doesNotMatch(
    tracingShellBlock,
    /LANGSMITH_API_KEY=lsv2_[^\s]+/,
    'documentation must never contain a real LangSmith API key',
  );
});

test('sends LangGraph traces to the configured LangSmith endpoint without external network access', async (t) => {
  assert.equal(
    existsSync(cliPath),
    true,
    'build the public CLI before running its tracing contract test',
  );

  const requests = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        authorization: request.headers['x-api-key'],
        body: Buffer.concat(chunks),
        method: request.method,
        url: request.url,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{}');
    });
  });
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'aic-langsmith-tracing-'));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));

  const result = await runCli(
    [
      'start',
      '--run-id',
      'langsmith-local-trace',
      '--checkpoint',
      join(temporaryRoot, 'checkpoint.sqlite'),
    ],
    {
      ...process.env,
      LANGCHAIN_CALLBACKS_BACKGROUND: 'false',
      LANGSMITH_API_KEY: 'test-only-local-key',
      LANGSMITH_ENDPOINT: `http://127.0.0.1:${address.port}`,
      LANGSMITH_PROJECT: 'aic-local-tracing-contract',
      LANGSMITH_TRACING: 'true',
      LANGSMITH_TRACING_BACKGROUND: 'false',
    },
  );

  assert.equal(
    result.status,
    0,
    `the traced CLI run must succeed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.ok(
    requests.some((request) => /^\/runs(?:\/(?:batch|multipart))?(?:\?|$)/.test(request.url ?? '')),
    `expected a LangSmith run request, received: ${requests.map(({ method, url }) => `${method} ${url}`).join(', ')}`,
  );
  assert.ok(
    requests.every((request) => request.authorization === 'test-only-local-key'),
    'every trace request must authenticate with the configured LANGSMITH_API_KEY',
  );
  assert.ok(
    requests.some((request) => request.body.includes('aic-local-tracing-contract')),
    'at least one trace request must identify the configured LANGSMITH_PROJECT',
  );
});
