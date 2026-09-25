/**
 * The persisted shape of `IncidentState`. It moves whenever state written under
 * one version would be read wrongly by the other. There are two ways that
 * happens:
 * - a field the current version requires is missing from older state:
 *   1 -> 2 for the graph-owned logical budget counters (`iterationsUsed`,
 *   `llmCallsUsed`), 2 -> 3 for `resumeCount`, 3 -> 4 for the now-required
 *   `incident.primaryScope` (AIC-96), and 4 -> 5 for the required
 *   `Prediction.observationVersion` with a typed `ExpectedObservation`
 *   (AIC-123);
 * - an optional field would be carried unvalidated by older code: 4 -> 5 also
 *   covers the hypothesis `cause`. The resume path parses nothing, so without
 *   the bump an older graph would pass a cause it cannot check into its model
 *   prompts. Nothing coerces a missing counter to a default
 * — a run that resumed with an invented usage count would under-report what it
 * had spent.
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
 * `STATUS_RULES_VERSION` moves independently of this one: AIC-119 bumped it to
 * `'v0.2'` to add the `corroborated` hypothesis status (owner ruling D1) on its
 * own schedule. Status is derived from predictions and assessments on every
 * read (`deriveHypothesisStatus`) and is never itself persisted, so a
 * status-rules version bump has nothing to migrate in
 * `IncidentStateControlSchema` — see status-rules-v02.test.mjs › "publishes
 * STATUS_RULES with the historical v0.1 table and the new v0.2 table".
 */
export const INCIDENT_STATE_SCHEMA_VERSION = 5 as const;
export const STATUS_RULES_VERSION = 'v0.2' as const;

export const BASELINE_STATUS_RULES = {
  version: 'v0.1',
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

/**
 * AIC-119 slice 1 (owner ruling D1, item 9): `corroborated` sits between
 * `supported` and `candidate` in precedence. Its rule mirrors `supported`'s
 * independence and strength requirements exactly, and is separated from it by
 * one field: `maximumConfirmedPredictions: 0` where `supported` has
 * `minimumConfirmedPredictions: 1` — "consistent with the evidence,
 * independently," never "survived a prediction test" — see
 * status-rules-v02.test.mjs › "publishes STATUS_RULES with the historical
 * v0.1 table and the new v0.2 table".
 */
const V02_STATUS_RULES = {
  version: 'v0.2',
  hypothesis: {
    statuses: ['candidate', 'supported', 'weakened', 'rejected', 'corroborated'],
    derivedFrom: ['predictions', 'assessments'],
    numericConfidence: false,
    precedence: ['rejected', 'weakened', 'supported', 'corroborated', 'candidate'],
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
      corroborated: {
        minimumIndependentSupports: 2,
        independenceKey: 'evidenceId',
        supportStrengths: ['medium', 'high'],
        forbiddenContradictionStrengths: ['medium', 'high'],
        maximumConfirmedPredictions: 0,
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

/**
 * Every status-rules table this graph can derive a hypothesis status under,
 * keyed by `STATUS_RULES_VERSION`'s value. `'v0.1'` is `BASELINE_STATUS_RULES`
 * itself (not a re-derived copy), so historical evidence and evaluation keep
 * meaning what they meant when it was recorded — see status-rules-v02.test.mjs
 * › "publishes STATUS_RULES with the historical v0.1 table and the new v0.2
 * table".
 */
export const STATUS_RULES = {
  'v0.1': BASELINE_STATUS_RULES,
  'v0.2': V02_STATUS_RULES,
} as const;

export type StatusRulesVersion = keyof typeof STATUS_RULES;
