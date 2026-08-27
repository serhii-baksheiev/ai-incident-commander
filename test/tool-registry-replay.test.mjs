import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as liveTools from '@aic/tools/live';
import * as replayTools from '@aic/tools/replay';
import * as tools from '@aic/tools';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const rawEvidence = {
  id: 'evidence-1',
  trialId: 'trial-1',
  kind: 'log',
  source: 'checkout-logs',
  observedAt: '2026-08-27T12:00:00.000Z',
  statement: 'checkout returned 500',
  rawRef: 'fixture://logs/checkout/1',
};

const plannedTest = {
  id: 'test-1',
  predictionId: 'prediction-1',
  tool: 'logs',
  input: { service: 'checkout' },
  cost: 'cheap',
  status: 'planned',
};

const untestedPrediction = {
  id: 'prediction-1',
  hypothesisId: 'hypothesis-1',
  statement: 'checkout emits errors',
  expectedIfTrue: [{ status: 500 }],
  expectedIfFalse: [{ status: 200 }],
  status: 'untested',
};

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && path.endsWith('.ts') ? [path] : [];
  });
}

function incidentTool(overrides = {}) {
  return {
    id: 'logs',
    risk: 'read',
    execute: async () => ({ status: 'ok', output: [rawEvidence] }),
    ...overrides,
  };
}

test('publishes exactly the six initial tools as a closed read-only registry', () => {
  assert.deepEqual(tools.READ_ONLY_TOOL_REGISTRY, [
    { id: 'deployments', risk: 'read' },
    { id: 'logs', risk: 'read' },
    { id: 'metrics', risk: 'read' },
    { id: 'traces', risk: 'read' },
    { id: 'git', risk: 'read' },
    { id: 'dependencies', risk: 'read' },
  ]);
  assert.equal(Object.isFrozen(tools.READ_ONLY_TOOL_REGISTRY), true);
  for (const descriptor of tools.READ_ONLY_TOOL_REGISTRY) {
    assert.equal(Object.isFrozen(descriptor), true);
  }
});

test('live tools preserve ok, unavailable, and error ToolResult variants', async () => {
  const variants = [
    { status: 'ok', output: [rawEvidence] },
    { status: 'unavailable', reason: 'log service is disabled' },
    { status: 'error', message: 'log service timed out' },
  ];

  for (const expected of variants) {
    const adapter = new liveTools.LiveToolAdapter([
      {
        id: 'logs',
        risk: 'read',
        execute: async () => expected,
      },
    ]);

    assert.deepEqual(await adapter.execute('logs', { service: 'checkout' }), expected);
  }
});

test('rejects a live tool outside the closed read-only registry', () => {
  assert.throws(
    () => new liveTools.LiveToolAdapter([incidentTool({ id: 'secrets' })]),
  );
});

test('rejects live tools whose risk is not read-only', () => {
  for (const risk of ['safe-write', 'dangerous']) {
    assert.throws(
      () => new liveTools.LiveToolAdapter([incidentTool({ risk })]),
      `risk ${risk} must not enter the v0.1 live registry`,
    );
  }
});

test('rejects duplicate live tool ids', () => {
  assert.throws(
    () => new liveTools.LiveToolAdapter([incidentTool(), incidentTool()]),
  );
});

test('converts a thrown live implementation error to ToolResult.error', async () => {
  const adapter = new liveTools.LiveToolAdapter([
    incidentTool({
      execute: async () => {
        throw new Error('log transport failed');
      },
    }),
  ]);

  assert.deepEqual(await adapter.execute('logs', {}), {
    status: 'error',
    message: 'log transport failed',
  });
});

test('canonical serialization and replay keys ignore object key order', () => {
  const first = {
    service: 'checkout',
    query: { level: 'error', window: { from: 10, to: 20 } },
  };
  const reordered = {
    query: { window: { to: 20, from: 10 }, level: 'error' },
    service: 'checkout',
  };

  assert.equal(
    tools.canonicalSerializeToolInput(first),
    tools.canonicalSerializeToolInput(reordered),
  );
  assert.equal(
    tools.createReplayFixtureKey('logs', first),
    tools.createReplayFixtureKey('logs', reordered),
  );
  assert.notEqual(
    tools.createReplayFixtureKey('logs', first),
    tools.createReplayFixtureKey('metrics', first),
  );
});

