/**
 * AIC-124 slice b: the graph half of the deterministic prediction path.
 *
 * Slice a (`packages/domain`) gave `derivePredictions` and
 * `evaluatePredictionObservations` a caller-supplied template table. This
 * slice wires it: `PREDICTION_TEMPLATES`, the frozen mechanism -> template
 * table classified against `@aic/evals`'s `ROOT_CAUSE_MECHANISMS`, and the
 * two canonical nodes. `createDerivePredictions` calls `derivePredictions`
 * with it; `createEvaluatePredictions` only calls
 * `evaluatePredictionObservations` with it and never derives — derivation is
 * `createDerivePredictions`'s job alone, and a challenge alternative gets its
 * predictions from the kernel's challenge wrapper calling `derive_predictions`
 * before execution.
 *
 * `@aic/graph` cannot import `@aic/evals` (evals depends on graph); this test
 * file can, and uses it as the independent check that the template table's
 * key set matches the mechanism vocabulary exactly, and that no template
 * leaks a corpus id or subject.
 *
 * Lane wiring — which graph edge calls these nodes — is not this slice's
 * concern; every row here calls a node factory directly against a hand-built
 * `IncidentState`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as graph from '@aic/graph';
import { OBSERVATION_ANNOTATIONS, REPLAY_SCENARIOS, ROOT_CAUSE_MECHANISMS } from '@aic/evals';

import { scopedIncident } from './fixtures/scoped-incident.mjs';

const ASOF = '2026-09-28T09:00:00.000Z';

function requireExport(name) {
  assert.equal(
    typeof graph[name],
    'function',
    `@aic/graph must export ${name}`,
  );
  return graph[name];
}

function requirePredictionTemplates() {
  assert.ok(
    graph.PREDICTION_TEMPLATES !== undefined,
    '@aic/graph must export PREDICTION_TEMPLATES',
  );
  return graph.PREDICTION_TEMPLATES;
}

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

function baseControl(overrides = {}) {
  return {
    runId: 'run-prediction-nodes',
    schemaVersion: domain.INCIDENT_STATE_SCHEMA_VERSION,
    statusRulesVersion: domain.STATUS_RULES_VERSION,
    phase: 'investigating',
    maxIterations: 4,
    llmCallBudget: 8,
    reservedChallengeBudget: 2,
    challengeRounds: 0,
    iterationsUsed: 0,
    llmCallsUsed: 0,
    resumeCount: 0,
    humanReview: false,
    ...overrides,
  };
}

function state(overrides = {}) {
  return {
    incident: scopedIncident('incident-prediction-nodes'),
    hypotheses: [],
    predictions: [],
    tests: [],
    trials: [],
    evidence: [],
    assessments: [],
    control: baseControl(),
    ...overrides,
  };
}

function hypothesis(id, overrides = {}) {
  return {
    id,
    statement: `${id} statement`,
    createdBy: 'initial',
    cause: { component: 'checkout-db-pool', mechanism: 'connection-pool-exhaustion' },
    ...overrides,
  };
}

function evidenceItem(id, facts, overrides = {}) {
  const base = {
    id,
    trialId: `trial-${id}`,
    kind: 'metric',
    source: 'metrics',
    observedAt: ASOF,
    statement: `evidence recorded as ${id}`,
    rawRef: `replay://evidence/${id}`,
  };
  if (facts !== undefined) {
    base.observation = { version: domain.EXPECTED_OBSERVATION_VERSION, facts };
  }
  return { ...base, ...overrides };
}

/* -------------------------------------------------------------------------- */
/* 1. PREDICTION_TEMPLATES                                                    */
/* -------------------------------------------------------------------------- */

test('PREDICTION_TEMPLATES.byMechanism carries exactly one key per ROOT_CAUSE_MECHANISMS entry, in both directions', () => {
  const templates = requirePredictionTemplates();
  const templateKeys = Object.keys(templates.byMechanism).sort();
  const mechanismKeys = [...ROOT_CAUSE_MECHANISMS].sort();
  assert.deepEqual(
    templateKeys,
    mechanismKeys,
    'graph cannot import evals in production, but this test can, and the two vocabularies must name exactly the same mechanisms',
  );
});

