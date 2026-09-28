/**
 * AIC-123 slice 3b: the merge at the replay boundary slice 3a's own header
 * named as "a later slice" — `ReplayToolAdapter` gains an optional second
 * constructor argument that annotates a replayed `ok` evidence array with
 * `Evidence.observation`, `@aic/evals` gains `createObservationAnnotator()`
 * reading `OBSERVATION_ANNOTATIONS`, the shared `replayBackedNodes` fixture
 * (`test/fixtures/benchmark-experiment.mjs`) wires the two together so both
 * the scripted and the model graph arm see the same annotated evidence, and
 * `describeState` (`packages/roles/src/investigation-roles.ts`) omits
 * `evidence[].observation` from the prompt every model role sends — the
 * naive arm never sees the typed channel, so the graph model must not either
 * (information parity).
 *
 * Every replay-identity computation in this file is independent of
 * `buildReplayIdentity` (`packages/tools/src/bound-source-registry.ts`) —
 * the same discipline `observation-annotations.test.mjs`'s own
 * `replayIdentity` already holds itself to (`.claude/rules/invariants.md`,
 * "the independent-oracle invariant"): `REPLAY_ADAPTER` below is a literal
 * copy of the adapter id `ReplayToolAdapter` binds every read-only tool
 * against, not an import of it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';
import {
  createReplayFixtureKey,
  createRequestFingerprint,
  READ_ONLY_TOOL_REGISTRY,
} from '@aic/tools';
import { REPLAY_FIXTURE_VERSION, ReplayToolAdapter } from '@aic/tools/replay';
import * as roles from '@aic/roles';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

const REPLAY_ADAPTER = 'aic.incident-tool@1';

/**
 * A second, independent construction of the v2 replay identity string —
 * deliberately not an import of `buildReplayIdentity`. See this file's
 * header ("the independent-oracle invariant").
 */
function replayIdentity(toolId, input) {
  return `v2:${JSON.stringify([toolId, REPLAY_ADAPTER, createRequestFingerprint(toolId, input)])}`;
}

function fixtureFromScenario(scenario) {
  const responses = Object.fromEntries(
    scenario.fixture.entries.map(({ toolId, input, result }) => [
      createReplayFixtureKey(toolId, input),
      result,
    ]),
  );
  return { version: scenario.fixture.version, responses };
}

function requireEvalsExport(name) {
  assert.equal(typeof evals[name], 'function', `@aic/evals must export ${name}`);
  return evals[name];
}

/* ============================================================================
 * ReplayToolAdapter: an optional second constructor argument, { observations }
 * ==========================================================================*/

test('ReplayToolAdapter without a second constructor argument replays deployment-caused-incident-a byte-identical to its fixture, with no observation key on any evidence item, even though OBSERVATION_ANNOTATIONS carries facts for it', async () => {
  const scenario = evals.REPLAY_SCENARIOS.find((s) => s.id === 'deployment-caused-incident-a');
  assert.ok(scenario, 'REPLAY_SCENARIOS must carry deployment-caused-incident-a');

  // Sanity: the table really does withhold facts here, or the row below is vacuous.
  const rowWithFacts = evals.OBSERVATION_ANNOTATIONS.find(
    (row) => row.evidenceId === 'confirmation-deploy-v17',
  );
  assert.ok(rowWithFacts?.facts.length > 0, 'confirmation-deploy-v17 must carry non-empty facts in the table');

  const adapter = new ReplayToolAdapter(fixtureFromScenario(scenario));

  for (const entry of scenario.fixture.entries) {
    const replayed = await adapter.execute(entry.toolId, entry.input);
    assert.deepEqual(replayed, entry.result, `${entry.toolId} must replay its recorded response unchanged`);
    if (replayed.status === 'ok') {
      for (const item of replayed.output) {
        assert.equal(
          'observation' in item,
          false,
          `${item.id} must carry no observation key when no annotator is supplied`,
        );
      }
    }
  }
});