test('replays a recorded live response without invoking the live tool again', async () => {
  const input = { service: 'checkout', query: { level: 'error', limit: 1 } };
  let liveCalls = 0;
  const liveAdapter = new liveTools.LiveToolAdapter([
    {
      id: 'logs',
      risk: 'read',
      execute: async () => {
        liveCalls += 1;
        return { status: 'ok', output: [rawEvidence] };
      },
    },
  ]);
  const recordedResult = await liveAdapter.execute('logs', input);
  const fixtureKey = tools.createReplayFixtureKey('logs', input);
  const replayAdapter = new replayTools.ReplayToolAdapter({
    version: 1,
    responses: { [fixtureKey]: recordedResult },
  });

  const replayed = await replayAdapter.execute('logs', {
    query: { limit: 1, level: 'error' },
    service: 'checkout',
  });

  assert.deepEqual(replayed, recordedResult);
  assert.equal(liveCalls, 1, 'replay must not fall through to a live tool');
});

test('does not replay a recorded response for an unknown seventh tool id', async () => {
  const unknownToolId = 'secrets';
  const input = { incident: 'incident-1' };
  const fixtureKey = tools.createReplayFixtureKey(unknownToolId, input);
  const adapter = new replayTools.ReplayToolAdapter({
    version: 1,
    responses: {
      [fixtureKey]: { status: 'ok', output: [rawEvidence] },
    },
  });

  const result = await adapter.execute(unknownToolId, input);

  assert.match(result.status, /^(?:unavailable|error)$/);
  assert.equal('output' in result, false);
});

test('publishes replay fixture version 1', () => {
  assert.equal(replayTools.REPLAY_FIXTURE_VERSION, 1);
});

test('rejects replay fixtures with an unsupported version', () => {
  assert.throws(
    () =>
      new replayTools.ReplayToolAdapter({
        version: 2,
        responses: {},
      }),
    /version/i,
  );
});

test('returns ToolResult.error for circular replay input instead of rejecting', async () => {
  const circular = { service: 'checkout' };
  circular.self = circular;
  const adapter = new replayTools.ReplayToolAdapter({ version: 1, responses: {} });

  const result = await adapter.execute('logs', circular);

  assert.equal(result.status, 'error');
  assert.equal(typeof result.message, 'string');
});

test('returns ToolResult.error for non-JSON replay input instead of rejecting', async () => {
  const adapter = new replayTools.ReplayToolAdapter({ version: 1, responses: {} });

  const result = await adapter.execute('logs', { limit: 1n });

  assert.equal(result.status, 'error');
  assert.equal(typeof result.message, 'string');
});

test('maps unavailable to untestable without negative or raw evidence', () => {
  const outcome = tools.projectToolResult({
    test: plannedTest,
    prediction: untestedPrediction,
    result: { status: 'unavailable', reason: 'log service is disabled' },
  });

  assert.deepEqual(outcome, {
    test: { ...plannedTest, status: 'unavailable' },
    prediction: { ...untestedPrediction, status: 'untestable' },
    evidence: [],
  });
});

test('maps tool errors to a failed test without classifying the prediction', () => {
  const outcome = tools.projectToolResult({
    test: plannedTest,
    prediction: untestedPrediction,
    result: { status: 'error', message: 'log service timed out' },
  });

  assert.deepEqual(outcome, {
    test: { ...plannedTest, status: 'failed' },
    prediction: untestedPrediction,
    evidence: [],
  });
});

test('passes through successful tool evidence without synthesizing interpretation', () => {
  const toolOutput = [rawEvidence];
  const outcome = tools.projectToolResult({
    test: plannedTest,
    prediction: untestedPrediction,
    result: { status: 'ok', output: toolOutput },
  });

  assert.deepEqual(outcome, {
    test: { ...plannedTest, status: 'executed' },
    prediction: untestedPrediction,
    evidence: toolOutput,
  });
  assert.equal(outcome.evidence, toolOutput, 'raw Evidence must originate in tool output');
  assert.equal('assessments' in outcome, false, 'tool execution must not interpret Evidence');
});

test('keeps tool binding out of graph and roles and tool imports out of LLM roles', () => {
  for (const packageName of ['graph', 'roles']) {
    const directory = resolve(projectRoot, `packages/${packageName}`);
    for (const path of sourceFiles(directory)) {
      const source = readFileSync(path, 'utf8');
      assert.doesNotMatch(source, /\.bindTools\s*\(/);
      if (packageName === 'roles') {
        assert.doesNotMatch(
          source,
          /(?:from\s+|import\s*\()['"]@aic\/tools(?:\/[^'"]*)?['"]/,
        );
      }
    }
  }
});
