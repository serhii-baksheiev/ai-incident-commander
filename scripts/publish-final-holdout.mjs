/**
 * `npm run eval:final-holdout:publish -- --record <path>`
 *
 * The recovery path AIC-120 adds: when a hold-out measurement completed and
 * was durably written but a required LangSmith publication did not verify,
 * this command retries publication ALONE, against the record already on
 * disk. It runs no scenario and spends nothing — there is nothing left in
 * this command that could.
 *
 * 🔴 **This file imports no role, lane or benchmark runner, and names no
 * corpus**, the same structural guarantee `scripts/final-holdout-publication.mjs`
 * states and the same reason: a recovery path that could execute a scenario
 * would defeat the one-shot property the measurement command exists to
 * protect.
 * see final-evaluation-publication.test.mjs › "T5: publish-final-holdout.mjs and final-holdout-publication.mjs import no role, lane or benchmark runner, and name no corpus, so publication cannot execute a scenario"
 *
 * `--record` is REQUIRED and takes exactly the path
 * `scripts/eval-final-holdout.mjs` printed and named in its own failure
 * message: this command never discovers a record on its own, because
 * guessing one would risk publishing the wrong candidate's measurement.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { argv, exit, stderr, stdout } from 'node:process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';
import * as observability from '@aic/observability';

import { publishRecordedMeasurement } from './final-holdout-publication.mjs';

function option(name) {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

/**
 * Retry publication for one already-complete, already-durable record.
 *
 * Refuses, before any `persist` call, when: the record is not `complete` (a
 * `claimed` record names a measurement that has not finished, so there is
 * nothing here to publish); the file's basename does not match the first 12
 * hex characters of its own candidate fingerprint (the naming contract
 * `scripts/eval-final-holdout.mjs` writes under, and the guard against
 * publishing a record found under the wrong name); or the record's bytes on
 * disk no longer match the digest an earlier attempt logged against (the
 * measured record changed after it was published, which
 * `summarizeHoldoutPublication` refuses rather than silently re-measuring).
 * see final-evaluation-publication.test.mjs › "T11a: publishOnly refuses a record still in the claimed state, and never calls persist"
 * see final-evaluation-publication.test.mjs › "T11b: publishOnly refuses a complete record whose file basename does not match its candidate fingerprint, and never calls persist"
 * see final-evaluation-publication.test.mjs › "T11c: publishOnly refuses when the record bytes changed after a prior attempt was logged, because the measured digest no longer matches, and never calls persist"
 */
export async function publishOnly({ recordPath, persist, verify, now, newAttemptId }) {
  const parsed = JSON.parse(readFileSync(recordPath, 'utf8'));
  const record = evals.parseFinalEvaluationRecord(parsed);
  if (record.status !== 'complete') {
    throw new Error(
      `refusing to publish a record whose status is not complete: ${record.status}`,
    );
  }

  const expectedBasename = `${record.candidate.fingerprint.replace('sha256:', '').slice(0, 12)}.json`;
  const actualBasename = basename(recordPath);
  if (actualBasename !== expectedBasename) {
    throw new Error(
      `refusing to publish: the record's file name (${actualBasename}) does not match its own candidate fingerprint (expected ${expectedBasename}) — a record found under the wrong name may not be the one it claims to be`,
    );
  }

  const summary = await publishRecordedMeasurement({
    recordPath,
    mode: 'publication-only',
    persist,
    verify,
    now,
    newAttemptId,
  });

  return { summary, exitCode: summary.satisfied === true ? 0 : 1 };
}

async function main() {
  const recordPath = option('record');
  if (recordPath === undefined) {
    throw new Error('--record <path> is required: this command retries publication for one already-written measurement and discovers none on its own');
  }

  const { summary, exitCode } = await publishOnly({
    recordPath,
    persist: observability.persistBenchmarkExperiment,
    verify: observability.verifyPersistedBenchmarkReference,
    now: () => new Date().toISOString(),
    newAttemptId: () => randomUUID(),
  });

  stdout.write(`${JSON.stringify({ recordPath, publication: summary }, null, 2)}\n`);
  if (exitCode !== 0) {
    stderr.write(
      `publication did not satisfy the plan for ${recordPath}; the measurement itself is unaffected and unchanged.\n`,
    );
  }
  exit(exitCode);
}

/** Realpath on both sides, the same guard `eval-final-holdout.mjs` uses. */
const invokedDirectly = () => {
  if (!argv[1]) return false;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  return real(argv[1]) === real(fileURLToPath(import.meta.url));
};

if (invokedDirectly()) {
  main().catch((error) => {
    stderr.write(`${error.message}\n`);
    exit(1);
  });
}