const STUB_TOOL_ID = 'metrics';
const STUB_INPUT = { service: 'observation-merge-stub', metric: 'stub-probe' };

const STUB_ITEM_WITH_FACTS = {
  id: 'stub-evidence-with-facts',
  trialId: 'trial-stub-evidence-with-facts',
  kind: 'metric',
  source: 'metrics/observation-merge-stub',
  observedAt: '2026-01-01T00:00:00.000Z',
  statement: 'stub statement carrying facts',
  rawRef: 'replay://metrics/observation-merge-stub/with-facts',
};

const STUB_ITEM_WITHOUT_FACTS = {
  id: 'stub-evidence-without-facts',
  trialId: 'trial-stub-evidence-without-facts',
  kind: 'metric',
  source: 'metrics/observation-merge-stub',
  observedAt: '2026-01-01T00:00:00.000Z',
  statement: 'stub statement carrying no facts',
  rawRef: 'replay://metrics/observation-merge-stub/without-facts',
};

const STUB_FACTS = [
  {
    form: 'signal-state',
    subject: 'observation-merge-stub',
    window: 'incident',
    signal: 'error-rate',
    state: 'elevated',
  },
];

function buildStubFixture() {
  return {
    version: REPLAY_FIXTURE_VERSION,
    responses: {
      [createReplayFixtureKey(STUB_TOOL_ID, STUB_INPUT)]: {
        status: 'ok',
        output: [{ ...STUB_ITEM_WITH_FACTS }, { ...STUB_ITEM_WITHOUT_FACTS }],
      },
    },
  };
}

function stubAnnotator() {
  const calls = [];
  return {
    calls,
    annotate(identity, evidenceItem) {
      calls.push({ identity, evidenceItem });
      return evidenceItem.id === STUB_ITEM_WITH_FACTS.id ? STUB_FACTS : [];
    },
  };
}

test("ReplayToolAdapter given { observations } merges facts only onto the item the annotator returns a non-empty list for, as a new object equal to the item plus observation:{version,facts}, leaves the other item untouched, and never mutates the caller's own fixture object", async () => {
  assert.ok(
    READ_ONLY_TOOL_REGISTRY.some(({ id }) => id === STUB_TOOL_ID),
    `${STUB_TOOL_ID} must be a registered read-only tool, or this fixture replays nothing`,
  );

  const plainFixture = buildStubFixture();
  const plainAdapter = new ReplayToolAdapter(plainFixture);
  const plainResult = await plainAdapter.execute(STUB_TOOL_ID, STUB_INPUT);
  assert.equal(plainResult.status, 'ok');

  const annotatedFixture = buildStubFixture();
  const annotatedFixtureSnapshot = structuredClone(annotatedFixture);
  const { calls, annotate } = stubAnnotator();
  const annotatedAdapter = new ReplayToolAdapter(annotatedFixture, { observations: annotate });
  const annotatedResult = await annotatedAdapter.execute(STUB_TOOL_ID, STUB_INPUT);

  assert.deepEqual(
    annotatedFixture,
    annotatedFixtureSnapshot,
    "the caller's own fixture object must never be mutated by the merge",
  );

  assert.equal(annotatedResult.status, 'ok');
  assert.equal(annotatedResult.output.length, plainResult.output.length);

  const plainWithFacts = plainResult.output.find((item) => item.id === STUB_ITEM_WITH_FACTS.id);
  const plainWithoutFacts = plainResult.output.find((item) => item.id === STUB_ITEM_WITHOUT_FACTS.id);
  const annotatedWithFacts = annotatedResult.output.find((item) => item.id === STUB_ITEM_WITH_FACTS.id);
  const annotatedWithoutFacts = annotatedResult.output.find((item) => item.id === STUB_ITEM_WITHOUT_FACTS.id);

  assert.deepEqual(
    annotatedWithFacts,
    { ...plainWithFacts, observation: { version: domain.EXPECTED_OBSERVATION_VERSION, facts: STUB_FACTS } },
    'the item the annotator returned non-empty facts for must gain exactly observation:{version,facts}',
  );
  domain.EvidenceSchema.parse(annotatedWithFacts);

  assert.deepEqual(
    annotatedWithoutFacts,
    plainWithoutFacts,
    'the item the annotator returned an empty list for must be unchanged',
  );
  assert.equal('observation' in annotatedWithoutFacts, false);

  assert.equal(calls.length, 2, 'the annotator must be consulted once per evidence item the call produced');
  const expectedIdentity = replayIdentity(STUB_TOOL_ID, STUB_INPUT);
  for (const call of calls) {
    assert.equal(
      call.identity,
      expectedIdentity,
      "each call must pass the call's own v2 replay identity, computed independently",
    );
  }
  assert.deepEqual(
    calls.map((call) => call.evidenceItem.id).sort(),
    [STUB_ITEM_WITHOUT_FACTS.id, STUB_ITEM_WITH_FACTS.id].sort(),
  );
});

