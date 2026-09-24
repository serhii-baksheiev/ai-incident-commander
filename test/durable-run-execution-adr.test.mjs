import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

import * as domain from '@aic/domain';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const adrPath = join(projectRoot, 'docs', 'decisions', 'durable-run-execution.md');
const readAdr = () => readFileSync(adrPath, 'utf8');

/**
 * The text under one `## ` heading, up to the next `## ` heading, with every
 * run of whitespace collapsed to one space so a pattern does not depend on
 * where the markdown happens to wrap.
 */
const section = (markdown, heading) => {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the record must carry a "## ${heading}" section`);
  const rest = markdown.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return (end === -1 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ');
};

/**
 * AIC-56 builds against ADR-DURABLE-RUN-EXECUTION and AIC-57 decides its
 * status, but the record did not exist in the repository: the owner ruling of
 * 2026-09-23 stood in for it. These rows pin that the record is now a file, and
 * that each decision the two tickets are built against is recorded in it rather
 * than paraphrased from memory.
 */
test('is Accepted on AIC-57\'s T-4 verdict, and names the tickets built against it', () => {
  const adr = readAdr();
  assert.match(adr, /^\s*-\s+\*\*Status:\*\*\s+Accepted\b/m, 'the record must be Accepted once AIC-57\'s race matrix has passed');
  assert.match(adr, /Accepted[^.]*AIC-57/, 'the record must say AIC-57 is what moved it to Accepted');
  for (const ticket of ['AIC-56', 'AIC-57', 'AIC-58', 'AIC-42']) {
    assert.match(adr, new RegExp(`\\b${ticket}\\b`), `the record must name ${ticket}`);
  }
});

/**
 * AIC-57 records its verdict in this record, in its own "T-4 verdict
 * (AIC-57)" section, as the Consequences section asks. The row pins the
 * parts a reader needs to re-run it and to know what it does not cover: the
 * stress command, the orderings, both measured series the harness prints, and
 * the one exclusion the matrix does not itself pin — the pre-write fence,
 * which another live file does.
 */
test('records the T-4 verdict: how to re-run it, what it measured, and what the matrix does not cover', () => {
  const verdict = section(readAdr(), 'T-4 verdict (AIC-57)');
  for (const [part, pattern] of [
    ['the stress repetition count', /T4_REPETITIONS=2000/],
    ['all six orderings', /S1[\s\S]*?S6/],
    ['the fence-to-write window series', /t4-window-ms/],
    ['the sweep-attempts series', /t4-sweep-attempts/],
    ['the harness file', /infra\/postgres\/tests\/t4-race\.live\.mjs/],
    [
      'the pre-write fence is pinned outside the matrix',
      /fenced-checkpointer\.live\.mjs`? › "a real zombie worker's checkpoint write is refused by a real RunWriteContext after a takeover/,
    ],
  ]) {
    assert.match(verdict, pattern, `the T-4 verdict must record: ${part}`);
  }
});

test('records every decision of the owner ruling, each under the Decisions section', () => {
  const decisions = section(readAdr(), 'Decisions');
  for (const [decision, pattern] of [
    ['PostgreSQL is the single coordination substrate', /PostgreSQL is the single coordination substrate/],
    ['no second coordinator without measured need', /Redis[\s\S]*?SQS[\s\S]*?Kafka[\s\S]*?measured need/],
    ['runs are durable records, worker identity is not run identity', /Worker or process identity is not\s+run identity/],
    ['ownership is lease-based and fenced, a lease alone is not enough', /lease-based and fenced[\s\S]*?a\s+lease alone is not sufficient/],
    ['a stale worker must not commit after losing fencing authority', /stale worker[\s\S]*?must\s+not commit run-scoped product state/],
    ['waiting for a human holds no lease', /`waiting_human` holds no lease/],
    ['exactly-once external execution is not claimed', /Exactly-once external execution is not claimed/],
    ['exec_key is semantic and excludes the ownership attempt', /`exec_key`[\s\S]*?ownership attempt is never part of an `exec_key`/],
    ['committed node results are immutable and reused on replay', /Committed node results are immutable[\s\S]*?instead of calling the\s+provider or tool again/],
    ['replay is not re-observation', /Replay is not re-observation[\s\S]*?new Trial[\s\S]*?new `exec_key`/],
    ['checkpoints and node results solve different problems', /Checkpoints and node results solve different problems/],
    ['the fenced checkpointer is provisional and the run-scoped advisory lock is not restored', /provisionally[\s\S]*?run-scoped advisory lock[\s\S]*?not restored/],
    ['run events are downstream evidence, not an orchestrator', /`run_events`[\s\S]*?not an orchestrator/],
    ['AIC-57 T-4 is the gate and a divergence is an architecture failure', /AIC-57 is the empirical gate[\s\S]*?T-4[\s\S]*?architecture failure, not a flaky test/],
    ['the first fallback is a put-scoped lock', /put-scoped lock[\s\S]*?not the run-scoped advisory lock/],
    ['integrity events are observable, never silently repaired', /never silently repaired/],
    ['recovery is bounded and AIC-42 owns the operating policy', /Recovery is bounded[\s\S]*?AIC-42/],
  ]) {
    assert.match(decisions, pattern, `the Decisions section must record: ${decision}`);
  }
});

