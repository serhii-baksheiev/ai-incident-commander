/**
 * AIC-124 slice a: the pure domain half of the deterministic prediction path
 * — `derivePredictions` (structured cause/mechanism -> new Predictions, given
 * a caller-supplied template table) and `evaluatePredictionObservations`
 * (typed ExpectedObservation vs typed ObservedFact -> rule-produced
 * verdicts and EvidenceAssessments). No LLM judge; both functions are pure
 * and synchronous.
 *
 * The mechanism -> template TABLE and the graph nodes that wire it belong to
 * slice b (packages/graph). Here the template table is a parameter the
 * caller supplies — see the fixtures below.
 *
 * Every expectation is a hand-written literal; none is read back off the
 * function under test (`.claude/rules/invariants.md`, "the independent-oracle
 * invariant" — this is domain business logic, not a security/governance
 * mechanism, but the same discipline is followed for the id recipes, which
 * are computed here from the spec's own words, not imported from production).
 */
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';

/* -------------------------------------------------------------------------- */
/* shared fixtures                                                            */
/* -------------------------------------------------------------------------- */

const ASOF = '2026-09-28T08:00:00.000Z';

function requireDerivePredictions() {
  assert.equal(
    typeof domain.derivePredictions,
    'function',
    '@aic/domain must publish derivePredictions(options)',
  );
  return domain.derivePredictions;
}

function requireEvaluatePredictionObservations() {
  assert.equal(
    typeof domain.evaluatePredictionObservations,
    'function',
    '@aic/domain must publish evaluatePredictionObservations(options)',
  );
  return domain.evaluatePredictionObservations;
}

function requireDeriveHypothesisStatus() {
  assert.equal(
    typeof domain.deriveHypothesisStatus,
    'function',
    '@aic/domain must publish deriveHypothesisStatus(options)',
  );
  return domain.deriveHypothesisStatus;
}

function hypothesis(id, overrides = {}) {
  return {
    id,
    statement: `${id} statement`,
    createdBy: 'initial',
    cause: { component: 'checkout', mechanism: 'deployment-regression' },
    ...overrides,
  };
}

function template(key, overrides = {}) {
  return {
    key,
    statement: `template ${key} statement`,
    expectedIfTrue: [
      { form: 'deployment-in-window', window: 'pre-onset', presence: 'present' },
    ],
    expectedIfFalse: [
      { form: 'deployment-in-window', window: 'pre-onset', presence: 'absent' },
    ],
    ...overrides,
  };
}

const TEMPLATE_A = template('deploy-regression-onset');
const TEMPLATE_B = template('deploy-regression-signal', {
  expectedIfTrue: [
    { form: 'signal-state', window: 'incident', signal: 'error-rate', state: 'elevated' },
  ],
  expectedIfFalse: [
    { form: 'signal-state', window: 'incident', signal: 'error-rate', state: 'normal' },
  ],
});

const TEMPLATES = Object.freeze({
  version: 'templates-v1',
  byMechanism: Object.freeze({
    'deployment-regression': Object.freeze([TEMPLATE_A, TEMPLATE_B]),
  }),
});

/**
 * The exact id recipe the spec gives: `'prediction-' + sha256 hex of
 * JSON.stringify(canonicalJson([hypothesisId, template.key,
 * templates.version]))`. Computed independently here, in the test, from the
 * spec's own words — not imported from the module under test.
 */
function expectedPredictionId(hypothesisId, templateKey, templatesVersion) {
  const digest = createHash('sha256')
    .update(JSON.stringify(domain.canonicalJson([hypothesisId, templateKey, templatesVersion])))
    .digest('hex');
  return `prediction-${digest}`;
}

/** Same recipe, for the rule-produced EvidenceAssessment id. */
function expectedAssessmentId(predictionId, evidenceId, evaluationVersion) {
  const digest = createHash('sha256')
    .update(JSON.stringify(domain.canonicalJson([predictionId, evidenceId, evaluationVersion])))
    .digest('hex');
  return `rule-${digest}`;
}

function evidenceItem(id, facts, overrides = {}) {
  const base = {
    id,
    trialId: `trial-${id}`,
    kind: 'deploy',
    source: 'deployment-history',
    observedAt: ASOF,
    statement: `evidence recorded as ${id}`,
    rawRef: `replay://evidence/${id}`,
  };
  if (facts !== undefined) {
    base.observation = { version: domain.EXPECTED_OBSERVATION_VERSION, facts };
  }
  return { ...base, ...overrides };
}