test('ReplayToolAdapter given { observations } leaves a non-ok (unavailable) replay result untouched, and never consults the annotator for it', async () => {
  const scenario = evals.REPLAY_SCENARIOS.find((s) => s.id === 'incomplete-evidence');
  assert.ok(scenario, 'REPLAY_SCENARIOS must carry incomplete-evidence');
  const tracesEntry = scenario.fixture.entries.find((entry) => entry.toolId === 'traces');
  assert.ok(tracesEntry, 'incomplete-evidence must carry a traces entry');
  assert.equal(tracesEntry.result.status, 'unavailable');

  let calls = 0;
  const adapter = new ReplayToolAdapter(fixtureFromScenario(scenario), {
    observations() {
      calls += 1;
      return STUB_FACTS;
    },
  });

  const replayed = await adapter.execute(tracesEntry.toolId, tracesEntry.input);

  assert.deepEqual(replayed, tracesEntry.result, 'a non-ok result must replay unchanged');
  assert.equal(calls, 0, 'the annotator must never be consulted for a non-ok replay result');
});

/* ============================================================================
 * @aic/evals: createObservationAnnotator()
 * ==========================================================================*/

test('createObservationAnnotator returns a function that, for every (replay identity, evidence id) pair the ok corpus serves, answers the facts of its own OBSERVATION_ANNOTATIONS row', () => {
  const createObservationAnnotator = requireEvalsExport('createObservationAnnotator');
  const annotate = createObservationAnnotator();
  assert.equal(typeof annotate, 'function', 'createObservationAnnotator() must return a function');

  const rowsByKey = new Map(
    evals.OBSERVATION_ANNOTATIONS.map((row) => [`${row.identity}|${row.evidenceId}`, row]),
  );

  let checkedAny = false;
  for (const scenario of evals.REPLAY_SCENARIOS) {
    for (const entry of scenario.fixture.entries) {
      if (entry.result.status !== 'ok') continue;
      const identity = replayIdentity(entry.toolId, entry.input);
      for (const item of entry.result.output) {
        const row = rowsByKey.get(`${identity}|${item.id}`);
        assert.ok(row, `${scenario.id}: no OBSERVATION_ANNOTATIONS row for (identity, ${item.id})`);
        const facts = annotate(identity, item);
        if (row.facts.length === 0) {
          assert.ok(
            facts === undefined || (Array.isArray(facts) && facts.length === 0),
            `${item.id}: a row with empty facts must answer undefined or an empty list, got ${JSON.stringify(facts)}`,
          );
        } else {
          assert.deepEqual(facts, row.facts, `${item.id}: annotated facts must equal the table row`);
        }
        checkedAny = true;
      }
    }
  }
  assert.ok(checkedAny, 'the ok corpus must serve at least one evidence item, or this sweep checks nothing');
});