test('states what T-4 must show when a new worker resumes from an older checkpoint', () => {
  const decisions = section(readAdr(), 'Decisions');
  for (const [outcome, pattern] of [
    ['the committed exec_key is discovered', /committed `exec_key` is\s+discovered/],
    ['the provider or tool is not called again', /provider or tool is \*\*not\*\* called again/],
    ['the committed result is reused', /committed\s+result is reused/],
    ['product state converges', /product state converges/],
    ['the stale checkpoint fork is observable', /stale checkpoint fork is\s+observable/],
  ]) {
    assert.match(decisions, pattern, `T-4's required outcome must include: ${outcome}`);
  }
});

test('keeps production policy and deferred infrastructure out of scope', () => {
  const consequences = section(readAdr(), 'Consequences');
  for (const [item, pattern] of [
    ["AIC-41's production database and migration policy", /AIC-41/],
    ["AIC-42's full worker operating policy", /AIC-42/],
    ['Kubernetes, Helm or Terraform (AIC-54)', /Kubernetes, Helm or Terraform[^.]*AIC-54/],
    ['a production UI', /production UI/],
  ]) {
    assert.match(consequences, pattern, `the Consequences section must keep out of scope: ${item}`);
  }
});

/**
 * The run lifecycle has two spellings — the record's "Run lifecycle" table,
 * which a reader checks the design against, and the domain's
 * `assertRunTransition`, which the substrate enforces — so this row is the
 * correspondence check between them, red in either direction: a transition the
 * table lists that the domain refuses, and one the domain allows that the table
 * does not list (`.claude/rules/invariants.md`, "One mechanism, one
 * implementation").
 */
test('states the run lifecycle as a table that matches the domain transitions in both directions', () => {
  const adr = readAdr();
  const start = adr.indexOf('\n## Run lifecycle\n');
  assert.notEqual(start, -1, 'the record must carry a "## Run lifecycle" section');
  const body = adr.slice(start + 1).split(/\n## /)[0];
  const rows = body
    .split('\n')
    .filter((line) => /^\|\s*`/.test(line))
    .map((line) => line.split('|').map((cell) => cell.trim()));
  const documented = new Set(
    rows.map((cells) => `${cells[1].replaceAll('`', '')}->${cells[2].replaceAll('`', '')}`),
  );
  assert.ok(documented.size > 0, 'the Run lifecycle table must list transitions as `from` | `to` rows');

  const statuses = [...domain.RUN_STATUSES];
  for (const pair of documented) {
    const [from, to] = pair.split('->');
    assert.ok(statuses.includes(from) && statuses.includes(to), `${pair} names a status the domain does not have`);
    assert.doesNotThrow(() => domain.assertRunTransition(from, to), `the record lists ${pair}; the domain refuses it`);
  }
  for (const from of statuses) {
    for (const to of statuses) {
      let allowed = true;
      try {
        domain.assertRunTransition(from, to);
      } catch {
        allowed = false;
      }
      if (allowed) {
        assert.ok(documented.has(`${from}->${to}`), `the domain allows ${from}->${to}; the record does not list it`);
      }
    }
  }
});
