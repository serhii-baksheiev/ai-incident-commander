/**
 * The command that owns the one shot, and the audit that keeps it the only one.
 *
 * The decision this command enforces is pure and lives in
 * `packages/evals/src/final-evaluation-record.ts`; these rows are about the
 * half that touches the disk and the half that cannot be expressed as a
 * function at all — that exactly one place in this repository reaches the
 * corpus.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from './fixtures/child-env.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every tracked source file, minus the trees a corpus name legitimately lives in. */
function sourceFilesOutsideEvals() {
  // The allow-listed environment every spawn in this tree gets: a shadowed
  // `git` must not inherit the provider credential this branch's whole subject
  // depends on.
  const tracked = execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: childEnv(),
  })
    .split('\n')
    .filter(Boolean);
  return tracked.filter((path) => {
    if (path.startsWith('packages/evals/src/')) return false;
    if (path.startsWith('test/')) return false;
    if (path.startsWith('docs/')) return false;
    if (path.startsWith('.claude/')) return false;
    if (path.endsWith('.md')) return false;
    if (path.startsWith('dist/') || path.includes('/dist/')) return false;
    return /\.(mjs|ts|js|json)$/.test(path);
  });
}

/**
 * 🔴 **The row that keeps the door single.**
 *
 * `final-evaluation` is calibration ∪ hold-out, so any caller naming it spends
 * the one shot. Before this branch the shipped `eval:live-model` named it — as a
 * literal type with no alternative — and nothing said so; it had never spent the
 * corpus only because no provider credential existed, which is an accident of an
 * environment rather than a guard.
 *
 * A guard that protects one command while a second is free is theatre, and this
 * row is what makes the singleness checkable rather than remembered: a second
 * caller turns `npm run check` red instead of quietly spending the hold-out.
 *
 * ⚠ Its limit, stated: it reads TRACKED source. A scratch file, a `node -e`, or
 * an in-process caller importing `runGraphBenchmarkExperiment` directly is not
 * seen — `packages/evals/src/benchmark-evaluation.ts` will build that caller its
 * thirty records. This catches drift, not an operator who means it.
 */
test('reaches the final-evaluation corpus from exactly one command in this repository', () => {
  // ⚠ Comment lines are dropped before the scan, and that is a real limit
  // rather than a convenience: this repository's own prose discusses the corpus
  // by name — `eval-live-model.mjs`'s header records that it used to reach it —
  // and a scan that could not tell a sentence from a call would force the
  // explanation out of the file that most needs it. The cut is the crude one,
  // a line whose first non-space character opens or continues a comment, so a
  // call sharing a line with a trailing comment is still seen and a corpus name
  // built by concatenation is not.
  const codeLines = (path) =>
    readFileSync(join(REPO_ROOT, path), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
  const namers = sourceFilesOutsideEvals().filter((path) =>
    codeLines(path).includes("'final-evaluation'"),
  );

  assert.deepEqual(
    namers,
    ['scripts/eval-final-holdout.mjs'],
    `the final-evaluation corpus includes the hold-out, so every file that names it can spend the one shot. Found: ${namers.join(', ') || '(none)'}`,
  );
});

test('declares the one-shot command as an npm script, so it is invoked by name rather than by path', () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));

  assert.equal(
    typeof manifest.scripts['eval:final-holdout'],
    'string',
    'a command reachable only as a path is a command a reader has to know exists',
  );
  assert.match(
    manifest.scripts['eval:final-holdout'],
    /eval-final-holdout\.mjs/,
    'the script must run the guarded command and not some other entry point',
  );
});

test('keeps the evidence directory committed rather than ignored', () => {
  // A gitignored record is one `rm` away from a free and invisible re-run,
  // which is the whole property the record exists to carry. `git check-ignore`
  // exits 0 when a path IS ignored and 1 when it is not, so the refusal is the
  // pass and it is asserted rather than left to an uncaught throw.
  let ignored;
  try {
    execFileSync('git', ['check-ignore', '-q', 'docs/evidence/final-evaluation/README.md'], {
      cwd: REPO_ROOT,
      stdio: 'ignore',
      env: childEnv(),
    });
    ignored = true;
  } catch {
    ignored = false;
  }

  assert.equal(
    ignored,
    false,
    'the evidence directory must be tracked: an ignored record can be removed with no diff, and then the next run is admitted with nothing to show that the previous one happened',
  );
});

test('states its limits beside the records, and every limit names something a reader can check', () => {
  const readme = readFileSync(
    join(REPO_ROOT, 'docs/evidence/final-evaluation/README.md'),
    'utf8',
  );

  for (const required of [
    'does not stop a re-run',
    'candidate fingerprint',
    'void',
  ]) {
    assert.ok(
      readme.includes(required),
      `the evidence README must state the limit naming "${required}": a mechanism whose limits are not written down is one a reader will assume covers more than it does`,
    );
  }
});
