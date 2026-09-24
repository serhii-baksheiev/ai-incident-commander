import { quoteModelText } from '@aic/domain';

import { ModelRoleOutputError } from './model-errors.js';
import type { ModelCompletion } from './reference-model-port.js';
import { ownValue } from './own-value.js';

/**
 * What every model-backed role shares when it reads an answer: the token
 * budget, the domain-derived enums its answer schemas carry, and the refusals
 * that decide whether an answer is the model's or the harness's doing.
 *
 * A module of its own, rather than part of `investigation-roles.ts`, so a role
 * that must not depend on the orchestration graph — the naive single-prompt
 * role — can share it: that file imports `@aic/graph`'s node types, and this
 * one imports nothing outside this package.
 */

/**
 * 🔴 **Raised from 4096, and pinned, because at 4096 the record blamed the model.**
 *
 * Measured on the one-shot hold-out at candidate `872ef36dea33`:
 * `challenge_hypothesis` stopped with `stop_reason: max_tokens` at exactly 4096
 * output tokens, the lane refused the arm, and the record read as a
 * model-quality failure. At this budget the same corpus ran to a refusal that
 * was the model's own.
 *
 * ⚠ **What consumed the 4096 is not recorded anywhere here**, so no claim about
 * it is made: the record carries the stop reason and the count, not a breakdown.
 * An earlier version of this comment asserted a cause, and `prose-reviewer` took
 * it as an unbacked claim about a third-party provider — correctly.
 * see roles-model-nodes.test.mjs › "hands the provider a token budget large enough that the reference model was not cut off at 4096"
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export const JSON_ONLY = 'Answer with one JSON document and nothing else. No prose, no code fence.';

/**
 * 🔴 **Every enum below is DERIVED from the domain schema, never restated.**
 *
 * The first version of these schemas hand-wrote them, and one was wrong within
 * an hour: `cost` was spelled `['cheap', 'moderate', 'expensive']` where the
 * domain declares `['cheap', 'medium', 'expensive']`. The model then answered
 * exactly what the schema asked for and the domain refused it — a failure this
 * lane would have recorded as the MODEL's, on the one axis it exists to report
 * honestly.
 *
 * `.claude/rules/invariants.md` states the rule this broke: "One mechanism, one
 * implementation. And one spelling of a fact… If two files enforce the same
 * invariant, they will disagree — and the one nobody is looking at is the one
 * that is wrong." Reading the options off the exported schema means a domain
 * change cannot leave a stale copy here.
 * see roles-model-nodes.test.mjs › "derives every answer-schema enum from the domain rather than restating it"
 */
export const enumOf = (schema: unknown, field: string): readonly string[] => {
  const shape = (schema as { shape?: Record<string, { options?: readonly string[] }> }).shape;
  const options = shape?.[field]?.options;
  // ⚠ `.options` is an array of SCHEMAS on a union or discriminated union, not
  // of strings — zod uses the same property name for both. No domain field is a
  // union today, so this is latent; the string check makes the refusal total
  // rather than resting on that staying true.
  if (
    options === undefined ||
    options.length === 0 ||
    !options.every((value) => typeof value === 'string')
  ) {
    throw new Error(
      `the domain schema does not declare an enum for ${field}: a hand-written fallback here is the second spelling this derivation exists to prevent`,
    );
  }
  // Copied, not handed over: `.options` is the array zod itself holds, so
  // returning it puts a live domain object inside a schema this module ships to
  // a caller. Measured before the copy: mutating it through the handed-over
  // schema persisted into every later request in the process.
  return Object.freeze([...options]);
};

/**
 * Pull the JSON document out of a completion.
 *
 * Bounded by construction: two index scans and one slice, no backtracking
 * regular expression over model-controlled text. A model that answers with prose
 * around the document is accommodated; one that answers with no document at all
 * is refused rather than defaulted.
 */
