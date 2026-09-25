/**
 * AIC-123 slice 1 (the owner's AIC-123 ruling of 2026-09-25, D1 and D2): the
 * structured hypothesis cause and the typed, versioned `ExpectedObservation` /
 * `ObservedFact` contracts.
 *
 * `CauseDescriptionSchema` replaces the inline `{component, mechanism,
 * trigger?}` object `CauseClaimSchema.cause` already declared, and
 * `HypothesisSchema` gains an optional reference to that same schema object —
 * "one shape, two users". `ExpectedObservation`
 * moves from `z.unknown()` to a closed, versioned vocabulary of three forms,
 * each covering one class of evidence the corpus actually carries (the AIC-128
 * dispositions R2 and R3). `ObservedFact` is the same vocabulary's typed-data
 * half on `Evidence`, added but populated by nothing yet (decision D2).
 *
 * Every expectation below is a hand-written literal: none is read back off the
 * schema or function it checks (`.claude/rules/invariants.md`, "the
 * independent-oracle invariant").
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import * as domain from '@aic/domain';
import * as evals from '@aic/evals';

/* -------------------------------------------------------------------------- */
/* the hypothesis cause: one shape, two users                                 */
/* -------------------------------------------------------------------------- */

test('gives Hypothesis.cause the exact same schema object CauseClaimSchema.cause uses, not a second copy of the same shape', () => {
  const causeField = domain.HypothesisSchema.shape.cause;
  assert.equal(
    typeof causeField?.unwrap,
    'function',
    'HypothesisSchema must declare cause as an optional schema wrapping CauseDescriptionSchema',
  );
  assert.equal(
    causeField.unwrap(),
    domain.CauseClaimSchema.shape.cause,
    'Hypothesis.cause must be the identical schema object CauseClaimSchema.cause uses',
  );
});

test('StructuredHypothesisSchema requires a cause that HypothesisSchema leaves optional', () => {
  const hypothesisWithoutCause = { id: 'h-1', statement: 'the deploy did it', createdBy: 'initial' };

  assert.equal(
    domain.HypothesisSchema.safeParse(hypothesisWithoutCause).success,
    true,
    'HypothesisSchema must still accept a hypothesis carrying no cause',
  );
  assert.equal(
    domain.StructuredHypothesisSchema.safeParse(hypothesisWithoutCause).success,
    false,
    'StructuredHypothesisSchema must require a cause where HypothesisSchema does not',
  );

  const hypothesisWithCause = {
    ...hypothesisWithoutCause,
    cause: { component: 'checkout', mechanism: 'deployment-regression' },
  };
  assert.equal(
    domain.HypothesisSchema.safeParse(hypothesisWithCause).success,
    true,
    'HypothesisSchema must accept a hypothesis a producer supplied a cause for',
  );
  assert.equal(
    domain.StructuredHypothesisSchema.safeParse(hypothesisWithCause).success,
    true,
    'StructuredHypothesisSchema must accept a hypothesis that carries a cause',
  );
});

test('accepts a human-added hypothesis with an optional cause, and still accepts one with none', () => {
  const withoutCause = {
    id: 'human-1',
    statement: 'a dependency outside the initial candidate set is failing',
    createdBy: 'initial',
  };
  const withCause = {
    ...withoutCause,
    id: 'human-2',
    cause: { component: 'inventory-api', mechanism: 'connection-pool-exhaustion' },
  };

  assert.equal(
    domain.HumanAddedHypothesisSchema.safeParse(withoutCause).success,
    true,
    'HumanAddedHypothesisSchema must keep accepting a hypothesis with no cause',
  );
  assert.equal(
    domain.HumanAddedHypothesisSchema.safeParse(withCause).success,
    true,
    'HumanAddedHypothesisSchema must accept an optional cause additively',
  );
});

/* -------------------------------------------------------------------------- */
/* ExpectedObservationSchema: the closed, versioned vocabulary                 */
/* -------------------------------------------------------------------------- */

test('publishes EXPECTED_OBSERVATION_VERSION as 1', () => {
  assert.equal(domain.EXPECTED_OBSERVATION_VERSION, 1);
});