test('PREDICTION_TEMPLATES.version is prediction-templates-v1', () => {
  const templates = requirePredictionTemplates();
  assert.equal(templates.version, 'prediction-templates-v1');
});

test('every template observation parses as an ExpectedObservation once a subject is added', () => {
  const templates = requirePredictionTemplates();
  for (const mechanismTemplates of Object.values(templates.byMechanism)) {
    for (const tmpl of mechanismTemplates) {
      for (const observation of [...tmpl.expectedIfTrue, ...tmpl.expectedIfFalse]) {
        const parsed = domain.ExpectedObservationSchema.safeParse({
          ...observation,
          subject: 'placeholder-subject',
        });
        assert.ok(
          parsed.success,
          `template ${tmpl.key} observation must parse as ExpectedObservation once a subject is added: ${JSON.stringify(observation)} (${JSON.stringify(parsed.error?.issues)})`,
        );
      }
    }
  }
});

test('every template statement is non-empty', () => {
  const templates = requirePredictionTemplates();
  for (const mechanismTemplates of Object.values(templates.byMechanism)) {
    for (const tmpl of mechanismTemplates) {
      assert.equal(typeof tmpl.statement, 'string');
      assert.ok(tmpl.statement.length > 0, `template ${tmpl.key} must carry a non-empty statement`);
    }
  }
});

test('PREDICTION_TEMPLATES is deeply frozen', () => {
  const templates = requirePredictionTemplates();
  assert.ok(Object.isFrozen(templates), 'the top-level table must be frozen');
  assert.ok(Object.isFrozen(templates.byMechanism), 'byMechanism must be frozen');
  for (const mechanismTemplates of Object.values(templates.byMechanism)) {
    assert.ok(Object.isFrozen(mechanismTemplates), 'each mechanism template array must be frozen');
    for (const tmpl of mechanismTemplates) {
      assert.ok(Object.isFrozen(tmpl), `template ${tmpl.key} must be frozen`);
      assert.ok(Object.isFrozen(tmpl.expectedIfTrue), `template ${tmpl.key}.expectedIfTrue must be frozen`);
      assert.ok(Object.isFrozen(tmpl.expectedIfFalse), `template ${tmpl.key}.expectedIfFalse must be frozen`);
      for (const observation of [...tmpl.expectedIfTrue, ...tmpl.expectedIfFalse]) {
        assert.ok(Object.isFrozen(observation), `an observation of template ${tmpl.key} must be frozen`);
      }
    }
  }
});

test('never names a corpus evidence id, replay scenario id, or OBSERVATION_ANNOTATIONS subject: a template commits to the mechanism only, and derivePredictions fills the subject in from the hypothesis', () => {
  const templates = requirePredictionTemplates();
  const serialized = JSON.stringify(templates);

  const scenarioIds = REPLAY_SCENARIOS.map((scenario) => scenario.id);
  const evidenceIds = REPLAY_SCENARIOS.flatMap((scenario) =>
    scenario.fixture.entries.flatMap((entry) =>
      entry.result.status === 'ok' ? entry.result.output.map((item) => item.id) : [],
    ),
  );
  const annotationSubjects = [
    ...new Set(OBSERVATION_ANNOTATIONS.flatMap((row) => row.facts.map((fact) => fact.subject))),
  ];

  assert.ok(scenarioIds.length > 0, 'fixture sanity: REPLAY_SCENARIOS must carry ids to check against');
  assert.ok(evidenceIds.length > 0, 'fixture sanity: REPLAY_SCENARIOS must carry evidence ids to check against');
  assert.ok(annotationSubjects.length > 0, 'fixture sanity: OBSERVATION_ANNOTATIONS must carry subjects to check against');

  for (const id of scenarioIds) {
    assert.ok(!serialized.includes(id), `PREDICTION_TEMPLATES must not name the corpus scenario id ${id}`);
  }
  for (const id of evidenceIds) {
    assert.ok(!serialized.includes(id), `PREDICTION_TEMPLATES must not name the corpus evidence id ${id}`);
  }
  for (const subject of annotationSubjects) {
    assert.ok(!serialized.includes(subject), `PREDICTION_TEMPLATES must not name the corpus subject ${subject}`);
  }
});

