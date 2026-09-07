/**
 * The one-shot property of the final hold-out evaluation, as a pure decision.
 *
 * AIC-19 requires a "declared one-shot final hold-out evaluation". The partition
 * was already frozen and the plan builders already refuse a caller-supplied
 * subset — but nothing recorded that the hold-out HAD run, so a second run was
 * free and left no trace. This module decides whether a run is admitted; the
 * command that owns the filesystem does the reading, the exclusive create and
 * the exit code.
 *
 * 🔴 **The key is a candidate fingerprint, not a commit SHA, and that is the
 * whole design.** Follow the commit-SHA version through: the run happens at SHA
 * X; the record must be committed, because a gitignored record is one `rm` away
 * from a free and invisible re-run; committing it produces SHA Y; and a re-run
 * at Y is a re-run at a "new commit" whose only difference is the evidence the
 * previous run wrote. The lock opens itself, once per re-run, forever. A
 * fingerprint over the paths that can change what the graph does does not move
 * when the evidence is committed.
 * see final-evaluation-oneshot.test.mjs › "refuses a re-run at a candidate whose only change is the evidence record it wrote"
 *
 * ⚠ **What this does not do, stated rather than implied.** It does not stop a
 * re-run; it makes one visible. Anyone can add a whitespace change under
 * `packages/`, move the fingerprint and earn a fresh admission — what they
 * cannot do is earn it without a commit a reviewer can see. Iterative tuning
 * against the hold-out stays possible and becomes legible. It also says nothing
 * about whether a record was deleted: the record's integrity rests on git
 * history and code review, because the alternative is infrastructure.
 * The rest of the limits live beside the records, in
 * `docs/evidence/final-evaluation/README.md`.
 */

/**
 * The paths whose content can change what the graph does.
 *
 * ⚠ **The asymmetry here is deliberate.** Omitting a path that DOES affect
 * behaviour causes a false refusal, which costs a reviewer a conversation.
 * Including one that does NOT causes a false unlock, which silently hands back
 * the one shot this module exists to spend once. So the list stays narrow, and
 * `docs/`, `journal/`, `README.md`, `.claude/` and `.rig/` are outside it on
 * purpose: a run that writes its own evidence must not thereby earn the next
 * one.
 * see final-evaluation-oneshot.test.mjs › "fingerprints exactly the paths that can change what the graph does"
 */
export const FINAL_EVALUATION_CANDIDATE_PATHS = Object.freeze([
  'packages',
  'apps',
  'scripts',
  'test/fixtures/benchmark-experiment.mjs',
  'package-lock.json',
] as const);

/** The one schema version this code knows how to read. */
export const FINAL_EVALUATION_RECORD_VERSION = 1;

/** The three states a record may be in. `void` covers nothing. */
export type FinalEvaluationStatus = 'claimed' | 'complete' | 'void';

export interface FinalEvaluationRecord {
  readonly schemaVersion: number;
  readonly status: FinalEvaluationStatus;
  readonly candidate: Readonly<{ fingerprint: string }>;
}

/** An own data property, never a value the prototype chain or a getter supplied. */
const ownValue = (source: unknown, key: string): { present: boolean; value?: unknown } => {
  if (source === null || typeof source !== 'object') return { present: false };
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
    return { present: false };
  }
  return { present: true, value: descriptor.value };
};

const ownString = (source: unknown, key: string): string | undefined => {
  const slot = ownValue(source, key);
  return slot.present && typeof slot.value === 'string' && !/^\s*$/.test(slot.value)
    ? slot.value
    : undefined;
};

/**
 * Read one record, or refuse it by name.
 *
 * 🔴 **An unreadable record is a REFUSAL, not an absence**, and the distinction
 * is the one `.claude/rules/invariants.md` says costs a credential when it is
 * got backwards. A file the guard cannot parse is a file it was handed and
 * could tell it could not read; treating that as "no record covers this
 * candidate" would admit a run precisely when the evidence directory is in a
 * state nobody understands.
 * see final-evaluation-oneshot.test.mjs › "treats a record it cannot parse as a refusal rather than as an absence"
 */
