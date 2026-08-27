export const INCIDENT_STATE_SCHEMA_VERSION = 1 as const;
export const STATUS_RULES_VERSION = 'v0.1' as const;

export const BASELINE_STATUS_RULES = {
  version: STATUS_RULES_VERSION,
  hypothesis: {
    statuses: ['candidate', 'supported', 'weakened', 'rejected'],
    derivedFrom: ['predictions', 'assessments'],
    numericConfidence: false,
    precedence: ['rejected', 'weakened', 'supported', 'candidate'],
    rules: {
      candidate: {
        fallback: true,
      },
      supported: {
        minimumIndependentSupports: 2,
        independenceKey: 'evidenceId',
        supportStrengths: ['medium', 'high'],
        forbiddenContradictionStrengths: ['medium', 'high'],
        minimumConfirmedPredictions: 1,
      },
      weakened: {
        contradictionStrengths: ['medium', 'high'],
      },
      rejected: {
        predictionStatus: 'refuted',
        evidenceReliability: 'high',
      },
    },
  },
} as const;
