/**
 * AIC-140: the one bounded structural walk over an untrusted JSON-shaped
 * value, shared by every caller that must refuse a value too deep or too
 * large to canonicalise safely rather than let it overflow a later,
 * unbounded recursive walk (`canonicalJson`, `execution.ts`).
 *
 * AIC-135 first wrote this walk as a private function inside
 * `packages/roles/src/investigation-roles.ts` (`uncanonicalisableInputViolation`).
 * AIC-140 moves it here so a second caller — `apps/cli`'s `--replay` fixture
 * parser — does not grow its own copy of the same bounds and the same walk
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 * Each caller maps the structured `BoundedJsonViolation` this returns to its
 * own wording; `packages/roles/src/investigation-roles.ts` keeps its exact
 * pre-AIC-140 refusal strings byte-for-byte — see roles-model-nodes.test.mjs
 * › "refuses a discriminating test whose input nests exactly 33 levels deep,
 * one past the guard's own depth bound" and its neighbouring rows in that
 * file for the pinned wording.
 *
 * Deliberately iterative (an explicit stack, no recursion over the input),
 * with an explicit depth bound and a node-count budget checked both on push
 * and on visit, never a catch around a stack overflow:
 * `.claude/rules/invariants.md`, "A guard that fails open must do provably
 * bounded work" — a caught `RangeError`'s threshold depends on ambient stack
 * size, which is not a bound at all.
 *
 * Pure: no clock, env or I/O — every input is a plain value already on hand.
 */

export const BOUNDED_JSON_MAX_DEPTH = 32;
export const BOUNDED_JSON_MAX_NODES = 5000;

export interface BoundedJsonBounds {
  readonly maxDepth?: number;
  readonly maxNodes?: number;
}

export type BoundedJsonViolation =
  | { readonly kind: 'depth'; readonly limit: number }
  | { readonly kind: 'size'; readonly limit: number }
  | { readonly kind: 'non-finite' }
  | { readonly kind: 'shape'; readonly detail: 'non-plain-object' | 'unserializable' };

interface Frame {
  readonly value: unknown;
  readonly depth: number;
}

/**
 * `undefined` when `value` is a JSON-serialisable plain shape within both
 * bounds; otherwise the first violation the walk meets, in the same order
 * `uncanonicalisableInputViolation` checked them in before this move: the
 * node budget first (on both visit and push), then depth, then the value's
 * own shape.
 */
export function boundedJsonViolation(
  value: unknown,
  bounds: BoundedJsonBounds = {},
): BoundedJsonViolation | undefined {
  const maxDepth = bounds.maxDepth ?? BOUNDED_JSON_MAX_DEPTH;
  const maxNodes = bounds.maxNodes ?? BOUNDED_JSON_MAX_NODES;

  const stack: Frame[] = [{ value, depth: 0 }];
  let visited = 0;
  while (stack.length > 0) {
    const frame = stack.pop() as Frame;
    visited += 1;
    if (visited > maxNodes) {
      return { kind: 'size', limit: maxNodes };
    }
    if (frame.depth > maxDepth) {
      return { kind: 'depth', limit: maxDepth };
    }

    const current = frame.value;
    if (current === null || typeof current === 'boolean' || typeof current === 'string') {
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        return { kind: 'non-finite' };
      }
      continue;
    }
    if (Array.isArray(current)) {
      if (visited + stack.length + current.length > maxNodes) {
        return { kind: 'size', limit: maxNodes };
      }
      for (const item of current) stack.push({ value: item, depth: frame.depth + 1 });
      continue;
    }
    if (typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) {
        return { kind: 'shape', detail: 'non-plain-object' };
      }
      const keys = Object.keys(current as Record<string, unknown>);
      if (visited + stack.length + keys.length > maxNodes) {
        return { kind: 'size', limit: maxNodes };
      }
      for (const key of keys) {
        stack.push({ value: (current as Record<string, unknown>)[key], depth: frame.depth + 1 });
      }
      continue;
    }
    return { kind: 'shape', detail: 'unserializable' };
  }
  return undefined;
}