test('createObservationAnnotator returns undefined for an (identity, evidence id) pair the table does not carry, such as a call outside the frozen corpus', () => {
  const createObservationAnnotator = requireEvalsExport('createObservationAnnotator');
  const annotate = createObservationAnnotator();

  const unknownIdentity = replayIdentity('metrics', {
    service: 'no-such-service',
    probe: 'outside-the-frozen-corpus',
  });
  const unknownItem = {
    id: 'evidence-outside-the-corpus',
    trialId: 'trial-evidence-outside-the-corpus',
    kind: 'metric',
    source: 'metrics/no-such-service',
    observedAt: '2026-01-01T00:00:00.000Z',
    statement: 'a statement the frozen table has never reviewed',
    rawRef: 'replay://metrics/no-such-service/1',
  };

  assert.equal(annotate(unknownIdentity, unknownItem), undefined);
});

test("createObservationAnnotator throws a plain Error naming the evidence id when a row matches the (identity, evidence id) pair but the served evidence's statement differs from the row's statement", () => {
  const createObservationAnnotator = requireEvalsExport('createObservationAnnotator');
  const annotate = createObservationAnnotator();

  const row = evals.OBSERVATION_ANNOTATIONS.find((r) => r.evidenceId === 'confirmation-deploy-v17');
  assert.ok(row, 'the table must carry a row for confirmation-deploy-v17, or this row tests nothing');

  const mismatchedItem = {
    id: row.evidenceId,
    trialId: `trial-${row.evidenceId}`,
    kind: 'deploy',
    source: 'deployments/payments',
    observedAt: '2026-01-01T00:00:00.000Z',
    statement: 'a statement the table was never reviewed against',
    rawRef: `replay://deployments/payments/${row.evidenceId}`,
  };

  assert.throws(
    () => annotate(row.identity, mismatchedItem),
    (error) => error instanceof Error && error.message.includes(row.evidenceId),
    "must throw a plain Error whose message names the evidence id",
  );
});

/* ============================================================================
 * The lane: scriptedNodes(record) / modelNodes(record, port), wired
 * ==========================================================================*/

function executionInputFor(scenario) {
  return {
    experimentId: 'aic-123s3b-observation-merge',
    exampleId: `example-${scenario.id}`,
    scenarioId: scenario.id,
    fixture: scenario.fixture,
    runId: `run-observation-merge-${scenario.id}`,
    threadId: `thread-observation-merge-${scenario.id}`,
    metadata: {},
  };
}

test('scriptedNodes(record) and modelNodes(record, port), replayed through execute_investigation for every calibration and hold-out scenario, produce identical state.evidence between the two arms, carrying an observation exactly on the items OBSERVATION_ANNOTATIONS gives non-empty facts', async () => {
  const { scriptedNodes, modelNodes } = await import('../scripts/lane-arms.mjs');
  const refusingPort = {
    async complete() {
      throw new Error('execute_investigation must never reach a model port');
    },
  };
  const rowsByKey = new Map(
    evals.OBSERVATION_ANNOTATIONS.map((row) => [`${row.identity}|${row.evidenceId}`, row]),
  );

  assert.ok(evals.REPLAY_SCENARIOS.length > 0, 'REPLAY_SCENARIOS must not be empty, or this sweep checks nothing');

  for (const scenario of evals.REPLAY_SCENARIOS) {
    const scripted = scriptedNodes(executionInputFor(scenario));
    const model = modelNodes(executionInputFor(scenario), refusingPort);

    // eslint-disable-next-line no-await-in-loop -- one scenario's replay at a time
    const scriptedUpdate = await scripted.execute_investigation({ evidence: [] });
    // eslint-disable-next-line no-await-in-loop -- one scenario's replay at a time
    const modelUpdate = await model.execute_investigation({ evidence: [] });

    assert.deepEqual(
      scriptedUpdate.evidence,
      modelUpdate.evidence,
      `${scenario.id}: the scripted and model arms must replay identical evidence`,
    );

    for (const item of scriptedUpdate.evidence) {
      const entry = scenario.fixture.entries.find(
        (candidate) =>
          candidate.result.status === 'ok' && candidate.result.output.some((output) => output.id === item.id),
      );
      assert.ok(entry, `${scenario.id}: replayed item ${item.id} must trace back to one recorded fixture entry`);
      const identity = replayIdentity(entry.toolId, entry.input);
      const row = rowsByKey.get(`${identity}|${item.id}`);
      assert.ok(row, `${scenario.id}: no OBSERVATION_ANNOTATIONS row for evidence ${item.id}`);

      if (row.facts.length === 0) {
        assert.equal(
          'observation' in item,
          false,
          `${scenario.id}: ${item.id} has no facts in the table and must carry no observation key`,
        );
      } else {
        assert.deepEqual(
          item.observation,
          { version: domain.EXPECTED_OBSERVATION_VERSION, facts: row.facts },
          `${scenario.id}: ${item.id} must carry the table's facts as its observation`,
        );
        domain.EvidenceSchema.parse(item);
      }
    }
  }
});