/**
 * Every field, pinned to a literal so an edit to the table is visible in the
 * diff of this test rather than only in behaviour. The statement per
 * mechanism is the mechanism's own one-line definition
 * (`packages/evals/src/structural-ground-truth.ts`'s `ROOT_CAUSE_MECHANISMS`
 * doc comment), reused for every template under that mechanism, because a
 * template's statement is derived from the mechanism's definition only.
 */
const EXPECTED_PREDICTION_TEMPLATES = {
  version: 'prediction-templates-v1',
  byMechanism: {
    'deployment-regression': [
      {
        key: 'deployment-before-onset',
        statement: 'a change shipped by a deployment broke the service',
        expectedIfTrue: [
          { form: 'deployment-in-window', window: 'pre-onset', presence: 'present' },
        ],
        expectedIfFalse: [
          { form: 'deployment-in-window', window: 'pre-onset', presence: 'absent' },
        ],
      },
      {
        key: 'error-rate-elevated',
        statement: 'a change shipped by a deployment broke the service',
        expectedIfTrue: [
          { form: 'signal-state', window: 'incident', signal: 'error-rate', state: 'elevated' },
        ],
        expectedIfFalse: [
          { form: 'signal-state', window: 'incident', signal: 'error-rate', state: 'normal' },
        ],
      },
    ],
    'connection-pool-exhaustion': [
      {
        key: 'pool-at-limit',
        statement: 'every connection in a pool stayed occupied',
        expectedIfTrue: [
          { form: 'signal-state', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
        ],
        expectedIfFalse: [
          { form: 'signal-state', window: 'incident', signal: 'connection-pool', state: 'normal' },
        ],
      },
    ],
    'cache-stampede': [
      {
        key: 'workers-at-limit',
        statement: 'a burst of cache refills exhausted request workers',
        expectedIfTrue: [
          { form: 'signal-state', window: 'incident', signal: 'worker-saturation', state: 'at-limit' },
        ],
        expectedIfFalse: [
          { form: 'signal-state', window: 'incident', signal: 'worker-saturation', state: 'normal' },
        ],
      },
      {
        key: 'refill-activity',
        statement: 'a burst of cache refills exhausted request workers',
        expectedIfTrue: [
          { form: 'log-class-in-window', window: 'incident', logClass: 'activity', presence: 'present' },
        ],
        expectedIfFalse: [
          { form: 'log-class-in-window', window: 'incident', logClass: 'activity', presence: 'absent' },
        ],
      },
    ],
  },
};

test('pins the exact template table content: version, and every mechanism, key, and observation list', () => {
  const templates = requirePredictionTemplates();
  assert.deepEqual(templates, EXPECTED_PREDICTION_TEMPLATES);
});

/* -------------------------------------------------------------------------- */
/* 2. createDerivePredictions                                                 */
/* -------------------------------------------------------------------------- */

test('createDerivePredictions() returns an InvestigationNode whose predictions deepEqual derivePredictions over the same state, using PREDICTION_TEMPLATES by default', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const templates = requirePredictionTemplates();
  const node = createDerivePredictions();
  const testState = state({
    hypotheses: [hypothesis('h-1')],
  });

  const result = node(testState);

  const expected = domain.derivePredictions({
    hypotheses: testState.hypotheses,
    predictions: testState.predictions,
    templates,
  });
  assert.ok(expected.length > 0, 'fixture sanity: the hypothesis must actually derive at least one prediction');
  assert.deepEqual(result, { predictions: expected });
});

test('createDerivePredictions() returns predictions: [] when no hypothesis is eligible for derivation', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const node = createDerivePredictions();
  const testState = state({
    hypotheses: [hypothesis('h-1', { cause: undefined })],
  });

  assert.deepEqual(node(testState), { predictions: [] });
});

