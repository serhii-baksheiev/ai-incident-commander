/**
 * AIC-140 round-1 review fixes: `@aic/domain`'s `boundedJsonViolation`
 * (`packages/domain/src/bounded-json.ts`) is exercised through two callers
 * elsewhere (`roles-model-nodes.test.mjs` for depth/size wording,
 * `cli-investigate.test.mjs` for the CLI's own wording) but no row anywhere
 * pins its `non-finite` or `shape` branches directly — code-reviewer-r1.md
 * item 1 ("three of the five mapped branches ... are pinned by no row
 * anywhere in the suite"). This file calls `boundedJsonViolation` straight
 * from `@aic/domain`, the public entry point, with literal expectations —
 * never through either caller's own wording, so a caller's mapping cannot
 * mask a change to the shared walk's own structured result.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { boundedJsonViolation } from '@aic/domain';

test('a non-finite number (Infinity) nested in an otherwise plain object is refused with kind "non-finite"', () => {
  assert.deepEqual(boundedJsonViolation({ x: Infinity }), { kind: 'non-finite' });
});

test('a non-finite number (NaN) nested in an otherwise plain object is refused with kind "non-finite"', () => {
  assert.deepEqual(boundedJsonViolation({ x: NaN }), { kind: 'non-finite' });
});

test('a non-finite number (-Infinity) at the top level is refused with kind "non-finite"', () => {
  assert.deepEqual(boundedJsonViolation(-Infinity), { kind: 'non-finite' });
});

test('a Date instance is refused with kind "shape", detail "non-plain-object"', () => {
  assert.deepEqual(boundedJsonViolation(new Date()), { kind: 'shape', detail: 'non-plain-object' });
});

test('a Map instance is refused with kind "shape", detail "non-plain-object"', () => {
  assert.deepEqual(boundedJsonViolation(new Map()), { kind: 'shape', detail: 'non-plain-object' });
});

test('a plain object with a class-instance value (a Date, one level deep) is refused with kind "shape", detail "non-plain-object"', () => {
  assert.deepEqual(boundedJsonViolation({ when: new Date() }), { kind: 'shape', detail: 'non-plain-object' });
});

test('a bare function is refused with kind "shape", detail "unserializable"', () => {
  assert.deepEqual(boundedJsonViolation(() => undefined), { kind: 'shape', detail: 'unserializable' });
});

test('a plain object with a function value (one level deep) is refused with kind "shape", detail "unserializable"', () => {
  assert.deepEqual(
    boundedJsonViolation({ handler: () => undefined }),
    { kind: 'shape', detail: 'unserializable' },
  );
});

test('a bigint is refused with kind "shape", detail "unserializable"', () => {
  assert.deepEqual(boundedJsonViolation(1n), { kind: 'shape', detail: 'unserializable' });
});

test('a symbol is refused with kind "shape", detail "unserializable"', () => {
  assert.deepEqual(boundedJsonViolation(Symbol('x')), { kind: 'shape', detail: 'unserializable' });
});

test('a plain JSON-serialisable value within both bounds is accepted (undefined result)', () => {
  assert.equal(boundedJsonViolation({ a: [1, 2, { b: 'c' }], d: null, e: true }), undefined);
});
