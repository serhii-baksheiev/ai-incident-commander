/**
 * AIC-98, slice b: this file pins the seventh credential shape
 * `redactEvidenceOutput` recognises — a fine-grained GitHub PAT
 * (`github_pat_...`), documented alongside the other six in
 * `packages/tools/src/redaction.ts`'s own header. The github@1 evidence
 * source (`test/github-evidence-source.test.mjs`) is why this shape has to
 * be redacted: the github@1 token must never survive redaction into a
 * persisted recording or a returned outcome. This file pins the shape
 * directly against `redactEvidenceOutput`, mirroring
 * `test/bound-source-registry.test.mjs`'s own pattern-row and near-miss
 * conventions for the other six shapes.
 *
 * GitHub's documented fine-grained PAT format is the literal `github_pat_`
 * followed by exactly 82 characters of `[A-Za-z0-9_]`. Every positive
 * fixture below is assembled from separate string pieces at runtime, never
 * written out as one contiguous literal, per this project's own
 * guard-secret-file vocabulary (`.claude/scripts/lib/secrets.mjs`'s
 * `github-pat` pattern, `github_pat_[A-Za-z0-9_]{20,}`) and mirroring
 * `test/bound-source-registry.test.mjs`'s `fixtureGithubToken` and
 * `test/github-evidence-source.test.mjs`'s `fixtureGithubFineGrainedPat`
 * fixtures. None of these are real credentials.
 *
 * Minimum-length note for the Green step: this file's positive rows use the
 * full 82-character suffix GitHub documents, but
 * `test/github-evidence-source.test.mjs`'s own `fixtureGithubFineGrainedPat`
 * (already committed, already asserting the token must never survive
 * redaction — see that file's "the token value never appears in the
 * serialized outcome" row) uses an 80-character suffix. A production pattern
 * anchored to exactly 82 characters would satisfy this file's own rows while
 * leaving that other file's row unsatisfied. This file does not pin an exact
 * 82-vs-81 length cutoff for that reason: a minimum-length pattern (e.g.
 * `{20,}`, the same shape `.claude/scripts/lib/secrets.mjs`'s own
 * `github-pat` entry already uses) satisfies every row here without
 * conflicting with that other file's shorter fixture.
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import test from 'node:test';

import * as tools from '@aic/tools';

/* -------------------------------------------------------------------------- */
/* Export factory — asserts the export exists, mirroring                      */
/* test/bound-source-registry.test.mjs's own redactEvidenceOutputFactory      */
/* -------------------------------------------------------------------------- */

function redactEvidenceOutputFactory() {
  assert.equal(
    typeof tools.redactEvidenceOutput,
    'function',
    '@aic/tools must export redactEvidenceOutput(value): a pure, deep, bounded redactor over JSON values (AIC-100 slice c)',
  );
  return tools.redactEvidenceOutput;
}

/* -------------------------------------------------------------------------- */
/* Fixtures — assembled from pieces at runtime, never one contiguous literal  */
/* -------------------------------------------------------------------------- */

const GITHUB_PAT_PREFIX = ['github', '_pat_'].join('');

// GitHub's documented fine-grained PAT suffix: exactly 82 characters of
// [A-Za-z0-9_] (this file's own pinned positive length; see the header note
// above on why no exact-length boundary row is pinned against it).
const fixtureGithubFineGrainedPatSuffix = '1'.repeat(22) + '_' + 'B'.repeat(59);
const fixtureGithubFineGrainedPat = [GITHUB_PAT_PREFIX, fixtureGithubFineGrainedPatSuffix].join('');

// Near miss: the prefix followed by only a few characters — far short of any
// credential-shaped suffix.
const fixtureGithubPatTooShort = [GITHUB_PAT_PREFIX, 'AbC12'].join('');

