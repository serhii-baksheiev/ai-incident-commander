/**
 * AIC-120: the durable hold-out record is complete before LangSmith is ever
 * touched, and LangSmith publication is decided and tracked separately from
 * the one-shot measurement.
 *
 * The owner ruling behind this module: the final hold-out is a one-shot
 * measurement, and LangSmith is a publication SINK, not the measurement's
 * transaction coordinator. This module is the pure half of that split — what
 * to publish (`planHoldoutPublication`), what one publication attempt looks
 * like on the wire (`parsePublicationAttempt`), and what a run of attempts
 * adds up to (`summarizeHoldoutPublication`). It reads no filesystem, no
 * environment and makes no network call: `scripts/final-holdout-publication.mjs`
 * owns the disk, the append-only attempt log and the LangSmith calls, and
 * hands this module the values it decides from.
 *
 * Every input is read own-only, in the style
 * `packages/evals/src/final-evaluation-record.ts` already established: a
 * `report`/`experiments`/`plan`/`attempts` object supplied by a caller must
 * not be trusted to answer through its prototype chain.
 */

/** The one schema version a publication attempt on the wire declares. */
export const FINAL_EVALUATION_PUBLICATION_VERSION = 1;

/**
 * The arms LangSmith publication ever covers, in publish order.
 *
 * Order matters here the same way it mattered in the `publishHoldoutArms`
 * this module replaces: the model arm is attempted before the naive arm, and
 * every loop over this tuple — the plan, the summary, the orchestration in
 * `scripts/final-holdout-publication.mjs` — inherits that order from this one
 * declaration rather than repeating it.
 */
export const FINAL_EVALUATION_PUBLISHABLE_ARMS = Object.freeze(['model', 'naive'] as const);

type PublishableArm = (typeof FINAL_EVALUATION_PUBLISHABLE_ARMS)[number];

const PUBLISHABLE_ARM_SET: ReadonlySet<string> = new Set(FINAL_EVALUATION_PUBLISHABLE_ARMS);

/** An own data property, never a value the prototype chain or a getter supplied. */
const ownSlot = (source: unknown, key: string): { present: boolean; value?: unknown } => {
  if (source === null || typeof source !== 'object') return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return { present: false };
  }
  return { present: true, value: descriptor.value };
};

const ownValue = (source: unknown, key: string): unknown => ownSlot(source, key).value;

const ownString = (source: unknown, key: string): string | undefined => {
  const slot = ownSlot(source, key);
  return slot.present && typeof slot.value === 'string' && !/^\s*$/.test(slot.value)
    ? slot.value
    : undefined;
};

/** One arm's publication decision: either required, or not, with the reason why. */
export type PublicationPlanEntry =
  | Readonly<{ required: true }>
  | Readonly<{ required: false; reason: string }>;

export interface HoldoutPublicationPlan {
  readonly model: PublicationPlanEntry;
  readonly naive: PublicationPlanEntry;
}

function planModelArm(modelArm: unknown, modelExperiment: unknown): PublicationPlanEntry {
  const reportable = ownValue(modelArm, 'reportable') === true;
  const hasExperiment = typeof modelExperiment === 'object' && modelExperiment !== null;
  if (reportable && hasExperiment) return Object.freeze({ required: true });
  const reason =
    ownString(modelArm, 'unreportableReason') ?? 'the model arm produced no experiment to publish';
  return Object.freeze({ required: false, reason });
}

function planNaiveArm(naiveArm: unknown, naiveExperiment: unknown): PublicationPlanEntry {
  const status = ownString(naiveArm, 'status');
  if (status === 'not-run') {
    return Object.freeze({
      required: false,
      reason: ownString(naiveArm, 'reason') ?? 'the caller supplied no naive arm',
    });
  }
  if (status === 'refused') {
    return Object.freeze({
      required: false,
      reason: ownString(naiveArm, 'refusalReason') ?? 'the naive arm refused',
    });
  }
  if (ownValue(naiveArm, 'reportable') !== true) {
    return Object.freeze({
      required: false,
      reason: ownString(naiveArm, 'unreportableReason') ?? 'the naive arm is not reportable',
    });
  }
  if (typeof naiveExperiment !== 'object' || naiveExperiment === null) {
    return Object.freeze({ required: false, reason: 'the naive arm produced no experiment to publish' });
  }
  return Object.freeze({ required: true });
}

/**
 * Decide which of the two publishable arms LangSmith publication is REQUIRED
 * for, and why not for the other — the same three reasons the deleted
 * `publishHoldoutArms`/`publishNaiveArm` used to decide with, restated as a
 * plan rather than executed inline.
 * see final-evaluation-publication.test.mjs › "planHoldoutPublication requires both arms, in publish order, when each is reportable and carries an experiment"
 */
