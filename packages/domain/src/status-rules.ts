/**
 * The persisted shape of `IncidentState`. It moves whenever a required field is
 * added to `IncidentStateControlSchema` — a strict object — or to the persisted
 * `incident` itself, so state persisted under an older version is missing
 * something the current one requires: 1 -> 2 for the graph-owned logical budget
 * counters (`iterationsUsed`, `llmCallsUsed`), 2 -> 3 for `resumeCount`, and
 * 3 -> 4 for the now-required `incident.primaryScope` (AIC-96). Nothing
 * coerces a missing counter to a default — a run that resumed with an invented
 * usage count would under-report what it had spent.
 *
 * ⚠ **This literal alone guards one path, not both.** It is reached through
 * `IncidentStateSchema`, which the graph applies to a `kind: 'start'` input and
 * to nothing else; a `kind: 'resume'` takes its state from the checkpointer,
 * which parses nothing. The resume path is guarded separately, by the graph's
 * own `assertPersistedStateVersion`. Before that guard existed, a version-1
 * checkpoint resumed to completion.
 *
 * ⚠ **Only the resume guard names the version in what a caller sees.** This
 * literal produces a zod issue that does name it, but the graph collapses every
 * schema failure into one `invalid investigation execution input`, so a
 * version-1 START input is refused without saying why. Refused either way; only
 * one of the two is diagnosable from the message.
 *
 * see hitl-resume-contract.test.mjs › "resuming ${persisted.label} with
 * ${label} fails loudly at the schema version boundary" and
 * domain-contract.test.mjs › "rejects control state persisted under the
 * previous schema version"
 *
 * `STATUS_RULES_VERSION` is deliberately NOT moved with it. The two version
 * facts are independent: this one describes the persisted state shape, that one
 * describes the status derivation rules, which AIC-62 does not touch.
 */
export const INCIDENT_STATE_SCHEMA_VERSION = 4 as const;
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
