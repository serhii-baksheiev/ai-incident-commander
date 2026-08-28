import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

import { InvestigationStopSchema } from '@aic/domain';
import * as evals from '@aic/evals';
import {
  createReplayFixtureKey,
  READ_ONLY_TOOL_REGISTRY,
} from '@aic/tools';
import {
  REPLAY_FIXTURE_VERSION,
  ReplayToolAdapter,
} from '@aic/tools/replay';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const expectedScenarioIds = [
  'bad-deployment',
  'db-pool-exhaustion',
  'false-alert',
  'deployment-caused-incident-a',
  'dependency-caused-incident-b',
];

const conclusionKinds = new Set([
  'root-cause',
  'multiple-causes',
  'inconclusive',
  'no-incident',
]);

const evidenceKinds = new Set([
  'log',
  'metric',
  'trace',
  'deploy',
  'git',
  'config',
  'dependency',
  'runbook',
  'historical-incident',
]);

const registeredToolIds = new Set(
  READ_ONLY_TOOL_REGISTRY.map(({ id }) => id),
);

function requireReplayScenarios() {
  assert.ok(
    Array.isArray(evals.REPLAY_SCENARIOS),
    '@aic/evals must export REPLAY_SCENARIOS',
  );
  return evals.REPLAY_SCENARIOS;
}

function requireBenchmarkInvocationFactory() {
  assert.equal(
    typeof evals.createBenchmarkInvocation,
    'function',
    '@aic/evals must export createBenchmarkInvocation(scenario)',
  );
  return evals.createBenchmarkInvocation;
}

function requireFixtureEntries(scenario) {
  assert.ok(
    Array.isArray(scenario.fixture.entries),
    `${scenario.id}.fixture must expose versioned replay entries`,
  );
  assert.ok(
    scenario.fixture.entries.length > 0,
    `${scenario.id}.fixture entries must not be empty`,
  );
  return scenario.fixture.entries;
}

function replayFixtureFromEntries(scenario) {
  const entries = requireFixtureEntries(scenario);
  const responses = Object.fromEntries(
    entries.map(({ toolId, input, result }) => [
      createReplayFixtureKey(toolId, input),
      result,
    ]),
  );
  assert.equal(
    Object.keys(responses).length,
    entries.length,
    `${scenario.id} replay entries must have unique keys`,
  );
  return { version: scenario.fixture.version, responses };
}