export function planHoldoutPublication(
  options: Readonly<{ report: unknown; experiments: unknown }>,
): HoldoutPublicationPlan {
  const report = ownValue(options, 'report');
  const experiments = ownValue(options, 'experiments');
  const arms = ownValue(report, 'arms');

  const model = planModelArm(ownValue(arms, 'model'), ownValue(experiments, 'model'));
  const naive = planNaiveArm(ownValue(arms, 'naive'), ownValue(experiments, 'naive'));

  return Object.freeze({ model, naive });
}

const PUBLICATION_ATTEMPT_MODES: ReadonlySet<string> = new Set(['with-measurement', 'publication-only']);
const PUBLICATION_ATTEMPT_OUTCOMES: ReadonlySet<string> = new Set([
  'verified',
  'ingestion-failed',
  'readback-failed',
]);

export type PublicationAttemptMode = 'with-measurement' | 'publication-only';
export type PublicationAttemptOutcome = 'verified' | 'ingestion-failed' | 'readback-failed';

/** One line of the append-only attempt log beside a hold-out record. */
export interface PublicationAttempt {
  readonly schemaVersion: 1;
  readonly measurementId: string;
  readonly candidateFingerprint: string;
  readonly measurementSha256: string;
  readonly attemptId: string;
  readonly attemptedAt: string;
  readonly mode: PublicationAttemptMode;
  readonly arm: PublishableArm;
  readonly outcome: PublicationAttemptOutcome;
  readonly datasetName: string;
  /** Required for `verified` and `readback-failed`; absent for `ingestion-failed`. */
  readonly reference?: Readonly<Record<string, unknown>>;
  /** Required for the two failure outcomes; absent for `verified`. */
  readonly reason?: string;
}

/**
 * Parse one publication attempt, strictly and own-property only.
 *
 * Refuses BY NAME: an unknown schema version, an unknown arm, an unknown
 * outcome, an unknown mode, a failure outcome with no reason, and a
 * `verified`/`readback-failed` outcome with no reference. Nothing here trusts
 * the shape the log line claims — a line an earlier version of this module
 * wrote is read exactly as strictly as one a caller hands in directly.
 * see final-evaluation-publication.test.mjs › "parsePublicationAttempt accepts a well-formed verified attempt"
 */
export function parsePublicationAttempt(candidate: unknown): PublicationAttempt {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('a publication attempt must be an object');
  }

  const version = ownSlot(candidate, 'schemaVersion');
  if (!version.present || version.value !== FINAL_EVALUATION_PUBLICATION_VERSION) {
    throw new Error(
      `a publication attempt must declare its own schemaVersion ${FINAL_EVALUATION_PUBLICATION_VERSION}`,
    );
  }

  const measurementId = ownString(candidate, 'measurementId');
  if (measurementId === undefined) {
    throw new Error('a publication attempt must own a measurementId');
  }
  const candidateFingerprint = ownString(candidate, 'candidateFingerprint');
  if (candidateFingerprint === undefined) {
    throw new Error('a publication attempt must own a candidateFingerprint');
  }
  const measurementSha256 = ownString(candidate, 'measurementSha256');
  if (measurementSha256 === undefined) {
    throw new Error('a publication attempt must own a measurementSha256');
  }
  const attemptId = ownString(candidate, 'attemptId');
  if (attemptId === undefined) {
    throw new Error('a publication attempt must own an attemptId');
  }
  const attemptedAt = ownString(candidate, 'attemptedAt');
  if (attemptedAt === undefined) {
    throw new Error('a publication attempt must own an attemptedAt');
  }
  const mode = ownString(candidate, 'mode');
  if (mode === undefined || !PUBLICATION_ATTEMPT_MODES.has(mode)) {
    throw new Error('a publication attempt must own a known mode: with-measurement or publication-only');
  }
  const arm = ownString(candidate, 'arm');
  if (arm === undefined || !PUBLISHABLE_ARM_SET.has(arm)) {
    throw new Error('a publication attempt must own a known arm: model or naive');
  }
  const outcome = ownString(candidate, 'outcome');
  if (outcome === undefined || !PUBLICATION_ATTEMPT_OUTCOMES.has(outcome)) {
    throw new Error('a publication attempt must own a known outcome');
  }
  const datasetName = ownString(candidate, 'datasetName');
  if (datasetName === undefined) {
    throw new Error('a publication attempt must own a datasetName');
  }

  const referenceSlot = ownSlot(candidate, 'reference');
  const hasReference =
    referenceSlot.present && typeof referenceSlot.value === 'object' && referenceSlot.value !== null;
  const reason = ownString(candidate, 'reason');

  const shared = {
    schemaVersion: FINAL_EVALUATION_PUBLICATION_VERSION as 1,
    measurementId,
    candidateFingerprint,
    measurementSha256,
    attemptId,
    attemptedAt,
    mode: mode as PublicationAttemptMode,
    arm: arm as PublishableArm,
    outcome: outcome as PublicationAttemptOutcome,
    datasetName,
  };

  if (outcome === 'verified') {
    if (!hasReference) {
      throw new Error('a verified publication attempt must own a reference');
    }
    if (reason !== undefined) {
      throw new Error('a verified publication attempt must carry no reason');
    }
    return Object.freeze({
      ...shared,
      reference: referenceSlot.value as Readonly<Record<string, unknown>>,
    });
  }

  if (reason === undefined) {
    throw new Error(`a ${outcome} publication attempt must own a reason`);
  }

  if (outcome === 'readback-failed') {
    if (!hasReference) {
      throw new Error('a readback-failed publication attempt must own a reference');
    }
    return Object.freeze({
      ...shared,
      reference: referenceSlot.value as Readonly<Record<string, unknown>>,
      reason,
    });
  }

  return Object.freeze({ ...shared, reason });
}