/* -------------------------------------------------------------------------- */
/* Positive rows — a fine-grained GitHub PAT is redacted in every position    */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput replaces a bare fine-grained GitHub PAT string with [REDACTED]', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  assert.equal(redactEvidenceOutput(fixtureGithubFineGrainedPat), '[REDACTED]');
});

test('redactEvidenceOutput replaces a fine-grained GitHub PAT nested as an object value with [REDACTED]', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = { token: fixtureGithubFineGrainedPat, other: 'kept as-is' };

  const output = redactEvidenceOutput(input);

  assert.equal(output.token, '[REDACTED]');
  assert.equal(output.other, 'kept as-is');
});

test('redactEvidenceOutput replaces a fine-grained GitHub PAT embedded mid-sentence with [REDACTED], keeping surrounding text', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `token=${fixtureGithubFineGrainedPat} appeared in the log line`;

  assert.equal(redactEvidenceOutput(input), 'token=[REDACTED] appeared in the log line');
});

test('redactEvidenceOutput replaces a fine-grained GitHub PAT inside a JSON-escaped string (a raw JSON body carried as text, backslash-escaped quotes and all) with [REDACTED]', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `raw body: {\\"token\\":\\"${fixtureGithubFineGrainedPat}\\"} end`;

  assert.equal(redactEvidenceOutput(input), 'raw body: {\\"token\\":\\"[REDACTED]\\"} end');
});

/* -------------------------------------------------------------------------- */
/* Boundary rows — near-misses that must stay unredacted                     */
/* -------------------------------------------------------------------------- */

test('redactEvidenceOutput leaves a "github_pat_" prefix followed by only a few characters alone (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `token=${fixtureGithubPatTooShort} appeared in the log line`;

  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput leaves the bare "github_pat_" prefix alone, with nothing following it (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `token=${GITHUB_PAT_PREFIX} appeared in the log line`;

  assert.equal(redactEvidenceOutput(input), input);
});

test('redactEvidenceOutput leaves a fine-grained-PAT-shaped run alone when "github_pat_" is preceded by a word character (near miss)', () => {
  const redactEvidenceOutput = redactEvidenceOutputFactory();
  const input = `identifier: x${fixtureGithubFineGrainedPat} follows`;

  assert.equal(redactEvidenceOutput(input), input);
});

/* -------------------------------------------------------------------------- */
/* Bounded-work row — an adversarial input completes within a generous bound */
/* (`.claude/rules/invariants.md`, "a guard that fails open must do provably */
/* bounded work", applied here as test/bound-source-registry.test.mjs's own  */
/* PEM- and URL-timing rows already apply it to the other five shapes)       */
/* -------------------------------------------------------------------------- */

const ONE_MIB_CHARS = 1024 * 1024;
const TIMING_BOUND_MS = 2000;

test(
  'redactEvidenceOutput stays within a bound on ~1 MiB of the repeated literal "github_pat_" with no credential-shaped suffix',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = GITHUB_PAT_PREFIX.repeat(Math.ceil(ONE_MIB_CHARS / GITHUB_PAT_PREFIX.length));

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${TIMING_BOUND_MS}ms on ~1 MiB of the repeated "github_pat_" literal; took ${elapsedMs}ms`,
    );
  },
);

test(
  'redactEvidenceOutput stays within a bound on a "github_pat_" prefix followed by ~1 MiB of credential-shaped characters',
  { timeout: 10_000 },
  () => {
    const redactEvidenceOutput = redactEvidenceOutputFactory();
    const input = GITHUB_PAT_PREFIX + 'A'.repeat(ONE_MIB_CHARS);

    const startedAtMs = performance.now();
    redactEvidenceOutput(input);
    const elapsedMs = performance.now() - startedAtMs;

    assert.ok(
      elapsedMs < TIMING_BOUND_MS,
      `redactEvidenceOutput must stay under ${TIMING_BOUND_MS}ms on a "github_pat_" prefix followed by ~1 MiB of credential-shaped characters; took ${elapsedMs}ms`,
    );
  },
);