function basePrediction(overrides = {}) {
  return {
    id: 'prediction-base',
    hypothesisId: 'hypothesis-base',
    statement: 'the checkout deploy preceded the incident',
    observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
    expectedIfTrue: [
      { form: 'deployment-in-window', subject: 'checkout', window: 'incident', presence: 'present' },
    ],
    expectedIfFalse: [],
    status: 'untested',
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* derivePredictions: which hypotheses are eligible                          */
/* -------------------------------------------------------------------------- */

test('derivePredictions produces nothing for a hypothesis carrying no cause', () => {
  const derivePredictions = requireDerivePredictions();
  const noCause = { id: 'h-no-cause', statement: 'no cause yet', createdBy: 'initial' };

  const result = derivePredictions({ hypotheses: [noCause], predictions: [], templates: TEMPLATES });

  assert.deepEqual(result, []);
});

test('derivePredictions produces nothing for a mechanism with no templates', () => {
  const derivePredictions = requireDerivePredictions();
  const untemplatedMechanism = hypothesis('h-untemplated', {
    cause: { component: 'checkout', mechanism: 'no-such-mechanism' },
  });

  const result = derivePredictions({
    hypotheses: [untemplatedMechanism],
    predictions: [],
    templates: TEMPLATES,
  });

  assert.deepEqual(result, []);
});

test('derivePredictions produces nothing for a mechanism name that only Object.prototype supplies (toString), even when the prototype carries a matching template array', () => {
  const derivePredictions = requireDerivePredictions();
  const inheritedTemplate = template('inherited-template', {
    statement: 'must never be used: reached only through the prototype chain',
  });
  const maliciousProto = { toString: [inheritedTemplate] };
  const byMechanism = Object.assign(Object.create(maliciousProto), {
    'deployment-regression': [TEMPLATE_A],
  });
  const targetsToString = hypothesis('h-tostring', {
    cause: { component: 'checkout', mechanism: 'toString' },
  });

  const result = derivePredictions({
    hypotheses: [targetsToString],
    predictions: [],
    templates: { version: 'templates-v1', byMechanism },
  });

  assert.deepEqual(
    result,
    [],
    'a mechanism reachable only through Object.prototype must not be treated as a registered mechanism',
  );
});

for (const mechanism of ['constructor', '__proto__']) {
  test(`derivePredictions produces nothing for the inherited mechanism name ${mechanism}`, () => {
    const derivePredictions = requireDerivePredictions();
    const targetsInherited = hypothesis(`h-${mechanism}`, {
      cause: { component: 'checkout', mechanism },
    });

    const result = derivePredictions({
      hypotheses: [targetsInherited],
      predictions: [],
      templates: TEMPLATES,
    });

    assert.deepEqual(result, []);
  });
}

test('derivePredictions produces nothing for an empty cause.component', () => {
  const derivePredictions = requireDerivePredictions();
  const emptyComponent = hypothesis('h-empty-component', {
    cause: { component: '', mechanism: 'deployment-regression' },
  });

  const result = derivePredictions({
    hypotheses: [emptyComponent],
    predictions: [],
    templates: TEMPLATES,
  });

  assert.deepEqual(result, []);
});

test('derivePredictions produces nothing for a cause.component of 201 characters, one past the bound', () => {
  const derivePredictions = requireDerivePredictions();
  const tooLongComponent = hypothesis('h-long-component', {
    cause: { component: 'c'.repeat(201), mechanism: 'deployment-regression' },
  });

  const result = derivePredictions({
    hypotheses: [tooLongComponent],
    predictions: [],
    templates: TEMPLATES,
  });

  assert.deepEqual(result, []);
});

test('derivePredictions accepts a cause.component of exactly 200 characters, the bound', () => {
  const derivePredictions = requireDerivePredictions();
  const boundaryComponent = hypothesis('h-boundary-component', {
    cause: { component: 'c'.repeat(200), mechanism: 'deployment-regression' },
  });

  const result = derivePredictions({
    hypotheses: [boundaryComponent],
    predictions: [],
    templates: TEMPLATES,
  });

  assert.equal(result.length, 2, 'a valid 200-character component must still be eligible');
});

test('derivePredictions produces nothing for a hypothesis that already has a prediction, and does not reset it', () => {
  const derivePredictions = requireDerivePredictions();
  const decided = hypothesis('h-decided');
  const existingPrediction = {
    ...basePrediction({ hypothesisId: 'h-decided', status: 'confirmed' }),
    id: 'prediction-already-decided',
  };

  const result = derivePredictions({
    hypotheses: [decided],
    predictions: [existingPrediction],
    templates: TEMPLATES,
  });

  assert.deepEqual(result, [], 'a hypothesis that already has a prediction must be skipped, never re-derived');
});

/* -------------------------------------------------------------------------- */
/* derivePredictions: shape of what is emitted                                */
/* -------------------------------------------------------------------------- */

test('derivePredictions emits one prediction per template, in template order, for an eligible hypothesis', () => {
  const derivePredictions = requireDerivePredictions();
  const eligible = hypothesis('h-eligible');

  const result = derivePredictions({ hypotheses: [eligible], predictions: [], templates: TEMPLATES });

  assert.deepEqual(
    result.map((prediction) => prediction.statement),
    [TEMPLATE_A, TEMPLATE_B].map((tpl) => `${tpl.statement} (checkout)`),
  );
});

test('derivePredictions keeps hypotheses in input order across multiple eligible hypotheses', () => {
  const derivePredictions = requireDerivePredictions();
  const first = hypothesis('h-first');
  const second = hypothesis('h-second');

  const result = derivePredictions({
    hypotheses: [first, second],
    predictions: [],
    templates: { version: 'templates-v1', byMechanism: { 'deployment-regression': [TEMPLATE_A] } },
  });

  assert.deepEqual(result.map((prediction) => prediction.hypothesisId), ['h-first', 'h-second']);
});

test('derivePredictions sets every observation subject to the hypothesis cause component, and never resets an existing decided prediction of a sibling hypothesis', () => {
  const derivePredictions = requireDerivePredictions();
  const eligible = hypothesis('h-subject', {
    cause: { component: 'inventory-api', mechanism: 'deployment-regression' },
  });
  const decidedSibling = hypothesis('h-decided-sibling');
  const siblingExisting = {
    ...basePrediction({ hypothesisId: 'h-decided-sibling', status: 'refuted' }),
    id: 'prediction-sibling-decided',
  };

  const result = derivePredictions({
    hypotheses: [eligible, decidedSibling],
    predictions: [siblingExisting],
    templates: TEMPLATES,
  });

  assert.equal(result.length, 2, 'only the eligible hypothesis contributes new predictions');
  for (const prediction of result) {
    for (const observation of [...prediction.expectedIfTrue, ...prediction.expectedIfFalse]) {
      assert.equal(observation.subject, 'inventory-api');
    }
  }
});

test('derivePredictions gives each new prediction observationVersion, status untested, and a shape that parses under PredictionSchema', () => {
  const derivePredictions = requireDerivePredictions();
  const eligible = hypothesis('h-parses');

  const result = derivePredictions({ hypotheses: [eligible], predictions: [], templates: TEMPLATES });

  assert.equal(result.length, 2);
  for (const prediction of result) {
    assert.equal(prediction.observationVersion, domain.EXPECTED_OBSERVATION_VERSION);
    assert.equal(prediction.status, 'untested');
    assert.equal(prediction.hypothesisId, 'h-parses');
    assert.equal(
      domain.PredictionSchema.safeParse(prediction).success,
      true,
      `derived prediction must parse under PredictionSchema: ${JSON.stringify(prediction)}`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* derivePredictions: the id recipe                                          */
/* -------------------------------------------------------------------------- */

test('derivePredictions builds a deterministic id from hypothesisId, template key and templates version', () => {
  const derivePredictions = requireDerivePredictions();
  const eligible = hypothesis('h-id-recipe');

  const result = derivePredictions({ hypotheses: [eligible], predictions: [], templates: TEMPLATES });

  assert.deepEqual(
    result.map((prediction) => prediction.id),
    [
      expectedPredictionId('h-id-recipe', TEMPLATE_A.key, TEMPLATES.version),
      expectedPredictionId('h-id-recipe', TEMPLATE_B.key, TEMPLATES.version),
    ],
  );
});

test('derivePredictions gives the same id on a second call with identical inputs', () => {
  const derivePredictions = requireDerivePredictions();
  const eligible = hypothesis('h-id-stable');

  const first = derivePredictions({ hypotheses: [eligible], predictions: [], templates: TEMPLATES });
  const second = derivePredictions({ hypotheses: [eligible], predictions: [], templates: TEMPLATES });

  assert.deepEqual(first, second);
});

test('derivePredictions gives a different id when the hypothesisId differs, the template key differs, or the templates version differs', () => {
  const derivePredictions = requireDerivePredictions();
  const baseHypothesis = hypothesis('h-sensitivity-base');
  const otherHypothesis = hypothesis('h-sensitivity-other');
  const singleTemplateTable = (version) => ({
    version,
    byMechanism: { 'deployment-regression': [TEMPLATE_A] },
  });

  const [baseResult] = derivePredictions({
    hypotheses: [baseHypothesis],
    predictions: [],
    templates: singleTemplateTable('templates-v1'),
  });
  const [otherHypothesisResult] = derivePredictions({
    hypotheses: [otherHypothesis],
    predictions: [],
    templates: singleTemplateTable('templates-v1'),
  });
  const [otherKeyResult] = derivePredictions({
    hypotheses: [baseHypothesis],
    predictions: [],
    templates: { version: 'templates-v1', byMechanism: { 'deployment-regression': [TEMPLATE_B] } },
  });
  const [otherVersionResult] = derivePredictions({
    hypotheses: [baseHypothesis],
    predictions: [],
    templates: singleTemplateTable('templates-v2'),
  });

  assert.notEqual(otherHypothesisResult.id, baseResult.id, 'a different hypothesisId must change the id');
  assert.notEqual(otherKeyResult.id, baseResult.id, 'a different template key must change the id');
  assert.notEqual(otherVersionResult.id, baseResult.id, 'a different templates version must change the id');
});

/* -------------------------------------------------------------------------- */
/* derivePredictions: purity                                                  */
/* -------------------------------------------------------------------------- */

test('derivePredictions does not mutate its hypotheses, predictions or templates inputs', () => {
  const derivePredictions = requireDerivePredictions();
  const hypotheses = [hypothesis('h-purity')];
  const predictions = [];
  const hypothesesBefore = structuredClone(hypotheses);
  const predictionsBefore = structuredClone(predictions);
  const templatesBefore = structuredClone(TEMPLATES);

  derivePredictions({ hypotheses, predictions, templates: TEMPLATES });

  assert.deepEqual(hypotheses, hypothesesBefore);
  assert.deepEqual(predictions, predictionsBefore);
  assert.deepEqual(TEMPLATES, templatesBefore);
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: the version export                        */
/* -------------------------------------------------------------------------- */

test('publishes PREDICTION_EVALUATION_VERSION as prediction-evaluation-v1', () => {
  assert.equal(domain.PREDICTION_EVALUATION_VERSION, 'prediction-evaluation-v1');
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: presence forms                            */
/* -------------------------------------------------------------------------- */

test('confirms a prediction when the observed presence equals the expected presence, and produces one supports assessment', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-presence-confirm', hypothesisId: 'h-presence-confirm' });
  const evidence = evidenceItem('e-presence-confirm', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
  ]);

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions.length, 1);
  assert.equal(result.predictions[0].status, 'confirmed');
  assert.equal(result.assessments.length, 1);
  const [reportedAssessment] = result.assessments;
  assert.deepEqual(reportedAssessment, {
    id: expectedAssessmentId(prediction.id, evidence.id, domain.PREDICTION_EVALUATION_VERSION),
    evidenceId: evidence.id,
    hypothesisId: prediction.hypothesisId,
    predictionId: prediction.id,
    effect: 'supports',
    strength: 'medium',
    rationale: reportedAssessment.rationale,
    producedBy: 'rule',
    at: ASOF,
  });
  assert.ok(
    reportedAssessment.rationale.includes(domain.PREDICTION_EVALUATION_VERSION),
    'the rationale must name PREDICTION_EVALUATION_VERSION',
  );
  assert.equal('promptVersion' in reportedAssessment, false, 'a rule assessment must carry no promptVersion');
  assert.equal(domain.EvidenceAssessmentSchema.safeParse(reportedAssessment).success, true);
});

test('refutes a prediction when the observed presence is the opposite of the expected presence under complete coverage, and produces one contradicts assessment', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-presence-refute', hypothesisId: 'h-presence-refute' });
  const evidence = evidenceItem('e-presence-refute', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 0, coverage: 'complete' },
  ]);

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'refuted');
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].effect, 'contradicts');
});

test('leaves a prediction untestable, not refuted, when a zero count is observed under partial coverage (rule a: partial coverage never proves absence)', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-partial', hypothesisId: 'h-partial' });
  const evidence = evidenceItem('e-partial', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 0, coverage: 'partial' },
  ]);

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'untestable');
  assert.equal(result.assessments.length, 0, 'untestable is not a final verdict and produces no assessments');
});

