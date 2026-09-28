#!/usr/bin/env node
/**
 * Regenerates the blind-review packet byte-for-byte, for AIC-123 slice 3a
 * (owner D3 ruling): the prose two independent readers saw when the facts in
 * `packages/evals/src/observation-annotations.ts` were annotated. The packet
 * carries the fixed reviewer brief header, verbatim, followed by every
 * distinct statement the ok corpus (`@aic/evals`'s `REPLAY_SCENARIOS`) serves,
 * numbered and ordered by the ascending hex sha256 of the statement text —
 * never by evidence id, scenario id or corpus order, none of which the reader
 * may see.
 *
 * `node --import ./test/fixtures/no-ambient-tracing.mjs scripts/observation-review-packet.mjs`
 * prints the packet to stdout. `buildObservationReviewPacket()` is the same
 * computation as a function, and `test/observation-annotations.test.mjs` pins
 * its output to the packet digest the committed
 * `docs/evidence/observation-annotations/review-v1.json` records for the
 * readers' review.
 */
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { argv, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

import * as evals from '@aic/evals';

const REVIEWER_BRIEF_HEADER = [
  'You are an independent annotator. Do NOT use any tools, do not read any files, do not search: answer only from the text below.',
  '',
  'Below are 18 short sentences. Each is one observation written by an engineer during an incident. For each sentence, record the typed facts the sentence ITSELF states — nothing inferred from other sentences, from what the incident "probably" was, or from world knowledge about what usually causes what.',
  '',
  '## The fact vocabulary (closed; nothing outside it)',
  '',
  'Every fact has a `subject` and a `window`.',
  '- `subject`: the service or component the sentence names, spelled exactly as it appears in the sentence. A versioned release name of the form `<name>-v<N>` names the service `<name>`. If the sentence names no service or component for the observation, record no fact.',
  '- `window`: one of `pre-onset` (before the incident began, e.g. before the first alert or before the symptoms began), `incident` (during the incident window), `recovery` (during the recovery window). If the sentence does not place the observation in one of these windows, record no fact.',
  '',
  'Forms:',
  '1. `deployment-in-window`: {form, subject, window, count, coverage} — deployments/releases of the subject that happened in the window. `count` = the number stated (one deployment mentioned = 1). `coverage` = `complete` only if the sentence claims an exhaustive check (e.g. "no deployments were recorded"), otherwise `partial`.',
  '2. `log-class-in-window`: {form, subject, window, logClass, count, coverage} — log events of class `error`, `timeout` or `activity` for the subject in the window. count/coverage as above.',
  '3. `signal-state`: {form, subject, window, signal, state} — `signal` one of `error-rate`, `latency`, `connection-pool`, `worker-saturation`, `dependency-health`; `state` one of `normal`, `elevated`, `at-limit`.',
  '',
  'A sentence may yield zero, one or several facts. When in doubt, record no fact: a missing fact is safe, a wrong fact is not.',
  '',
  '## Output',
  '',
  'Return ONLY one JSON object: {"1": [facts...], "2": [...], ... "18": [...]} with an array (possibly empty) for every sentence number, and after it one line per sentence with empty facts giving the reason in a few words.',
  '',
  '## Sentences',
].join('\n');

/**
 * Every distinct statement the ok corpus serves, ordered by ascending hex
 * sha256 of the statement text — the ordering rule that keeps this packet
 * reproducible without depending on fixture insertion order.
 */
function distinctOkStatementsBySha256() {
  const statementById = new Map();
  for (const scenario of evals.REPLAY_SCENARIOS) {
    for (const entry of scenario.fixture.entries) {
      if (entry.result.status !== 'ok') continue;
      for (const item of entry.result.output) {
        statementById.set(item.id, item.statement);
      }
    }
  }
  const statements = [...new Set(statementById.values())];
  const hex = (text) => createHash('sha256').update(text).digest('hex');
  statements.sort((a, b) => (hex(a) < hex(b) ? -1 : 1));
  return statements;
}

export function buildObservationReviewPacket() {
  const statements = distinctOkStatementsBySha256();
  const body = statements.map((statement, index) => `${index + 1}. ${statement}`).join('\n');
  return `${REVIEWER_BRIEF_HEADER}\n${body}\n`;
}

/**
 * Compared by realpath, the same guard `scripts/eval-oracle.mjs` uses: a
 * checkout reached through a symlink otherwise runs nothing and exits 0.
 */
const invokedDirectly = () => {
  if (!argv[1]) return false;
  const real = (path) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  return real(fileURLToPath(import.meta.url)) === real(argv[1]);
};

if (invokedDirectly()) {
  stdout.write(buildObservationReviewPacket());
}
