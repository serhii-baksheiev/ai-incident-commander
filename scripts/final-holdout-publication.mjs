/**
 * AIC-120: the durable half of the hold-out's publication split.
 *
 * The owner ruling this file exists to carry out: the final hold-out is a
 * one-shot MEASUREMENT, and a publication sink is not its transaction
 * coordinator. By the time anything here runs, the measurement is already
 * complete and durably on disk (`writeRecordDurably` is what makes that true,
 * called from `scripts/eval-final-holdout.mjs` before this module is ever
 * asked to publish anything). What lives here is the retry-safe half:
 * writing the record itself durably, an append-only attempt log beside it,
 * and the per-arm publish/verify loop that reads and writes both.
 *
 * 🔴 **This file imports no role, lane or benchmark runner, and names no
 * corpus.** It cannot execute a scenario or spend a model call, structurally —
 * a recovery path that could re-run the measurement would defeat the one-shot
 * property this whole ticket exists to protect.
 * see final-evaluation-publication.test.mjs › "T5: publish-final-holdout.mjs and final-holdout-publication.mjs import no role, lane or benchmark runner, and name no corpus, so publication cannot execute a scenario"
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pid } from 'node:process';

import * as evals from '@aic/evals';

/**
 * Durably write `body` to `path`: write to a sibling temp file, fsync it,
 * rename it over `path`, then fsync the containing directory — so a crash
 * between the write and the rename leaves the PREVIOUS file intact rather
 * than a half-written one, and a crash after the rename cannot lose it to a
 * directory entry that was never flushed.
 *
 * The temp file is opened with `'wx'` — exclusive create, `O_CREAT | O_EXCL`
 * — rather than plain `'w'`. `'w'` has no `O_EXCL`/`O_NOFOLLOW` and follows a
 * pre-created symlink at the temp path, so a leftover temp file from a killed
 * prior run (or an attacker) replaced by a symlink turns this write into a
 * write through the link to wherever it points, followed by a rename of that
 * target into place at `path`. `'wx'` refuses to open when the path already
 * exists — symlink or not — so the write never follows it.
 * see final-evaluation-publication.test.mjs › "writeRecordDurably writes pretty-printed JSON with a trailing newline, leaving no leftover temp file"
 * see final-evaluation-publication.test.mjs › "writeRecordDurably refuses to write through a pre-created symlink at its own temp path, leaving the symlink target untouched"
 *
 * The temp name carries a fresh random token per call, so a file or symlink
 * left — or planted — at any earlier temp name cannot collide with a later
 * write, and the complete-record write after a spent hold-out is not blocked
 * by one. If a collision did happen, `'wx'` refuses it and never follows it.
 * see final-evaluation-publication.test.mjs › "writeRecordDurably ignores a leftover file or symlink at the old predictable temp name, because the temp path now carries a random per-call token"
 * see final-evaluation-publication.test.mjs › "writeRecordDurably refuses to write through a pre-created symlink at its own temp path, leaving the symlink target untouched"
 */
export async function writeRecordDurably(path, body, { token = randomBytes(6).toString('hex') } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const serialized = `${JSON.stringify(body, null, 2)}\n`;
  const tmpPath = `${path}.tmp-${pid}-${token}`;
  const fileHandle = openSync(tmpPath, 'wx');
  try {
    writeSync(fileHandle, serialized);
    fsyncSync(fileHandle);
  } finally {
    closeSync(fileHandle);
  }
  renameSync(tmpPath, path);
  const dirHandle = openSync(dirname(path), 'r');
  try {
    fsyncSync(dirHandle);
  } finally {
    closeSync(dirHandle);
  }
}

/**
 * The attempt log lives in a `publications/` SUBDIRECTORY beside the records,
 * never among them: `readRecords` in `scripts/eval-final-holdout.mjs` parses
 * every `.json` it finds beside the records as a hold-out record, and a
 * `.jsonl` log dropped there would either be skipped silently (wrong
 * extension, easy to get wrong) or refuse the whole run (right extension,
 * wrong shape) — the same placement hazard `readControlBaseline` already
 * documents for the control baseline.
 * see final-evaluation-publication.test.mjs › "attemptLogPath places the attempt log in a publications/ subdirectory beside the record, named after its basename without .json"
 */