test('the identical zero-count fact refutes once coverage is complete, proving the coverage bit is load-bearing', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const partialPrediction = basePrediction({ id: 'p-coverage-partial', hypothesisId: 'h-coverage' });
  const completePrediction = basePrediction({ id: 'p-coverage-complete', hypothesisId: 'h-coverage' });
  const partialEvidence = evidenceItem('e-coverage-partial', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 0, coverage: 'partial' },
  ]);
  const completeEvidence = evidenceItem('e-coverage-complete', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 0, coverage: 'complete' },
  ]);

  const partialResult = evaluatePredictionObservations({
    predictions: [partialPrediction],
    evidence: [partialEvidence],
    asOf: ASOF,
  });
  const completeResult = evaluatePredictionObservations({
    predictions: [completePrediction],
    evidence: [completeEvidence],
    asOf: ASOF,
  });

  assert.equal(partialResult.predictions[0].status, 'untestable');
  assert.equal(completeResult.predictions[0].status, 'refuted');
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: signal-state forms                        */
/* -------------------------------------------------------------------------- */

test('confirms a prediction when the observed signal state equals the expected state', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({
    id: 'p-signal-confirm',
    hypothesisId: 'h-signal-confirm',
    expectedIfTrue: [
      { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
    ],
  });
  const evidence = evidenceItem('e-signal-confirm', [
    { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
  ]);

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'confirmed');
});

