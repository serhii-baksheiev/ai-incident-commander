import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The suite invokes the graph in-process, and `@langchain/core`'s
 * `isTracingEnabled()` reads the test runner's own `process.env`. A developer
 * with tracing exported therefore writes real runs into a real workspace on
 * every `npm test` — measured at 23 `POST /runs/multipart` before this preload.
 * The preload removes the tracer's four flags before any test module loads.
 */
const TRACER_FLAGS = [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
];

test('the preload clears every flag the langchain tracer reads', async () => {
  const saved = new Map();
  for (const flag of TRACER_FLAGS) {
    saved.set(flag, process.env[flag]);
    process.env[flag] = 'true';
  }
  const keptName = 'AIC_PRELOAD_UNRELATED';
  const savedKept = process.env[keptName];
  process.env[keptName] = 'survives';
  try {
    await import(`../test/fixtures/no-ambient-tracing.mjs?probe=${Date.now()}`);
    for (const flag of TRACER_FLAGS) {
      assert.equal(
        process.env[flag],
        undefined,
        `${flag} must be cleared so an ambient shell cannot trace a test run`,
      );
    }
    assert.equal(
      process.env[keptName],
      'survives',
      'the preload must clear only the tracer flags, not the rest of the environment',
    );
  } finally {
    for (const [flag, value] of saved) {
      if (value === undefined) delete process.env[flag];
      else process.env[flag] = value;
    }
    if (savedKept === undefined) delete process.env[keptName];
    else process.env[keptName] = savedKept;
  }
});

test('the npm test script runs through the preload', async () => {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  );
  assert.match(
    manifest.scripts.test,
    /--import\s+\.\/test\/fixtures\/no-ambient-tracing\.mjs/,
    'npm test must preload the scrubber, or an ambient shell traces the suite',
  );
});