/**
 * The provider's own word for "I was cut off".
 *
 * Anthropic answers `max_tokens`; the set is kept narrow and any unknown value
 * is treated as NOT a truncation, because guessing the other way would excuse a
 * genuinely malformed answer as a harness limit — which is the same false
 * attribution in the opposite direction.
 */
const TRUNCATED_STOP_REASONS = Object.freeze(['max_tokens']);

/**
 * Refuse a completion the provider cut off, BEFORE trying to read it.
 *
 * 🔴 A truncated answer is the harness's doing, not the model's. Reporting it as
 * "the answer is not parseable JSON" attributes a token budget to model quality,
 * and this lane exists to measure exactly that quality. Measured on a real
 * calibration run before this guard existed, the lane recorded the model arm
 * unreportable for producing malformed output — where the provider had in fact
 * cut the answer off.
 * see roles-model-nodes.test.mjs › "refuses a truncated answer as a truncation rather than as malformed output"
 */
export function refuseTruncated(role: string, completion: ModelCompletion): void {
  if (
    completion.stopReason !== undefined &&
    TRUNCATED_STOP_REASONS.includes(completion.stopReason)
  ) {
    throw new ModelRoleOutputError(
      role,
      `the provider stopped the answer at the token budget (stop reason ${completion.stopReason}, ${completion.usage.outputTokens} output tokens): the answer was truncated, which is this harness cutting the model off rather than the model answering badly`,
    );
  }
}

export function parseJsonDocument(role: string, text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ModelRoleOutputError(role, 'the answer carries no JSON document');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch (cause) {
    throw new ModelRoleOutputError(
      role,
      `the answer is not parseable JSON: ${quoteModelText((cause as Error).message)}`,
    );
  }
}

/** Read a caller-controlled array off an own property, or refuse. */
export function ownArray(role: string, payload: unknown, key: string): readonly unknown[] {
  const value = ownValue(payload, key);
  if (!Array.isArray(value)) {
    throw new ModelRoleOutputError(role, `the answer declares no ${key} array`);
  }
  return value;
}

export function parseWith<T>(
  role: string,
  schema: { parse(value: unknown): T },
  value: unknown,
): T {
  try {
    return schema.parse(value);
  } catch (cause) {
    throw new ModelRoleOutputError(role, (cause as Error).message);
  }
}

/** How many unknown keys a refusal names by hand, before it just counts the rest. */
const NAMED_UNKNOWN_KEYS_CAP = 5;

/**
 * Refuse a value that carries an own key outside `allowed`.
 *
 * Shared by every role that rebuilds a model answer from its own properties
 * and must refuse a key the answer shape does not declare rather than
 * silently drop it (`naive-role.ts`'s conclusion, and `investigation-roles.ts`'s
 * `propose_conclusion`, share this one rule per
 * `.claude/rules/invariants.md`, "one mechanism, one implementation").
 * Moved here from `naive-role.ts` unchanged: same cap, same escaping, same
 * texts, so a role that already depended on this wording keeps it verbatim.
 * see naive-role.test.mjs › "refuses an unknown key on the conclusion, on a cause, and on a cause description"
 * see conclusion-role.test.mjs › "refuses an unknown key on the top-level answer, on a cause, and on a cause description (refusal 3)"
 */
export function refuseUnknownKeys(
  role: string,
  value: unknown,
  allowed: ReadonlySet<string>,
  where: string,
): void {
  if (value === null || typeof value !== 'object') return;
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length === 0) return;
  // The keys are the model's own text: each is named escaped, and only the
  // first few, so a hostile answer cannot shape or flood the message.
  const named = unknown
    .slice(0, NAMED_UNKNOWN_KEYS_CAP)
    .map((key) => JSON.stringify(key.slice(0, 80)));
  const rest = unknown.length - named.length;
  throw new ModelRoleOutputError(
    role,
    `${where} carries keys the answer shape does not declare: ${named.join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`,
  );
}