test('refutes a prediction when the observed signal state differs from the expected state', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({
    id: 'p-signal-refute',
    hypothesisId: 'h-signal-refute',
    expectedIfTrue: [
      { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
    ],
  });
  const evidence = evidenceItem('e-signal-refute', [
    { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'normal' },
  ]);

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'refuted');
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: matching                                  */
/* -------------------------------------------------------------------------- */

const SIGNAL_PREDICTION_BASE = () =>
  basePrediction({
    id: 'p-matching',
    hypothesisId: 'h-matching',
    expectedIfTrue: [
      { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
    ],
    expectedIfFalse: [
      { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'connection-pool', state: 'normal' },
    ],
  });

for (const [label, fact] of [
  [
    'subject mismatch',
    { form: 'signal-state', subject: 'other-service', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
  ],
  [
    'window mismatch',
    { form: 'signal-state', subject: 'checkout-db-pool', window: 'pre-onset', signal: 'connection-pool', state: 'at-limit' },
  ],
  [
    'signal mismatch',
    { form: 'signal-state', subject: 'checkout-db-pool', window: 'incident', signal: 'latency', state: 'at-limit' },
  ],
]) {
  test(`leaves a prediction status unchanged (untested) on a ${label} between the fact and the expected observation`, () => {
    const evaluatePredictionObservations = requireEvaluatePredictionObservations();
    const prediction = SIGNAL_PREDICTION_BASE();
    const evidence = evidenceItem(`e-${label.replace(/\s+/g, '-')}`, [fact]);

    const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

    assert.equal(result.predictions[0].status, 'untested');
    assert.equal(result.assessments.length, 0);
  });
}

test('matches a subject regardless of surrounding whitespace or letter case', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = SIGNAL_PREDICTION_BASE();
  const evidence = evidenceItem('e-subject-normalised', [
    { form: 'signal-state', subject: '  Checkout-DB-Pool  ', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
  ]);

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'confirmed');
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: rule (b), the as-of cut                    */
/* -------------------------------------------------------------------------- */

test('counts evidence observed exactly at asOf', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-at-asof', hypothesisId: 'h-at-asof' });
  const evidence = evidenceItem('e-at-asof', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
  ], { observedAt: ASOF });

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'confirmed');
});

test('ignores evidence observed one millisecond after asOf', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-after-asof', hypothesisId: 'h-after-asof' });
  const evidence = evidenceItem('e-after-asof', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
  ], { observedAt: '2026-09-28T08:00:00.001Z' });

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'untested');
  assert.equal(result.assessments.length, 0);
});

