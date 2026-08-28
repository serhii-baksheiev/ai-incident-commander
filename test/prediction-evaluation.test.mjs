import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';

const prediction = {
  id: 'prediction-1',
  hypothesisId: 'hypothesis-1',
  statement: 'Checkout errors began after deployment',
  expectedIfTrue: [{ observation: 'errors began after deployment' }],
  expectedIfFalse: [{ observation: 'errors predate deployment' }],
  status: 'untested',
};

const evidence = {
  id: 'evidence-1',
  trialId: 'trial-1',
  kind: 'deploy',
  source: 'deployment-history',
  observedAt: '2026-08-28T08:00:00.000Z',
  statement: 'Checkout v42 deployed before the first error',
  rawRef: 'replay://deployments/checkout/v42',
  reliability: 'high',
};

function assessment(overrides = {}) {
  return {
    id: 'assessment-1',
    evidenceId: evidence.id,
    hypothesisId: prediction.hypothesisId,
    predictionId: prediction.id,
    effect: 'supports',
    strength: 'high',
    rationale: 'The deployment precedes the first error',
    producedBy: 'rule',
    at: '2026-08-28T08:01:00.000Z',
    ...overrides,
  };
}

function requirePredictionEvaluator() {
  assert.equal(
    typeof domain.evaluatePredictions,
    'function',
    '@aic/domain must publish evaluatePredictions(options)',
  );
  return domain.evaluatePredictions;
}

function requireStatusDeriver() {
  assert.equal(
    typeof domain.deriveHypothesisStatus,
    'function',
    '@aic/domain must publish deriveHypothesisStatus(options)',
  );
  return domain.deriveHypothesisStatus;
}

test('uses a mechanical assessment without invoking residual semantic interpretation', async () => {
  const evaluatePredictions = requirePredictionEvaluator();
  let semanticCalls = 0;
  const ruleAssessment = assessment();

  const result = await evaluatePredictions({
    predictions: [prediction],
    evidence: [evidence],
    evaluateRule: () => ruleAssessment,
    evaluateSemantic: async () => {
      semanticCalls += 1;
      throw new Error('semantic interpretation must not run for mechanical criteria');
    },
  });

  assert.deepEqual(result, [ruleAssessment]);
  assert.equal(result[0].producedBy, 'rule');
  assert.equal(semanticCalls, 0);
});

test('rejects a mechanical assessment that was not produced by a rule', async () => {
  const evaluatePredictions = requirePredictionEvaluator();

  await assert.rejects(
    () =>
      evaluatePredictions({
        predictions: [prediction],
        evidence: [evidence],
        evaluateRule: () =>
          assessment({
            producedBy: 'llm',
            promptVersion: 'residual-evidence-v1',
          }),
        evaluateSemantic: async () => assessment(),
      }),
    /producedBy.*rule/i,
  );
});

test('routes only residual evidence through a structured LLM assessment', async () => {
  const evaluatePredictions = requirePredictionEvaluator();
  let semanticCalls = 0;
  const semanticAssessment = assessment({
    producedBy: 'llm',
    promptVersion: 'residual-evidence-v1',
  });

  const result = await evaluatePredictions({
    predictions: [prediction],
    evidence: [evidence],
    evaluateRule: () => null,
    evaluateSemantic: async () => {
      semanticCalls += 1;
      return semanticAssessment;
    },
  });

  assert.equal(semanticCalls, 1);
  assert.deepEqual(result, [semanticAssessment]);
  assert.deepEqual(domain.EvidenceAssessmentSchema.parse(result[0]), semanticAssessment);
  assert.equal('model' in result[0], false, 'the frozen assessment shape must remain exact');
});

test('rejects an LLM assessment without prompt metadata', async () => {
  const evaluatePredictions = requirePredictionEvaluator();

  await assert.rejects(
    () =>
      evaluatePredictions({
        predictions: [prediction],
        evidence: [evidence],
        evaluateRule: () => null,
        evaluateSemantic: async () => assessment({ producedBy: 'llm' }),
      }),
    /promptVersion/i,
  );
});

