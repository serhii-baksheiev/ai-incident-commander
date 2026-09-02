/**
 * The persisted shape of `IncidentState`. Moved 1 -> 2 when the graph-owned
 * logical budget counters (`iterationsUsed`, `llmCallsUsed`) joined
 * `IncidentStateControlSchema`: that schema is a strict object, so state
 * persisted under version 1 lacks fields version 2 requires. Rejecting it at
 * this literal is the point — an old checkpoint fails at the version boundary
 * with the version named, rather than as an unrecognised-keys error that reads
 * like a bug. Nothing coerces a missing counter to a default: a run that
 * resumed with an invented usage count would under-report what it had spent.
 *
 * `STATUS_RULES_VERSION` is deliberately NOT moved with it. The two version
 * facts are independent: this one describes the persisted state shape, that one
 * describes the status derivation rules, which AIC-62 does not touch.
 */
export const INCIDENT_STATE_SCHEMA_VERSION = 2 as const;
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