test('ignores evidence carrying an unparseable observedAt', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-bad-observed-at', hypothesisId: 'h-bad-observed-at' });
  const evidence = evidenceItem('e-bad-observed-at', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
  ], { observedAt: 'not-a-timestamp' });

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'untested');
  assert.equal(result.assessments.length, 0);
});

test('throws on an unparseable asOf', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-bad-asof', hypothesisId: 'h-bad-asof' });

  assert.throws(
    () => evaluatePredictionObservations({ predictions: [prediction], evidence: [], asOf: 'not-a-timestamp' }),
    /asOf/i,
  );
});

test('evidence with no observation field contributes nothing and does not throw', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-no-observation', hypothesisId: 'h-no-observation' });
  const evidence = evidenceItem('e-no-observation');

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'untested');
  assert.equal(result.assessments.length, 0);
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: conflict                                  */
/* -------------------------------------------------------------------------- */

test('leaves a prediction untestable when the evidence conflicts: one fact holds an observation and another contradicts the same observation', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({ id: 'p-conflict', hypothesisId: 'h-conflict' });
  const holdingEvidence = evidenceItem('e-conflict-holds', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
  ]);
  const contradictingEvidence = evidenceItem('e-conflict-contradicts', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 0, coverage: 'complete' },
  ]);

  const result = evaluatePredictionObservations({
    predictions: [prediction],
    evidence: [holdingEvidence, contradictingEvidence],
    asOf: ASOF,
  });

  assert.equal(result.predictions[0].status, 'untestable');
  assert.equal(result.assessments.length, 0, 'a conflicting verdict produces no assessments');
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: multi-observation predictions             */
/* -------------------------------------------------------------------------- */

function twoObservationPrediction(overrides = {}) {
  return basePrediction({
    id: 'p-two-observations',
    hypothesisId: 'h-two-observations',
    expectedIfTrue: [
      { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', presence: 'present' },
      { form: 'signal-state', subject: 'checkout', window: 'incident', signal: 'error-rate', state: 'elevated' },
    ],
    expectedIfFalse: [],
    ...overrides,
  });
}

test('leaves a prediction status unchanged when only one of two expectedIfTrue observations holds and nothing matches the other', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = twoObservationPrediction();
  const onlyFirstObservation = evidenceItem('e-only-first', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 1, coverage: 'complete' },
  ]);

  const result = evaluatePredictionObservations({
    predictions: [prediction],
    evidence: [onlyFirstObservation],
    asOf: ASOF,
  });

  assert.equal(result.predictions[0].status, 'untested');
  assert.equal(result.assessments.length, 0);
});