const validExpectedObservations = [
  [
    'deployment-in-window',
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident', presence: 'present' },
  ],
  [
    'log-class-in-window',
    {
      form: 'log-class-in-window',
      subject: 'checkout',
      window: 'incident',
      logClass: 'error',
      presence: 'absent',
    },
  ],
  [
    'signal-state',
    {
      form: 'signal-state',
      subject: 'checkout-db-pool',
      window: 'incident',
      signal: 'connection-pool',
      state: 'at-limit',
    },
  ],
];

for (const [form, value] of validExpectedObservations) {
  test(`accepts a well-formed ${form} ExpectedObservation`, () => {
    assert.equal(
      domain.ExpectedObservationSchema.safeParse(value).success,
      true,
      `a well-formed ${form} observation must be accepted`,
    );
  });
}

const invalidExpectedObservations = [
  ['an unknown form', { form: 'job-status', subject: 'checkout', window: 'incident' }],
  [
    'an extra key on an otherwise well-formed form',
    {
      form: 'deployment-in-window',
      subject: 'checkout',
      window: 'incident',
      presence: 'present',
      extra: true,
    },
  ],
  ['a legacy untyped value', { observation: 'onset matches deployment' }],
  ['a bare string', 'onset matches deployment'],
  [
    'an empty subject',
    { form: 'deployment-in-window', subject: '', window: 'incident', presence: 'present' },
  ],
  [
    'a signal-state carrying presence',
    {
      form: 'signal-state',
      subject: 'checkout-db-pool',
      window: 'incident',
      signal: 'latency',
      state: 'elevated',
      presence: 'present',
    },
  ],
  [
    'a presence form missing presence',
    { form: 'deployment-in-window', subject: 'checkout', window: 'incident' },
  ],
  [
    'a subject longer than 200 characters',
    { form: 'deployment-in-window', subject: 's'.repeat(201), window: 'incident', presence: 'present' },
  ],
];

test('accepts a subject of exactly 200 characters, the bound', () => {
  assert.equal(
    domain.ExpectedObservationSchema.safeParse({
      form: 'deployment-in-window',
      subject: 's'.repeat(200),
      window: 'incident',
      presence: 'present',
    }).success,
    true,
  );
});

for (const [label, value] of invalidExpectedObservations) {
  test(`refuses ${label} as an ExpectedObservation`, () => {
    assert.equal(
      domain.ExpectedObservationSchema.safeParse(value).success,
      false,
      `${label} must be refused, not accepted as a well-formed observation`,
    );
  });
}

/* -------------------------------------------------------------------------- */
/* PredictionSchema: observationVersion and a non-empty expectedIfTrue        */
/* -------------------------------------------------------------------------- */

function validPrediction(overrides = {}) {
  return {
    id: 'prediction-1',
    hypothesisId: 'hypothesis-1',
    statement: 'checkout errors began after deployment',
    observationVersion: domain.EXPECTED_OBSERVATION_VERSION,
    expectedIfTrue: [
      { form: 'deployment-in-window', subject: 'checkout', window: 'incident', presence: 'present' },
    ],
    expectedIfFalse: [],
    status: 'untested',
    ...overrides,
  };
}

test('accepts a well-formed prediction carrying observationVersion and a typed expectedIfTrue', () => {
  assert.equal(
    domain.PredictionSchema.safeParse(validPrediction()).success,
    true,
    'a prediction with observationVersion and at least one typed expectedIfTrue must be accepted',
  );
});

test('refuses a prediction with no observationVersion', () => {
  const prediction = validPrediction();
  delete prediction.observationVersion;

  assert.equal(
    domain.PredictionSchema.safeParse(prediction).success,
    false,
    'a prediction with no observationVersion must be refused',
  );
});

test('refuses a prediction whose expectedIfTrue is empty', () => {
  assert.equal(
    domain.PredictionSchema.safeParse(validPrediction({ expectedIfTrue: [] })).success,
    false,
    'expectedIfTrue must carry at least one observation, or the prediction commits to nothing',
  );
});