test('createDerivePredictions accepts a caller-supplied templates option, overriding the default table', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const customTemplates = {
    version: 'custom-templates-v1',
    byMechanism: {
      'connection-pool-exhaustion': [
        {
          key: 'custom-key',
          statement: 'a custom template',
          expectedIfTrue: [
            { form: 'signal-state', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
          ],
          expectedIfFalse: [],
        },
      ],
    },
  };
  const node = createDerivePredictions({ templates: customTemplates });
  const testState = state({ hypotheses: [hypothesis('h-1')] });

  const result = node(testState);

  assert.equal(result.predictions.length, 1);
  assert.equal(result.predictions[0].statement, 'a custom template (checkout-db-pool)');
});

/* -------------------------------------------------------------------------- */
/* 3. createEvaluatePredictions                                               */
/* -------------------------------------------------------------------------- */

/**
 * Runs `derive` (a `createDerivePredictions()` node) over `baseState` and
 * merges what it derived into `baseState.predictions` by id, the way a real
 * caller would apply a `derive_predictions` step before `evaluate_predictions`
 * runs. `createEvaluatePredictions` itself never derives: see "the evaluate
 * node never derives predictions itself" below.
 */
function deriveInto(baseState, derive) {
  const { predictions } = derive(baseState);
  return {
    ...baseState,
    predictions: domain.upsertById(baseState.predictions, predictions),
  };
}

test('createEvaluatePredictions({asOf}) confirms a derived prediction against a matching typed fact and returns one rule-produced supports assessment', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const node = createEvaluatePredictions({ asOf });
  const baseState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [
      evidenceItem('e-1', [
        { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
      ]),
    ],
  });
  const testState = deriveInto(baseState, derive);

  const result = node(testState);

  assert.equal(result.predictions.length, 1, 'the derived prediction must be returned, since its status changed to confirmed');
  const [prediction] = result.predictions;
  assert.equal(prediction.hypothesisId, 'h-1');
  assert.equal(prediction.status, 'confirmed');

  assert.equal(result.assessments.length, 1);
  const [assessment] = result.assessments;
  assert.equal(assessment.producedBy, 'rule');
  assert.equal(assessment.effect, 'supports');
  assert.equal(assessment.hypothesisId, 'h-1');
  assert.equal(assessment.predictionId, prediction.id);
  assert.equal(assessment.evidenceId, 'e-1');
});

test('the evaluate node never derives predictions itself: a hypothesis with a cause and a matching fact but no predictions in state yields no predictions and no assessments', () => {
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const node = createEvaluatePredictions({ asOf });
  const testState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [
      evidenceItem('e-1', [
        { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
      ]),
    ],
  });

  assert.deepEqual(
    node(testState),
    { predictions: [], assessments: [] },
    'derivation is createDerivePredictions\'s job alone; with no prediction in state there is nothing for this node to evaluate',
  );
});

test('does not re-emit an already-decided prediction of one hypothesis while newly confirming another hypothesis\'s untested prediction, both derived beforehand', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const node = createEvaluatePredictions({ asOf });

  const baseState = state({
    hypotheses: [
      hypothesis('h-leader'),
      hypothesis('h-alt', {
        createdBy: 'challenge',
        cause: { component: 'inventory-api-pool', mechanism: 'connection-pool-exhaustion' },
      }),
    ],
  });
  const { predictions: derivedPredictions } = derive(baseState);
  const leaderDerived = derivedPredictions.find((prediction) => prediction.hypothesisId === 'h-leader');
  const altDerived = derivedPredictions.find((prediction) => prediction.hypothesisId === 'h-alt');
  assert.ok(leaderDerived, 'fixture sanity: h-leader must derive a prediction');
  assert.ok(altDerived, 'fixture sanity: h-alt must derive a prediction');
  const leaderConfirmed = { ...leaderDerived, status: 'confirmed' };

  const testState = {
    ...baseState,
    predictions: domain.upsertById([], [leaderConfirmed, altDerived]),
    evidence: [
      evidenceItem('e-1', [
        { form: 'signal-state', subject: 'inventory-api-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
      ]),
    ],
  };

  const result = node(testState);

  assert.equal(
    result.predictions.length,
    1,
    'only the h-alt prediction changes: the h-leader prediction is already confirmed (decided and monotone) and unchanged',
  );
  assert.equal(result.predictions[0].hypothesisId, 'h-alt');
  assert.equal(result.predictions[0].status, 'confirmed');
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].hypothesisId, 'h-alt');
});

