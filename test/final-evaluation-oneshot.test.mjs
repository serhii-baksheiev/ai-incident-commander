/**
 * The one-shot property of the final hold-out evaluation.
 *
 * AIC-19 requires a "declared one-shot final hold-out evaluation". Before this
 * module the one-shot part was a sentence: the partition was frozen and the
 * plan builders refused a caller-supplied subset, but nothing recorded that the
 * hold-out HAD run, so a second run was free and invisible.
 *
 * 🔴 **The key is a candidate fingerprint, not a commit SHA, and that choice is
 * the whole design.** Follow the commit-SHA version through: the run happens at
 * SHA X, the record must be committed (a gitignored record is one `rm` from a
 * free re-run), committing it produces SHA Y, and a re-run at Y is a re-run at a
 * "new commit" whose only difference is the evidence the previous run wrote. The
 * lock opens itself, once per re-run, forever. A fingerprint over the paths that
 * can change what the graph does does not move when the evidence is committed.
 *
 * The exclusion list is asymmetric on purpose: omitting a path that DOES affect
 * behaviour causes a false refusal, which is safe; including one that does not
 * causes a false unlock, which is not.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import * as evals from '@aic/evals';

import { requireFunction } from './fixtures/benchmark-experiment.mjs';

/** A record covering `fingerprint`, in whichever state the caller asks for. */
function recordFor(fingerprint, status = 'complete', extra = {}) {
  return {
    schemaVersion: 1,
    status,
    candidate: { fingerprint, headSha: 'a'.repeat(40), workingTreeClean: true },
    corpus: { scenarioSet: 'final-evaluation', fingerprint: 'corpus-1' },
    ...extra,
  };
}

const decide = () =>
  requireFunction(evals, 'decideFinalEvaluation', '@aic/evals');

test('admits a final hold-out run at a candidate no record covers', () => {
  const outcome = decide()({
    records: [recordFor('sha256:other')],
    candidateFingerprint: 'sha256:this',
  });

  assert.equal(outcome.admit, true, 'a candidate nothing covers has not spent its one shot');
});

test('refuses a second final hold-out run at the same candidate fingerprint', () => {
  const outcome = decide()({
    records: [recordFor('sha256:this')],
    candidateFingerprint: 'sha256:this',
  });

  assert.equal(outcome.admit, false, 'the hold-out is spent for this candidate');
  assert.match(
    outcome.reason,
    /sha256:this/,
    `the refusal must name the candidate it refused: ${outcome.reason}`,
  );
  assert.equal(
    typeof outcome.remedy,
    'string',
    'a refusal the caller cannot act on is a loop: the remedy travels beside the reason, decided where the reason is decided',
  );
});

test('admits a final hold-out run once the candidate fingerprint moves', () => {
  const records = [recordFor('sha256:before')];

  assert.equal(decide()({ records, candidateFingerprint: 'sha256:before' }).admit, false);
  assert.equal(
    decide()({ records, candidateFingerprint: 'sha256:after' }).admit,
    true,
    'a real change to what the graph does earns a new evaluation; that is the case this mechanism must not block',
  );
});

test('refuses a re-run at a candidate whose only change is the evidence record it wrote', () => {
  // The load-bearing row. The record lands under `docs/`, so if `docs/` were a
  // candidate path the act of recording a run would unlock the next one — the
  // commit-SHA design, reached by a different route.
  const paths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;
  assert.ok(Array.isArray(paths), 'the candidate path list is exported so nothing restates it');

  for (const excluded of ['docs', 'journal', 'README.md', '.claude', '.rig']) {
    assert.equal(
      paths.some((entry) => entry === excluded || entry.startsWith(`${excluded}/`)),
      false,
      `${excluded} must not be a candidate path: writing evidence, a journal entry or a rule would move the fingerprint and hand back a free re-run, which is exactly the defect keying on the commit SHA has`,
    );
  }
});

test('fingerprints exactly the paths that can change what the graph does', () => {
  const paths = evals.FINAL_EVALUATION_CANDIDATE_PATHS;

  for (const required of ['packages', 'scripts']) {
    assert.ok(
      paths.includes(required),
      `${required} changes what the graph does, and omitting it would let a real change re-use a spent candidate`,
    );
  }
  assert.equal(Object.isFrozen(paths), true, 'an exported array an importer can splice is not a declaration');
});

test('treats a record it cannot parse as a refusal rather than as an absence', () => {
  const parse = requireFunction(evals, 'parseFinalEvaluationRecord', '@aic/evals');

  for (const shape of [null, 'nonsense', 42, [], { status: 'complete' }]) {
    assert.throws(
      () => parse(shape),
      /final evaluation record/i,
      `a record the guard cannot read is the refusal case, never the fail-open one: it was handed something and could tell it could not read it, which is the one thing it is for — ${JSON.stringify(shape)}`,
    );
  }
});

test('treats a record present under an unknown schema version as a refusal', () => {
  const parse = requireFunction(evals, 'parseFinalEvaluationRecord', '@aic/evals');

  assert.throws(
    () => parse({ ...recordFor('sha256:x'), schemaVersion: 99 }),
    /schemaVersion/,
    'a record written by a version this code does not know may mean something else by every field in it, so reading it as covering or not covering a candidate is a guess',
  );
});

test('matches a record by the candidate fingerprint it carries, not by the name of the file it sits in', () => {
  // The command names files after the first twelve characters of the
  // fingerprint. A renamed file must not hide a record.
  const outcome = decide()({
    records: [recordFor('sha256:this')],
    candidateFingerprint: 'sha256:this',
    fileNames: ['completely-unrelated-name.json'],
  });

  assert.equal(
    outcome.admit,
    false,
    'the decision reads the parsed field; a record renamed on disk still covers the candidate it names inside',
  );
});

test('admits a candidate whose only covering record was voided with a reason and an author', () => {
  const outcome = decide()({
    records: [
      recordFor('sha256:this', 'void', {
        voidReason: 'the first ingestion answered 429 before any scenario ran',
        voidedBy: 'the autonomous run, stated as such rather than as a person',
      }),
    ],
    candidateFingerprint: 'sha256:this',
  });

  assert.equal(
    outcome.admit,
    true,
    'a run that produced no information did not spend the shot; voiding it is a committed diff a reviewer reads rather than a flag a run flips, and that — not who typed it — is the property carrying the honesty',
  );
});

test('refuses a re-run at a candidate whose claim never completed, and names both remedies', () => {
  const outcome = decide()({
    records: [recordFor('sha256:this', 'claimed')],
    candidateFingerprint: 'sha256:this',
  });

  assert.equal(
    outcome.admit,
    false,
    'the hold-out is consumed when scenarios execute, not when the report is written: a claim that never completed means the runs happened',
  );
  assert.match(
    outcome.remedy,
    /void/i,
    `the remedy must name voiding, because a crashed run is the case a void record exists for: ${outcome.remedy}`,
  );
});