test('confirms a prediction only once every expectedIfTrue observation holds, and produces one assessment per contributing evidence item', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = twoObservationPrediction();
  const firstObservationEvidence = evidenceItem('e-first-observation', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 1, coverage: 'complete' },
  ]);
  const secondObservationEvidence = evidenceItem('e-second-observation', [
    { form: 'signal-state', subject: 'checkout', window: 'incident', signal: 'error-rate', state: 'elevated' },
  ]);

  const result = evaluatePredictionObservations({
    predictions: [prediction],
    evidence: [firstObservationEvidence, secondObservationEvidence],
    asOf: ASOF,
  });

  assert.equal(result.predictions[0].status, 'confirmed');
  assert.equal(result.assessments.length, 2);
  assert.deepEqual(
    new Set(result.assessments.map((assessment) => assessment.evidenceId)),
    new Set([firstObservationEvidence.id, secondObservationEvidence.id]),
  );
});

test('refutes a prediction when an expectedIfFalse observation holds, even while expectedIfTrue is unresolved', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = basePrediction({
    id: 'p-iffalse-holds',
    hypothesisId: 'h-iffalse-holds',
    expectedIfTrue: [
      { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', presence: 'present' },
    ],
    expectedIfFalse: [
      { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', presence: 'absent' },
    ],
  });
  const evidence = evidenceItem('e-iffalse-holds', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 0, coverage: 'complete' },
  ]);

  const result = evaluatePredictionObservations({ predictions: [prediction], evidence: [evidence], asOf: ASOF });

  assert.equal(result.predictions[0].status, 'refuted');
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].effect, 'contradicts');
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: order and permutation                     */
/* -------------------------------------------------------------------------- */

test('keeps output predictions in the same order as the input predictions', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const first = basePrediction({ id: 'p-order-first', hypothesisId: 'h-order-first' });
  const second = basePrediction({ id: 'p-order-second', hypothesisId: 'h-order-second' });

  const result = evaluatePredictionObservations({ predictions: [first, second], evidence: [], asOf: ASOF });

  assert.deepEqual(result.predictions.map((prediction) => prediction.id), ['p-order-first', 'p-order-second']);
});

test('gives the same set of assessments regardless of the evidence input order', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const prediction = twoObservationPrediction();
  const firstObservationEvidence = evidenceItem('e-perm-first', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 1, coverage: 'complete' },
  ]);
  const secondObservationEvidence = evidenceItem('e-perm-second', [
    { form: 'signal-state', subject: 'checkout', window: 'incident', signal: 'error-rate', state: 'elevated' },
  ]);

  const forward = evaluatePredictionObservations({
    predictions: [prediction],
    evidence: [firstObservationEvidence, secondObservationEvidence],
    asOf: ASOF,
  });
  const reversed = evaluatePredictionObservations({
    predictions: [prediction],
    evidence: [secondObservationEvidence, firstObservationEvidence],
    asOf: ASOF,
  });

  const byId = (list) => [...list].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(byId(forward.assessments), byId(reversed.assessments));
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: monotonicity of confirmed/refuted          */
/* -------------------------------------------------------------------------- */

test('returns confirmed and refuted predictions unchanged and produces no assessments for them, even when new evidence contradicts them', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const confirmedPrediction = basePrediction({ id: 'p-final-confirmed', hypothesisId: 'h-final', status: 'confirmed' });
  const refutedPrediction = basePrediction({ id: 'p-final-refuted', hypothesisId: 'h-final', status: 'refuted' });
  const contradictingEvidence = evidenceItem('e-final', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 0, coverage: 'complete' },
  ]);

  const result = evaluatePredictionObservations({
    predictions: [confirmedPrediction, refutedPrediction],
    evidence: [contradictingEvidence],
    asOf: ASOF,
  });

  assert.deepEqual(result.predictions, [confirmedPrediction, refutedPrediction]);
  assert.deepEqual(result.assessments, []);
});

test('re-evaluates an untestable prediction, unlike confirmed and refuted, and can resolve it to confirmed', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const untestablePrediction = basePrediction({ id: 'p-reopened', hypothesisId: 'h-reopened', status: 'untestable' });
  const confirmingEvidence = evidenceItem('e-reopened', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
  ]);

  const result = evaluatePredictionObservations({
    predictions: [untestablePrediction],
    evidence: [confirmingEvidence],
    asOf: ASOF,
  });

  assert.equal(result.predictions[0].status, 'confirmed');
  assert.equal(result.assessments.length, 1);
});

/* -------------------------------------------------------------------------- */
/* evaluatePredictionObservations: purity                                    */
/* -------------------------------------------------------------------------- */

test('does not mutate its predictions or evidence inputs', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const predictions = [basePrediction({ id: 'p-purity', hypothesisId: 'h-purity' })];
  const evidence = [
    evidenceItem('e-purity', [
      { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
    ]),
  ];
  const predictionsBefore = structuredClone(predictions);
  const evidenceBefore = structuredClone(evidence);

  evaluatePredictionObservations({ predictions, evidence, asOf: ASOF });

  assert.deepEqual(predictions, predictionsBefore);
  assert.deepEqual(evidence, evidenceBefore);
});