function assertNonEmptyString(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`);
  assert.notEqual(value.length, 0, `${label} must not be empty`);
}

function assertEvidenceFingerprint(fingerprint, label) {
  assert.deepEqual(
    Object.keys(fingerprint).sort(),
    ['kind', 'predicate', 'source'],
    `${label} must preserve the frozen fingerprint shape`,
  );
  assert.equal(evidenceKinds.has(fingerprint.kind), true, `${label}.kind is invalid`);
  assertNonEmptyString(fingerprint.source, `${label}.source`);
  assertNonEmptyString(fingerprint.predicate, `${label}.predicate`);
}

test('publishes exactly the five named v0.1 replay scenarios', () => {
  const scenarios = requireReplayScenarios();

  assert.deepEqual(
    scenarios.map(({ id }) => id).sort(),
    [...expectedScenarioIds].sort(),
  );
});

test('keeps @aic/evals independent of @aic/tools', () => {
  const manifest = JSON.parse(
    readFileSync(resolve(projectRoot, 'packages/evals/package.json'), 'utf8'),
  );
  const declaringSections = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ].filter((section) => manifest[section]?.['@aic/tools'] !== undefined);

  assert.deepEqual(
    declaringSections,
    [],
    'the frozen evals dependency direction is domain/graph only',
  );
});

test('preserves the frozen structured ground truth and false-alert outcome', () => {
  const scenarios = requireReplayScenarios();

  for (const scenario of scenarios) {
    const { groundTruth } = scenario;
    const expectedKeys = [
      'expectedConclusionKind',
      'expectedEvidence',
      'expectedStopKind',
      ...(groundTruth.rootCause === undefined ? [] : ['rootCause']),
      ...(groundTruth.misleadingEvidence === undefined
        ? []
        : ['misleadingEvidence']),
    ];
    assert.deepEqual(
      Object.keys(groundTruth).sort(),
      expectedKeys.sort(),
      `${scenario.id} must preserve the frozen groundTruth shape`,
    );
    assert.equal(
      InvestigationStopSchema.safeParse(groundTruth.expectedStopKind).success,
      true,
      `${scenario.id} expectedStopKind must be canonical`,
    );
    assert.equal(
      conclusionKinds.has(groundTruth.expectedConclusionKind),
      true,
      `${scenario.id} expectedConclusionKind must be canonical`,
    );
    assert.ok(
      Array.isArray(groundTruth.expectedEvidence) &&
        groundTruth.expectedEvidence.length > 0,
      `${scenario.id} must name expected evidence`,
    );
    groundTruth.expectedEvidence.forEach((fingerprint, index) =>
      assertEvidenceFingerprint(
        fingerprint,
        `${scenario.id}.expectedEvidence[${index}]`,
      ),
    );
    groundTruth.misleadingEvidence?.forEach((fingerprint, index) =>
      assertEvidenceFingerprint(
        fingerprint,
        `${scenario.id}.misleadingEvidence[${index}]`,
      ),
    );

    if (scenario.id === 'false-alert') {
      assert.equal(groundTruth.rootCause, undefined);
      assert.equal(groundTruth.expectedConclusionKind, 'no-incident');
      continue;
    }

    assert.deepEqual(
      Object.keys(groundTruth.rootCause).sort(),
      [
        'component',
        'mechanism',
        ...(groundTruth.rootCause.trigger === undefined ? [] : ['trigger']),
      ].sort(),
      `${scenario.id}.rootCause must preserve the frozen shape`,
    );
    assertNonEmptyString(groundTruth.rootCause.component, 'rootCause.component');
    assertNonEmptyString(groundTruth.rootCause.mechanism, 'rootCause.mechanism');
    if (groundTruth.rootCause.trigger !== undefined) {
      assertNonEmptyString(groundTruth.rootCause.trigger, 'rootCause.trigger');
    }
  }
});

test('replays every versioned deterministic fixture through ReplayToolAdapter', async () => {
  const scenarios = requireReplayScenarios();

  for (const scenario of scenarios) {
    assert.equal(scenario.fixture.version, REPLAY_FIXTURE_VERSION);
    const entries = requireFixtureEntries(scenario);
    const fixture = replayFixtureFromEntries(scenario);
    const adapter = new ReplayToolAdapter(fixture);

    for (const entry of entries) {
      assert.deepEqual(
        Object.keys(entry).sort(),
        ['input', 'result', 'toolId'],
        `${scenario.id} entry must preserve the replay boundary shape`,
      );
      assert.equal(
        registeredToolIds.has(entry.toolId),
        true,
        `${scenario.id} must stay inside the closed read-only registry`,
      );
      assert.deepEqual(
        await adapter.execute(entry.toolId, entry.input),
        entry.result,
        `${scenario.id} must replay its recorded response`,
      );
      assert.deepEqual(
        await adapter.execute(entry.toolId, entry.input),
        entry.result,
        `${scenario.id} replay must be deterministic`,
      );
    }
  }
});

test('links every ground-truth fingerprint to replay evidence by kind and source', () => {
  const scenarios = requireReplayScenarios();

  for (const scenario of scenarios) {
    const evidence = requireFixtureEntries(scenario).flatMap(({ result }) =>
      result.status === 'ok' && Array.isArray(result.output)
        ? result.output
        : [],
    );
    const fingerprints = [
      ...scenario.groundTruth.expectedEvidence,
      ...(scenario.groundTruth.misleadingEvidence ?? []),
    ];

    for (const fingerprint of fingerprints) {
      assert.equal(
        evidence.some(
          (item) =>
            item.kind === fingerprint.kind &&
            item.source === fingerprint.source,
        ),
        true,
        `${scenario.id} fixture must contain ${fingerprint.kind} evidence from ${fingerprint.source}`,
      );
    }
  }
});

test('keeps A and B deployment context identical and changes only causal detail', () => {
  const scenarios = requireReplayScenarios();
  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const scenarioA = byId.get('deployment-caused-incident-a');
  const scenarioB = byId.get('dependency-caused-incident-b');
  assert.ok(scenarioA);
  assert.ok(scenarioB);

  const entriesA = new Map(
    requireFixtureEntries(scenarioA).map((entry) => [
      createReplayFixtureKey(entry.toolId, entry.input),
      entry,
    ]),
  );
  const entriesB = new Map(
    requireFixtureEntries(scenarioB).map((entry) => [
      createReplayFixtureKey(entry.toolId, entry.input),
      entry,
    ]),
  );
  const keysA = [...entriesA.keys()].sort();
  const keysB = [...entriesB.keys()].sort();
  assert.deepEqual(keysA, keysB, 'A/B must replay the same investigation inputs');

  const deploymentKeys = keysA.filter(
    (key) => entriesA.get(key).toolId === 'deployments',
  );
  assert.ok(deploymentKeys.length > 0, 'A/B must include deployment context');
  for (const key of deploymentKeys) {
    assert.deepEqual(
      entriesA.get(key).result,
      entriesB.get(key).result,
      'A/B deployment context must be identical',
    );
  }

  const differingResponseKeys = keysA.filter(
    (key) =>
      !isDeepStrictEqual(
        entriesA.get(key).result,
        entriesB.get(key).result,
      ),
  );
  assert.equal(
    differingResponseKeys.length,
    1,
    'A/B fixtures may differ only in the causal evidence response',
  );
  assert.notDeepEqual(
    scenarioA.groundTruth.rootCause,
    scenarioB.groundTruth.rootCause,
  );

  const causalDeployment = scenarioA.groundTruth.expectedEvidence.find(
    ({ kind }) => kind === 'deploy',
  );
  assert.ok(causalDeployment, 'scenario A must expect causal deployment evidence');
  assert.equal(
    scenarioB.groundTruth.misleadingEvidence?.some((fingerprint) =>
      isDeepStrictEqual(fingerprint, causalDeployment),
    ),
    true,
    'the same deployment fingerprint must be misleading in scenario B',
  );
});

test('creates a fresh runId with threadId equal to it for every invocation', () => {
  const createBenchmarkInvocation = requireBenchmarkInvocationFactory();
  const scenarios = requireReplayScenarios();
  const runIds = [];

  for (const scenario of scenarios) {
    for (let repetition = 0; repetition < 2; repetition += 1) {
      const invocation = createBenchmarkInvocation(scenario);
      assertNonEmptyString(invocation.runId, `${scenario.id}.runId`);
      assert.equal(invocation.threadId, invocation.runId);
      runIds.push(invocation.runId);
    }
  }

  assert.equal(new Set(runIds).size, runIds.length);
});