test('accepts a prediction whose expectedIfFalse is empty, which carries no minimum', () => {
  assert.equal(
    domain.PredictionSchema.safeParse(validPrediction({ expectedIfFalse: [] })).success,
    true,
    'expectedIfFalse has no minimum in the design (section 2): only expectedIfTrue does',
  );
});

/* -------------------------------------------------------------------------- */
/* ObservedFactSchema and Evidence.observation                                */
/* -------------------------------------------------------------------------- */

function baseEvidence(overrides = {}) {
  return {
    id: 'evidence-1',
    trialId: 'trial-1',
    kind: 'deploy',
    source: 'deployment-history',
    observedAt: '2026-08-27T12:00:00.000Z',
    statement: 'checkout v42 deployed at 11:58 UTC',
    rawRef: 'replay://deployments/checkout/v42',
    ...overrides,
  };
}

const OBSERVATION = Object.freeze({ form: 'deployment-in-window', subject: 'checkout', window: 'incident', presence: 'present' });
const FACT = Object.freeze({ form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' });

test('bounds each observation list at 16 entries: expectedIfTrue, expectedIfFalse and observation.facts', () => {
  const sixteen = (item) => Array.from({ length: 16 }, () => ({ ...item }));
  const seventeen = (item) => Array.from({ length: 17 }, () => ({ ...item }));

  assert.equal(domain.PredictionSchema.safeParse(validPrediction({ expectedIfTrue: sixteen(OBSERVATION) })).success, true);
  assert.equal(domain.PredictionSchema.safeParse(validPrediction({ expectedIfTrue: seventeen(OBSERVATION) })).success, false);
  assert.equal(domain.PredictionSchema.safeParse(validPrediction({ expectedIfFalse: seventeen(OBSERVATION) })).success, false);
  assert.equal(
    domain.EvidenceSchema.safeParse(baseEvidence({ observation: { version: domain.EXPECTED_OBSERVATION_VERSION, facts: sixteen(FACT) } })).success,
    true,
  );
  assert.equal(
    domain.EvidenceSchema.safeParse(baseEvidence({ observation: { version: domain.EXPECTED_OBSERVATION_VERSION, facts: seventeen(FACT) } })).success,
    false,
  );
});

test('accepts Evidence with no observation field, since nothing populates it yet (owner ruling D2)', () => {
  assert.equal(
    domain.EvidenceSchema.safeParse(baseEvidence()).success,
    true,
    'Evidence without observation must still be accepted: the field is optional',
  );
});

test('accepts Evidence carrying a well-formed observation', () => {
  const evidence = baseEvidence({
    observation: {
      version: domain.EXPECTED_OBSERVATION_VERSION,
      facts: [
        { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
      ],
    },
  });

  assert.equal(
    domain.EvidenceSchema.safeParse(evidence).success,
    true,
    'Evidence carrying a well-formed, versioned observation must be accepted',
  );
});

test('refuses Evidence.observation stamped at the wrong version', () => {
  const evidence = baseEvidence({
    observation: {
      version: 2,
      facts: [
        { form: 'deployment-in-window', subject: 'checkout', window: 'incident', count: 1, coverage: 'complete' },
      ],
    },
  });

  assert.equal(
    domain.EvidenceSchema.safeParse(evidence).success,
    false,
    'an observation stamped at a version other than 1 must be refused',
  );
});

test('refuses Evidence.observation with an empty facts array', () => {
  const evidence = baseEvidence({
    observation: { version: domain.EXPECTED_OBSERVATION_VERSION, facts: [] },
  });

  assert.equal(
    domain.EvidenceSchema.safeParse(evidence).success,
    false,
    'an observation with zero facts must be refused: it observes nothing',
  );
});

for (const [label, count] of [
  ['a negative', -1],
  ['a non-integer', 1.5],
]) {
  test(`refuses an observed fact carrying ${label} count`, () => {
    const evidence = baseEvidence({
      observation: {
        version: domain.EXPECTED_OBSERVATION_VERSION,
        facts: [
          {
            form: 'deployment-in-window',
            subject: 'checkout',
            window: 'incident',
            count,
            coverage: 'complete',
          },
        ],
      },
    });

    assert.equal(
      domain.EvidenceSchema.safeParse(evidence).success,
      false,
      `an observed fact carrying ${label} count must be refused, the same as any other LogicalCountSchema field`,
    );
  });
}

test('refuses an observed fact with an unknown form', () => {
  const evidence = baseEvidence({
    observation: {
      version: domain.EXPECTED_OBSERVATION_VERSION,
      facts: [{ form: 'job-status', subject: 'checkout', window: 'incident' }],
    },
  });

  assert.equal(
    domain.EvidenceSchema.safeParse(evidence).success,
    false,
    'an observed fact naming a form outside the closed vocabulary must be refused',
  );
});

/* -------------------------------------------------------------------------- */
/* observedPresence: rule (a), defined once                                   */
/* -------------------------------------------------------------------------- */

test('observedPresence: a positive count under partial coverage is present', () => {
  assert.equal(
    domain.observedPresence({
      form: 'deployment-in-window',
      subject: 'checkout',
      window: 'incident',
      count: 2,
      coverage: 'partial',
    }),
    'present',
  );
});

test('observedPresence: a zero count under complete coverage is absent', () => {
  assert.equal(
    domain.observedPresence({
      form: 'log-class-in-window',
      subject: 'checkout',
      window: 'incident',
      logClass: 'error',
      count: 0,
      coverage: 'complete',
    }),
    'absent',
  );
});

test('observedPresence: a zero count under partial coverage is unknown, never absent', () => {
  assert.equal(
    domain.observedPresence({
      form: 'log-class-in-window',
      subject: 'checkout',
      window: 'incident',
      logClass: 'error',
      count: 0,
      coverage: 'partial',
    }),
    'unknown',
  );
});

test('observedPresence: a signal-state fact is always unknown, since it carries no presence semantics', () => {
  assert.equal(
    domain.observedPresence({
      form: 'signal-state',
      subject: 'checkout-db-pool',
      window: 'incident',
      signal: 'connection-pool',
      state: 'at-limit',
    }),
    'unknown',
  );
});

/* -------------------------------------------------------------------------- */
/* leakage: the vocabulary names classes, never the corpus's own answers      */
/* -------------------------------------------------------------------------- */

/**
 * D5: the mechanism vocabulary stays in evals and is derived from the corpus.
 * `ObservationWindowSchema`, `LogClassSchema`, `SignalKindSchema` and
 * `SignalStateSchema` are the domain's OWN vocabulary, named independently of
 * the corpus — this proves that independence structurally, against the real
 * registries, rather than by a hand-written list that could drift from either
 * side.
 */
test('names no scenario id or structural-ground-truth root-cause component in the observation vocabulary', () => {
  const scenarioIds = new Set(evals.REPLAY_SCENARIOS.map((scenario) => scenario.id));
  const groundTruthComponents = new Set(
    Object.values(evals.STRUCTURAL_GROUND_TRUTH)
      .map((entry) => entry.rootCause?.component)
      .filter((component) => component !== undefined),
  );

  assert.ok(scenarioIds.size > 0, 'REPLAY_SCENARIOS must name at least one scenario, or this sweep checks nothing');
  assert.ok(
    groundTruthComponents.size > 0,
    'STRUCTURAL_GROUND_TRUTH must name at least one root-cause component, or this sweep checks nothing',
  );

  const vocabularies = {
    ObservationWindowSchema: domain.ObservationWindowSchema.options,
    LogClassSchema: domain.LogClassSchema.options,
    SignalKindSchema: domain.SignalKindSchema.options,
    SignalStateSchema: domain.SignalStateSchema.options,
  };

  for (const [name, members] of Object.entries(vocabularies)) {
    assert.ok(members.length > 0, `${name} must declare members, or this sweep passes vacuously`);
    for (const member of members) {
      assert.equal(
        scenarioIds.has(member),
        false,
        `${name} member ${JSON.stringify(member)} must not equal a REPLAY_SCENARIOS id`,
      );
      assert.equal(
        groundTruthComponents.has(member),
        false,
        `${name} member ${JSON.stringify(member)} must not equal a structural-ground-truth root-cause component`,
      );
    }
  }
});