/** One publishable arm's outcome, distilled from its plan entry and its attempts. */
export type PublicationArmSummary =
  | Readonly<{ state: 'not-required'; reason: string }>
  | Readonly<{ state: 'not-attempted' }>
  | Readonly<{
      state: 'verified' | 'ingestion-failed' | 'readback-failed';
      attempts: number;
      last: PublicationAttempt;
    }>;

export interface HoldoutPublicationSummary {
  readonly satisfied: boolean;
  readonly arms: Readonly<Record<PublishableArm, PublicationArmSummary>>;
}

/**
 * Summarize an arm's state: VERIFIED is sticky — any attempt for the arm that
 * verified means the arm stays verified, whatever a later attempt did — and
 * otherwise the arm carries the state of its LAST attempt.
 * see final-evaluation-publication.test.mjs › "summarizeHoldoutPublication keeps an arm verified even when a later attempt for it failed"
 */
export function summarizeHoldoutPublication(
  options: Readonly<{
    plan: HoldoutPublicationPlan;
    attempts: readonly PublicationAttempt[];
    measurementSha256: string;
  }>,
): HoldoutPublicationSummary {
  const measurementSha256 = ownString(options, 'measurementSha256');
  if (measurementSha256 === undefined) {
    throw new Error('summarizing a publication requires an own measurementSha256');
  }
  const attemptsSlot = ownSlot(options, 'attempts');
  if (!attemptsSlot.present || !Array.isArray(attemptsSlot.value)) {
    throw new Error('summarizing a publication requires an own attempts array');
  }
  const planSlot = ownSlot(options, 'plan');
  if (!planSlot.present || typeof planSlot.value !== 'object' || planSlot.value === null) {
    throw new Error('summarizing a publication requires an own plan');
  }
  const plan = planSlot.value;
  const attempts = attemptsSlot.value as readonly PublicationAttempt[];

  for (const attempt of attempts) {
    if (ownString(attempt, 'measurementSha256') !== measurementSha256) {
      throw new Error(
        'a publication attempt carries a different measurementSha256 than the measured record: the measured record changed after it was published',
      );
    }
  }

  const arms = {} as Record<PublishableArm, PublicationArmSummary>;
  for (const arm of FINAL_EVALUATION_PUBLISHABLE_ARMS) {
    const planEntry = ownValue(plan, arm) as PublicationPlanEntry | undefined;
    if (planEntry === undefined || planEntry.required !== true) {
      arms[arm] = Object.freeze({
        state: 'not-required',
        reason: planEntry !== undefined && planEntry.required === false ? planEntry.reason : 'not required',
      });
      continue;
    }

    const armAttempts = attempts.filter((attempt) => ownString(attempt, 'arm') === arm);
    if (armAttempts.length === 0) {
      arms[arm] = Object.freeze({ state: 'not-attempted' });
      continue;
    }

    const verified = armAttempts.filter((attempt) => attempt.outcome === 'verified').at(-1);
    if (verified !== undefined) {
      arms[arm] = Object.freeze({ state: 'verified', attempts: armAttempts.length, last: verified });
      continue;
    }

    const last = armAttempts[armAttempts.length - 1] as PublicationAttempt;
    arms[arm] = Object.freeze({ state: last.outcome, attempts: armAttempts.length, last });
  }

  const satisfied = FINAL_EVALUATION_PUBLISHABLE_ARMS.every((arm) => {
    const entry = arms[arm];
    return entry.state === 'not-required' || entry.state === 'verified';
  });

  return Object.freeze({ satisfied, arms: Object.freeze({ ...arms }) });
}