test('refutes a derived prediction with exactly one rule-produced contradicts assessment when a fact reads its signal as normal', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const node = createEvaluatePredictions({ asOf });
  const baseState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [
      evidenceItem('e-1', [
        { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'normal' },
      ]),
    ],
  });
  const testState = deriveInto(baseState, derive);

  const result = node(testState);

  assert.equal(result.predictions.length, 1);
  const [prediction] = result.predictions;
  assert.equal(prediction.hypothesisId, 'h-1');
  assert.equal(prediction.status, 'refuted');

  assert.equal(result.assessments.length, 1);
  const [assessment] = result.assessments;
  assert.equal(assessment.producedBy, 'rule');
  assert.equal(assessment.effect, 'contradicts');
  assert.equal(assessment.hypothesisId, 'h-1');
  assert.equal(assessment.predictionId, prediction.id);
  assert.equal(assessment.evidenceId, 'e-1');
});

test('deriving then evaluating a hypothesis with no cause yields no predictions and no assessments', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const node = createEvaluatePredictions({ asOf });
  const baseState = state({
    hypotheses: [hypothesis('h-1', { cause: undefined })],
  });
  const testState = deriveInto(baseState, derive);

  assert.deepEqual(node(testState), { predictions: [], assessments: [] });
});

test('evidence observed after asOf is ignored: the derived prediction stays untested and no assessment is produced', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const node = createEvaluatePredictions({ asOf });
  const afterAsOf = '2026-09-28T09:00:00.001Z';
  const baseState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [
      evidenceItem(
        'e-1',
        [{ form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' }],
        { observedAt: afterAsOf },
      ),
    ],
  });
  const testState = deriveInto(baseState, derive);
  assert.ok(testState.predictions.length > 0, 'fixture sanity: the hypothesis must actually derive a prediction');

  const result = node(testState);

  assert.equal(result.assessments.length, 0, 'evidence observed after asOf must contribute no assessment');
  assert.deepEqual(result.predictions, [], 'with the confirming evidence excluded by the as-of cut, the derived prediction stays untested, unchanged from state, so nothing is re-emitted');
});

test('calling the node twice, applying the first result to the state by id (upsert) between calls, is idempotent: the second call finds no further changes', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const node = createEvaluatePredictions({ asOf });
  const baseState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [
      evidenceItem('e-1', [
        { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
      ]),
    ],
  });
  const testState = deriveInto(baseState, derive);

  const first = node(testState);
  const nextState = {
    ...testState,
    predictions: domain.upsertById(testState.predictions, first.predictions),
    assessments: domain.upsertById(testState.assessments, first.assessments),
  };

  assert.ok(first.predictions.length > 0, 'fixture sanity: the first call must actually change something');

  const second = node(nextState);

  assert.deepEqual(second, { predictions: [], assessments: [] });
});

test('deriving then evaluating a scripted-control-shaped hypothesis ({id, statement, createdBy}, no cause key at all) yields predictions: [] and assessments: []', () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const node = createEvaluatePredictions({ asOf });
  const baseState = state({
    hypotheses: [{ id: 'h-scripted', statement: 'a scripted control hypothesis', createdBy: 'initial' }],
  });
  const testState = deriveInto(baseState, derive);

  assert.deepEqual(node(testState), { predictions: [], assessments: [] });
});

/* -------------------------------------------------------------------------- */
/* 4. R': createEvaluatePredictions through the canonical status derivation   */
/* -------------------------------------------------------------------------- */

test("R': a rule assessment alone yields candidate (below the two-independent-support threshold for both supported and corroborated)", () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const createDeriveHypothesisState = requireExport('createDeriveHypothesisState');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const evaluate = createEvaluatePredictions({ asOf });
  const deriveState = createDeriveHypothesisState();

  const baseState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [
      evidenceItem('e-1', [
        { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
      ]),
    ],
  });
  const testState = deriveInto(baseState, derive);

  const evaluated = evaluate(testState);
  const afterEvaluate = {
    ...testState,
    predictions: domain.upsertById(testState.predictions, evaluated.predictions),
    assessments: domain.upsertById(testState.assessments, evaluated.assessments),
  };

  assert.deepEqual(
    deriveState(afterEvaluate),
    {},
    'the canonical derive_hypothesis_state node must accept the resulting state without refusing it',
  );

  const status = domain.deriveHypothesisStatus({
    hypothesisId: 'h-1',
    predictions: afterEvaluate.predictions,
    assessments: afterEvaluate.assessments,
    evidence: afterEvaluate.evidence,
  });

  assert.equal(status, 'candidate');
});