/* ============================================================================
 * describeState: evidence[].observation is never shown to a model role
 * ==========================================================================*/

function capturingPort() {
  const requests = [];
  return {
    requests,
    port: {
      async complete(request) {
        requests.push(request);
        throw new Error('stop here: this row reads only the request the role sent');
      },
    },
  };
}

function stateWithEvidence(evidenceItem) {
  return {
    incident: scopedIncident('incident-merge-prompt'),
    hypotheses: [{ id: 'h-1', statement: 'a candidate cause', createdBy: 'initial' }],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [evidenceItem],
    assessments: [],
    control: {
      runId: 'run-observation-merge-prompt',
      schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
      statusRulesVersion: domain.STATUS_RULES_VERSION,
      phase: 'normalizing',
      maxIterations: 4,
      llmCallBudget: 8,
      reservedChallengeBudget: 2,
      challengeRounds: 0,
      iterationsUsed: 0,
      llmCallsUsed: 0,
      resumeCount: 0,
      humanReview: false,
    },
  };
}

test("describeState strips evidence[].observation from what a model role is shown: interpret_residual_evidence's prompt is byte-identical whether or not the state's evidence item carries an observation, and never contains the key or a fact value unique to it", async () => {
  const baseEvidence = {
    id: 'evidence-1',
    trialId: 'trial-1',
    kind: 'deploy',
    source: 'deploy-log',
    observedAt: '2026-01-01T00:00:00.000Z',
    statement: 'checkout-v42 rolled out at 00:00',
    rawRef: 'deploy/42',
  };
  const observation = {
    version: domain.EXPECTED_OBSERVATION_VERSION,
    facts: [
      { form: 'signal-state', subject: 'checkout', window: 'incident', signal: 'error-rate', state: 'elevated' },
    ],
  };
  const evidenceWithObservation = { ...baseEvidence, observation };
  domain.EvidenceSchema.parse(evidenceWithObservation);

  const at = () => '2026-01-01T01:00:00.000Z';

  const withoutObservation = capturingPort();
  await roles
    .createModelInterpretResidualEvidence({ port: withoutObservation.port, at })(stateWithEvidence(baseEvidence))
    .catch(() => {});

  const withObservation = capturingPort();
  await roles
    .createModelInterpretResidualEvidence({ port: withObservation.port, at })(
      stateWithEvidence(evidenceWithObservation),
    )
    .catch(() => {});

  assert.equal(withoutObservation.requests.length, 1);
  assert.equal(withObservation.requests.length, 1);
  assert.equal(
    withObservation.requests[0].prompt,
    withoutObservation.requests[0].prompt,
    'the prompt must not change when the state evidence gains an observation',
  );
  assert.equal(
    withObservation.requests[0].prompt.includes('observation'),
    false,
    'the prompt must never carry the key "observation"',
  );
  assert.equal(
    withObservation.requests[0].prompt.includes('error-rate'),
    false,
    'the prompt must never carry a fact value unique to the observation channel',
  );
});