test('is pure: an identical call twice produces deepEqual output', () => {
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const predictions = [basePrediction({ id: 'p-pure', hypothesisId: 'h-pure' })];
  const evidence = [
    evidenceItem('e-pure', [
      { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
    ]),
  ];

  const first = evaluatePredictionObservations({ predictions, evidence, asOf: ASOF });
  const second = evaluatePredictionObservations({ predictions, evidence, asOf: ASOF });

  assert.deepEqual(first, second);
});

/* -------------------------------------------------------------------------- */
/* R': the derived, evaluated predictions feeding deriveHypothesisStatus       */
/* -------------------------------------------------------------------------- */

const R_PRIME_TEMPLATES = Object.freeze({
  version: 'r-prime-templates-v1',
  byMechanism: Object.freeze({
    'deployment-regression': Object.freeze([template('r-prime-onset')]),
  }),
});

function supportAssessment(id, evidenceId, hypothesisId, overrides = {}) {
  return {
    id,
    evidenceId,
    hypothesisId,
    predictionId: undefined,
    effect: 'supports',
    strength: 'medium',
    rationale: `independent support from ${evidenceId}`,
    producedBy: 'rule',
    at: ASOF,
    ...overrides,
  };
}

test('R-prime: a derived, confirmed prediction whose rule assessment is the only support leaves the hypothesis at candidate', () => {
  const derivePredictions = requireDerivePredictions();
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const deriveHypothesisStatus = requireDeriveHypothesisStatus();
  const hyp = hypothesis('h-rprime-candidate');

  const [derived] = derivePredictions({ hypotheses: [hyp], predictions: [], templates: R_PRIME_TEMPLATES });
  const confirmingEvidence = evidenceItem('e-rprime-confirm', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 1, coverage: 'complete' },
  ]);
  const evaluated = evaluatePredictionObservations({
    predictions: [derived],
    evidence: [confirmingEvidence],
    asOf: ASOF,
  });

  const status = deriveHypothesisStatus({
    hypothesisId: hyp.id,
    predictions: evaluated.predictions,
    assessments: evaluated.assessments,
    evidence: [confirmingEvidence],
  });

  assert.equal(evaluated.predictions[0].status, 'confirmed');
  assert.equal(status, 'candidate');
});

test('R-prime: a second independent medium support promotes the same hypothesis from candidate to supported', () => {
  const derivePredictions = requireDerivePredictions();
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const deriveHypothesisStatus = requireDeriveHypothesisStatus();
  const hyp = hypothesis('h-rprime-supported');

  const [derived] = derivePredictions({ hypotheses: [hyp], predictions: [], templates: R_PRIME_TEMPLATES });
  const confirmingEvidence = evidenceItem('e-rprime-support-1', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 1, coverage: 'complete' },
  ]);
  const evaluated = evaluatePredictionObservations({
    predictions: [derived],
    evidence: [confirmingEvidence],
    asOf: ASOF,
  });
  const secondEvidence = evidenceItem('e-rprime-support-2');
  const secondSupport = supportAssessment('rprime-second-support', secondEvidence.id, hyp.id);

  const status = deriveHypothesisStatus({
    hypothesisId: hyp.id,
    predictions: evaluated.predictions,
    assessments: [...evaluated.assessments, secondSupport],
    evidence: [confirmingEvidence, secondEvidence],
  });

  assert.equal(status, 'supported');
});

test('R-prime: the same two independent supports with no confirmed prediction leave the hypothesis at corroborated, never supported', () => {
  const deriveHypothesisStatus = requireDeriveHypothesisStatus();
  const evidenceA = evidenceItem('e-rprime-corrob-1');
  const evidenceB = evidenceItem('e-rprime-corrob-2');
  const assessments = [
    supportAssessment('rprime-corrob-support-1', evidenceA.id, 'h-rprime-corroborated'),
    supportAssessment('rprime-corrob-support-2', evidenceB.id, 'h-rprime-corroborated'),
  ];

  const status = deriveHypothesisStatus({
    hypothesisId: 'h-rprime-corroborated',
    predictions: [],
    assessments,
    evidence: [evidenceA, evidenceB],
  });

  assert.equal(status, 'corroborated');
  assert.notEqual(status, 'supported');
});

test('R-prime: a hypothesis with no predictions at all is never supported, however much support it accumulates', () => {
  const deriveHypothesisStatus = requireDeriveHypothesisStatus();
  const evidenceItems = Array.from({ length: 5 }, (_, index) => evidenceItem(`e-rprime-no-predictions-${index}`));
  const assessments = evidenceItems.map((item, index) =>
    supportAssessment(`rprime-no-predictions-${index}`, item.id, 'h-rprime-no-predictions'),
  );

  const status = deriveHypothesisStatus({
    hypothesisId: 'h-rprime-no-predictions',
    predictions: [],
    assessments,
    evidence: evidenceItems,
  });

  assert.notEqual(status, 'supported');
});