export function parseFinalEvaluationRecord(candidate: unknown): FinalEvaluationRecord {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(
      'a final evaluation record must be an object carrying schemaVersion, status and candidate',
    );
  }

  const version = ownValue(candidate, 'schemaVersion');
  if (!version.present || version.value !== FINAL_EVALUATION_RECORD_VERSION) {
    throw new Error(
      `a final evaluation record must declare its own schemaVersion ${FINAL_EVALUATION_RECORD_VERSION}: a record written by a version this code does not know may mean something else by every field in it, so reading it as covering or not covering a candidate is a guess`,
    );
  }

  const status = ownString(candidate, 'status');
  if (status !== 'claimed' && status !== 'complete' && status !== 'void') {
    throw new Error(
      'a final evaluation record must own a status of claimed, complete or void',
    );
  }

  const candidateSlot = ownValue(candidate, 'candidate');
  const fingerprint = ownString(candidateSlot.value, 'fingerprint');
  if (fingerprint === undefined) {
    throw new Error(
      'a final evaluation record must own a candidate.fingerprint: a record that does not say which candidate it covers cannot be matched against one',
    );
  }

  return Object.freeze({
    schemaVersion: FINAL_EVALUATION_RECORD_VERSION,
    status,
    candidate: Object.freeze({ fingerprint }),
  });
}

export type FinalEvaluationDecision =
  | Readonly<{ admit: true }>
  | Readonly<{ admit: false; reason: string; remedy: string }>;

/**
 * Decide whether this candidate may spend the hold-out.
 *
 * Pure: records arrive already parsed, and the caller owns every read. No
 * filesystem, no environment — a repository path is the same class of detail as
 * a provider endpoint, and neither belongs in a package four others depend on.
 *
 * 🔴 **The remedy travels beside the reason**, decided here rather than
 * pattern-matched from the wording later: a refusal the caller cannot act on is
 * a loop, and choosing the advice by re-reading the message works until somebody
 * rewords it.
 */
export function decideFinalEvaluation(
  options: Readonly<{
    records: readonly FinalEvaluationRecord[];
    candidateFingerprint: string;
  }>,
): FinalEvaluationDecision {
  const wanted = ownString(options, 'candidateFingerprint');
  if (wanted === undefined) {
    throw new Error('deciding a final evaluation requires an own candidateFingerprint');
  }
  const recordsSlot = ownValue(options, 'records');
  if (!recordsSlot.present || !Array.isArray(recordsSlot.value)) {
    throw new Error('deciding a final evaluation requires an own records array');
  }

  // Matched on the parsed field rather than on a file name, so a renamed record
  // still covers the candidate it names inside itself.
  // see final-evaluation-oneshot.test.mjs › "matches a record by the candidate fingerprint it carries, not by the name of the file it sits in"
  const covering = (recordsSlot.value as readonly FinalEvaluationRecord[]).filter(
    (record) => record.candidate.fingerprint === wanted && record.status !== 'void',
  );
  if (covering.length === 0) return Object.freeze({ admit: true as const });

  const claimedOnly = covering.every((record) => record.status === 'claimed');
  return Object.freeze({
    admit: false as const,
    reason: claimedOnly
      ? `the hold-out was claimed for candidate ${wanted} and that claim never completed: the corpus is spent when scenarios execute, not when the report is written, so the runs happened`
      : `the hold-out has already been evaluated for candidate ${wanted}`,
    remedy: claimedOnly
      ? 'change what the graph does — which moves the candidate fingerprint — or, if that run produced no information at all, commit a void record naming the reason and a person, and have the diff reviewed'
      : 'change what the graph does, which moves the candidate fingerprint. There is no flag: a second evaluation of one candidate is what this refusal exists to prevent, and voiding a completed run is a committed record a reviewer argues with rather than a switch a run flips',
  });
}