test('derives candidate, supported, weakened, and rejected by the v0.1 precedence rules', () => {
  const deriveHypothesisStatus = requireStatusDeriver();
  const predictions = ['candidate', 'supported', 'weakened', 'rejected'].map(
    (hypothesisId) => ({
      ...prediction,
      id: `${hypothesisId}-prediction`,
      hypothesisId,
      status: hypothesisId === 'rejected' ? 'refuted' : 'confirmed',
    }),
  );
  const evidenceItems = ['shared', 'support-a', 'support-b', 'contradiction', 'rejection'].map(
    (id) => ({
      ...evidence,
      id,
      reliability: id === 'rejection' ? 'high' : 'medium',
    }),
  );
  const assessments = [
    assessment({
      id: 'candidate-support-1',
      hypothesisId: 'candidate',
      predictionId: 'candidate-prediction',
      evidenceId: 'shared',
      strength: 'medium',
    }),
    assessment({
      id: 'candidate-support-2',
      hypothesisId: 'candidate',
      predictionId: 'candidate-prediction',
      evidenceId: 'shared',
    }),
    ...['supported', 'weakened'].flatMap((hypothesisId) => [
      assessment({
        id: `${hypothesisId}-support-a`,
        hypothesisId,
        predictionId: `${hypothesisId}-prediction`,
        evidenceId: 'support-a',
        strength: 'medium',
      }),
      assessment({
        id: `${hypothesisId}-support-b`,
        hypothesisId,
        predictionId: `${hypothesisId}-prediction`,
        evidenceId: 'support-b',
      }),
    ]),
    assessment({
      id: 'weakened-contradiction',
      hypothesisId: 'weakened',
      predictionId: 'weakened-prediction',
      evidenceId: 'contradiction',
      effect: 'contradicts',
      strength: 'medium',
    }),
    assessment({
      id: 'rejected-contradiction',
      hypothesisId: 'rejected',
      predictionId: 'rejected-prediction',
      evidenceId: 'rejection',
      effect: 'contradicts',
      strength: 'medium',
    }),
  ];
  const derive = (hypothesisId) =>
    deriveHypothesisStatus({ hypothesisId, predictions, assessments, evidence: evidenceItems });

  assert.deepEqual(
    ['candidate', 'supported', 'weakened', 'rejected'].map((hypothesisId) => ({
      hypothesisId,
      status: derive(hypothesisId),
    })),
    [
      { hypothesisId: 'candidate', status: 'candidate' },
      { hypothesisId: 'supported', status: 'supported' },
      { hypothesisId: 'weakened', status: 'weakened' },
      { hypothesisId: 'rejected', status: 'rejected' },
    ],
  );
});

test('keeps equally supported hypotheses tied without a numeric tie-breaker', () => {
  const deriveHypothesisStatus = requireStatusDeriver();
  const hypothesisIds = ['hypothesis-a', 'hypothesis-b'];
  const predictions = hypothesisIds.map((hypothesisId) => ({
    ...prediction,
    id: `${hypothesisId}-prediction`,
    hypothesisId,
    status: 'confirmed',
  }));
  const evidenceItems = hypothesisIds.flatMap((hypothesisId) =>
    ['one', 'two'].map((suffix) => ({
      ...evidence,
      id: `${hypothesisId}-evidence-${suffix}`,
    })),
  );
  const assessments = evidenceItems.map((item) => {
    const hypothesisId = item.id.startsWith('hypothesis-a')
      ? 'hypothesis-a'
      : 'hypothesis-b';
    return assessment({
      id: `${item.id}-assessment`,
      evidenceId: item.id,
      hypothesisId,
      predictionId: `${hypothesisId}-prediction`,
      strength: 'medium',
    });
  });

  const statuses = hypothesisIds.map((hypothesisId) =>
    deriveHypothesisStatus({ hypothesisId, predictions, assessments, evidence: evidenceItems }),
  );

  assert.deepEqual(statuses, ['supported', 'supported']);
  assert.equal(statuses.every((status) => typeof status === 'string'), true);
});