export function attemptLogPath(recordPath) {
  const base = basename(recordPath).replace(/\.json$/, '');
  return join(dirname(recordPath), 'publications', `${base}.jsonl`);
}

/**
 * Append one attempt as a single JSON line, fsync'd before the call returns —
 * so an outcome that has been reported to the caller has also been made
 * durable, and a crash right after cannot lose it while the next arm's
 * attempt is still in flight.
 * see final-evaluation-publication.test.mjs › "appendPublicationAttempt appends one JSON line per call, and readPublicationAttempts reads them back in order"
 */
export async function appendPublicationAttempt(logPath, attempt) {
  mkdirSync(dirname(logPath), { recursive: true });
  const line = `${JSON.stringify(attempt)}\n`;
  const fileHandle = openSync(logPath, 'a');
  try {
    writeSync(fileHandle, line);
    fsyncSync(fileHandle);
  } finally {
    closeSync(fileHandle);
  }
}

/**
 * Read every attempt logged so far, in order. A genuinely absent log is no
 * attempts — the fail-open case `readRecords` already documents for a fresh
 * checkout — but a line that will not parse is a refusal: a log in a state
 * nobody understands must not be read as "this arm has never been attempted".
 * see final-evaluation-publication.test.mjs › "readPublicationAttempts reads a genuinely absent log as no attempts"
 * see final-evaluation-publication.test.mjs › "readPublicationAttempts refuses an unparseable line rather than treating the log as absent"
 */
export async function readPublicationAttempts(logPath) {
  let raw;
  try {
    raw = readFileSync(logPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const lines = raw.split('\n').filter((line) => line.length > 0);
  return lines.map((line) => {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`unparseable publication attempt line in ${logPath}: ${error.message}`);
    }
    return evals.parsePublicationAttempt(parsed);
  });
}

/** `sha256:<hex>` of the record's bytes AS THEY SIT ON DISK right now. */
export async function measurementDigest(path) {
  const raw = readFileSync(path);
  return `sha256:${createHash('sha256').update(raw).digest('hex')}`;
}

/** Caps an error's message the same way `capRefusalMessage` in the live-model lane does. */
function capReason(error) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 400 ? `${raw.slice(0, 400)}…` : raw;
}

/**
 * Publish every arm `record.publicationPlan` requires and has not yet
 * verified, appending one attempt per arm to the log beside the record —
 * fsync'd before the next arm starts, so a crash mid-loop leaves every
 * already-decided arm durably decided.
 *
 * The record is read FROM DISK, never from an in-memory copy the caller might
 * be holding: this is the one property that makes T12's ordering check mean
 * anything, and it is what lets `publishOnly` call this function with nothing
 * but a path.
 *
 * An arm whose last attempt was `readback-failed` is retried by VERIFYING the
 * same reference again — no new `persist` call, because the dataset that
 * attempt already created still exists. Every other retryable arm gets a
 * fresh `persist` call under a dataset name suffixed by the arm's own attempt
 * count, so a retry never collides with a half-created dataset from a prior
 * attempt.
 * see final-evaluation-publication.test.mjs › "T6: two failed publishOnly attempts followed by a successful one leave the attempt log holding all three, in order"
 * see final-evaluation-publication.test.mjs › "T10: persist succeeds but verify rejects — the arm logs readback-failed with its reference kept, distinct from ingestion-failed, and the next publishOnly verifies the same reference with no new persist call"
 * see final-evaluation-publication.test.mjs › "publishOnly persists each required arm under a dataset name built from the record’s own head SHA and attempt number, and a retry after ingestion-failed bumps the suffix"
 */