test("R': the rule assessment plus one medium llm-produced support on a different evidence item yields supported", () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const evaluate = createEvaluatePredictions({ asOf });

  const baseState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [
      evidenceItem('e-1', [
        { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
      ]),
      evidenceItem('e-2', undefined),
    ],
  });
  const testState = deriveInto(baseState, derive);

  const evaluated = evaluate(testState);
  const afterEvaluate = {
    ...testState,
    predictions: domain.upsertById(testState.predictions, evaluated.predictions),
    assessments: domain.upsertById(testState.assessments, evaluated.assessments),
  };
  const [prediction] = afterEvaluate.predictions;

  const modelAssessment = {
    id: 'assessment-llm-1',
    evidenceId: 'e-2',
    hypothesisId: 'h-1',
    predictionId: prediction.id,
    effect: 'supports',
    strength: 'medium',
    rationale: 'the residual evidence also points at the connection pool',
    producedBy: 'llm',
    promptVersion: 'test-prompt-v1',
    at: ASOF,
  };
  const withModelSupport = {
    ...afterEvaluate,
    assessments: domain.upsertById(afterEvaluate.assessments, [modelAssessment]),
  };

  const status = domain.deriveHypothesisStatus({
    hypothesisId: 'h-1',
    predictions: withModelSupport.predictions,
    assessments: withModelSupport.assessments,
    evidence: withModelSupport.evidence,
  });

  assert.equal(status, 'supported');
});

test("R': the same two supports without the confirming fact (the prediction stays untested) yields corroborated, never supported", () => {
  const createDerivePredictions = requireExport('createDerivePredictions');
  const createEvaluatePredictions = requireExport('createEvaluatePredictions');
  const asOf = () => ASOF;
  const derive = createDerivePredictions();
  const evaluate = createEvaluatePredictions({ asOf });

  const baseState = state({
    hypotheses: [hypothesis('h-1')],
    evidence: [evidenceItem('e-1', undefined), evidenceItem('e-2', undefined)],
  });
  const testState = deriveInto(baseState, derive);

  const evaluated = evaluate(testState);
  assert.equal(evaluated.assessments.length, 0, 'fixture sanity: with no typed fact, no rule assessment is produced');
  const afterEvaluate = {
    ...testState,
    predictions: domain.upsertById(testState.predictions, evaluated.predictions),
  };
  const [prediction] = afterEvaluate.predictions;
  assert.equal(prediction.status, 'untested', 'fixture sanity: with no matching fact the prediction stays untested');

  const supports = [
    {
      id: 'assessment-support-1',
      evidenceId: 'e-1',
      hypothesisId: 'h-1',
      predictionId: prediction.id,
      effect: 'supports',
      strength: 'medium',
      rationale: 'circumstantial support one',
      producedBy: 'llm',
      promptVersion: 'test-prompt-v1',
      at: ASOF,
    },
    {
      id: 'assessment-support-2',
      evidenceId: 'e-2',
      hypothesisId: 'h-1',
      predictionId: prediction.id,
      effect: 'supports',
      strength: 'medium',
      rationale: 'circumstantial support two',
      producedBy: 'llm',
      promptVersion: 'test-prompt-v1',
      at: ASOF,
    },
  ];
  const withSupports = {
    ...afterEvaluate,
    assessments: domain.upsertById(afterEvaluate.assessments, supports),
  };

  const status = domain.deriveHypothesisStatus({
    hypothesisId: 'h-1',
    predictions: withSupports.predictions,
    assessments: withSupports.assessments,
    evidence: withSupports.evidence,
  });

  assert.equal(status, 'corroborated');
  assert.notEqual(status, 'supported');
});