test('R-prime: a refuted prediction contributing a contradicts assessment weakens the hypothesis', () => {
  const derivePredictions = requireDerivePredictions();
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const deriveHypothesisStatus = requireDeriveHypothesisStatus();
  const hyp = hypothesis('h-rprime-weakened');

  const [derived] = derivePredictions({ hypotheses: [hyp], predictions: [], templates: R_PRIME_TEMPLATES });
  const refutingEvidence = evidenceItem('e-rprime-refute', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 0, coverage: 'complete' },
  ]);
  const evaluated = evaluatePredictionObservations({
    predictions: [derived],
    evidence: [refutingEvidence],
    asOf: ASOF,
  });

  const status = deriveHypothesisStatus({
    hypothesisId: hyp.id,
    predictions: evaluated.predictions,
    assessments: evaluated.assessments,
    evidence: [refutingEvidence],
  });

  assert.equal(evaluated.predictions[0].status, 'refuted');
  assert.equal(evaluated.assessments[0].effect, 'contradicts');
  assert.equal(status, 'weakened');
});

test('R-prime: an untestable prediction never counts as confirmed, so two independent supports stay at corroborated rather than supported', () => {
  const derivePredictions = requireDerivePredictions();
  const evaluatePredictionObservations = requireEvaluatePredictionObservations();
  const deriveHypothesisStatus = requireDeriveHypothesisStatus();
  const hyp = hypothesis('h-rprime-untestable');

  const [derived] = derivePredictions({ hypotheses: [hyp], predictions: [], templates: R_PRIME_TEMPLATES });
  const holdingEvidence = evidenceItem('e-rprime-untestable-holds', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 1, coverage: 'complete' },
  ]);
  const contradictingEvidence = evidenceItem('e-rprime-untestable-contradicts', [
    { form: 'deployment-in-window', subject: 'checkout', window: 'pre-onset', count: 0, coverage: 'complete' },
  ]);
  const evaluated = evaluatePredictionObservations({
    predictions: [derived],
    evidence: [holdingEvidence, contradictingEvidence],
    asOf: ASOF,
  });
  const supportEvidenceA = evidenceItem('e-rprime-untestable-support-a');
  const supportEvidenceB = evidenceItem('e-rprime-untestable-support-b');
  const assessments = [
    ...evaluated.assessments,
    supportAssessment('rprime-untestable-support-a', supportEvidenceA.id, hyp.id),
    supportAssessment('rprime-untestable-support-b', supportEvidenceB.id, hyp.id),
  ];

  const status = deriveHypothesisStatus({
    hypothesisId: hyp.id,
    predictions: evaluated.predictions,
    assessments,
    evidence: [holdingEvidence, contradictingEvidence, supportEvidenceA, supportEvidenceB],
  });

  assert.equal(evaluated.predictions[0].status, 'untestable');
  assert.equal(status, 'corroborated');
});

test('R-prime: the v0.1 status rules stay reproducible on the same supported and corroborated-shaped inputs', () => {
  const deriveHypothesisStatus = requireDeriveHypothesisStatus();
  const confirmedPrediction = basePrediction({ id: 'p-rprime-v01', hypothesisId: 'h-rprime-v01', status: 'confirmed' });
  const evidenceA = evidenceItem('e-rprime-v01-a');
  const evidenceB = evidenceItem('e-rprime-v01-b');
  const twoSupports = [
    supportAssessment('rprime-v01-support-a', evidenceA.id, 'h-rprime-v01'),
    supportAssessment('rprime-v01-support-b', evidenceB.id, 'h-rprime-v01'),
  ];

  const supportedUnderV01 = deriveHypothesisStatus({
    hypothesisId: 'h-rprime-v01',
    predictions: [confirmedPrediction],
    assessments: twoSupports,
    evidence: [evidenceA, evidenceB],
    rulesVersion: 'v0.1',
  });
  const corroboratedShapeUnderV01 = deriveHypothesisStatus({
    hypothesisId: 'h-rprime-v01-no-prediction',
    predictions: [],
    assessments: [
      supportAssessment('rprime-v01-no-prediction-a', evidenceA.id, 'h-rprime-v01-no-prediction'),
      supportAssessment('rprime-v01-no-prediction-b', evidenceB.id, 'h-rprime-v01-no-prediction'),
    ],
    evidence: [evidenceA, evidenceB],
    rulesVersion: 'v0.1',
  });

  assert.equal(supportedUnderV01, 'supported', 'v0.1 must still reach supported the way it always did');
  assert.equal(
    corroboratedShapeUnderV01,
    'candidate',
    'v0.1 has no corroborated status and must fall back to candidate on the identical shape',
  );
});