export async function publishRecordedMeasurement({ recordPath, mode, persist, verify, now, newAttemptId }) {
  const raw = readFileSync(recordPath);
  const measurementSha256 = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
  const record = JSON.parse(raw.toString('utf8'));

  if (record.status !== 'complete') {
    throw new Error(
      `refusing to publish a record whose status is not complete: ${record.status}`,
    );
  }
  if (typeof record.measurementId !== 'string' || record.measurementId.length === 0) {
    throw new Error('the record must carry its own measurementId to be published');
  }
  if (typeof record.publicationPlan !== 'object' || record.publicationPlan === null) {
    throw new Error('the record must carry its own publicationPlan to be published');
  }
  if (typeof record.experiments !== 'object' || record.experiments === null) {
    throw new Error('the record must carry its own experiments to be published');
  }
  if (typeof record.candidate?.headSha !== 'string' || record.candidate.headSha.length === 0) {
    throw new Error('the record must carry its own candidate.headSha to be published');
  }

  const plan = record.publicationPlan;
  const logPath = attemptLogPath(recordPath);
  const priorAttempts = await readPublicationAttempts(logPath);
  const initialSummary = evals.summarizeHoldoutPublication({
    plan,
    attempts: priorAttempts,
    measurementSha256,
  });

  // record.candidate.headSha is required above, so no fallback is needed here.
  const headSha12 = record.candidate.headSha.slice(0, 12);
  const candidateFingerprint = record.candidate?.fingerprint;

  const newAttempts = [];
  for (const arm of evals.FINAL_EVALUATION_PUBLISHABLE_ARMS) {
    const planEntry = plan[arm];
    if (planEntry === undefined || planEntry.required !== true) continue;
    if (initialSummary.arms[arm].state === 'verified') continue;

    const armPriorAttempts = priorAttempts.filter((attempt) => attempt.arm === arm);
    const lastAttempt = armPriorAttempts[armPriorAttempts.length - 1];
    const attemptId = newAttemptId();
    const attemptedAt = now();
    const shared = {
      schemaVersion: evals.FINAL_EVALUATION_PUBLICATION_VERSION,
      measurementId: record.measurementId,
      candidateFingerprint,
      measurementSha256,
      attemptId,
      attemptedAt,
      mode,
      arm,
    };

    if (lastAttempt !== undefined && lastAttempt.outcome === 'readback-failed') {
      // Retry by VERIFYING the reference a prior attempt already created —
      // no persist call, because that dataset already exists.
      let attempt;
      try {
        await verify({ reference: lastAttempt.reference });
        attempt = {
          ...shared,
          outcome: 'verified',
          datasetName: lastAttempt.datasetName,
          reference: lastAttempt.reference,
        };
      } catch (error) {
        attempt = {
          ...shared,
          outcome: 'readback-failed',
          datasetName: lastAttempt.datasetName,
          reference: lastAttempt.reference,
          reason: capReason(error),
        };
      }
      await appendPublicationAttempt(logPath, attempt);
      newAttempts.push(attempt);
      continue;
    }

    const attemptNumber = armPriorAttempts.length + 1;
    const datasetName = `aic-19-final-holdout-${arm}-${headSha12}-a${attemptNumber}`;
    let reference;
    try {
      reference = await persist({ datasetName, experiment: record.experiments[arm] });
    } catch (error) {
      const attempt = { ...shared, outcome: 'ingestion-failed', datasetName, reason: capReason(error) };
      await appendPublicationAttempt(logPath, attempt);
      newAttempts.push(attempt);
      continue;
    }

    let attempt;
    try {
      await verify({ reference });
      attempt = { ...shared, outcome: 'verified', datasetName, reference };
    } catch (error) {
      attempt = { ...shared, outcome: 'readback-failed', datasetName, reference, reason: capReason(error) };
    }
    await appendPublicationAttempt(logPath, attempt);
    newAttempts.push(attempt);
  }

  return evals.summarizeHoldoutPublication({
    plan,
    attempts: [...priorAttempts, ...newAttempts],
    measurementSha256,
  });
}
