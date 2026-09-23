import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test from 'node:test';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const adrPath = join(projectRoot, 'docs', 'decisions', 'durable-run-execution.md');
const readAdr = () => readFileSync(adrPath, 'utf8');

/** The text under one `## ` heading, up to the next `## ` heading. */
const section = (markdown, heading) => {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `the record must carry a "## ${heading}" section`);
  const rest = markdown.slice(start + heading.length + 5);
  const end = rest.search(/\n## /);
  return end === -1 ? rest : rest.slice(0, end);
};

/**
 * AIC-56 builds against ADR-DURABLE-RUN-EXECUTION and AIC-57 decides its
 * status, but the record did not exist in the repository: the owner ruling of
 * 2026-09-23 stood in for it. These rows pin that the record is now a file, and
 * that each decision the two tickets are built against is recorded in it rather
 * than paraphrased from memory.
 */
test('is Proposed until AIC-57 decides it, and names the tickets built against it', () => {
  const adr = readAdr();
  assert.match(adr, /^\s*-\s+\*\*Status:\*\*\s+Proposed\b/m, 'the record must be Proposed, not Accepted, before AIC-57 runs');
  assert.match(adr, /Accepted[^.]*AIC-57/, 'the record must say AIC-57 is what can move it to Accepted');
  for (const ticket of ['AIC-56', 'AIC-57', 'AIC-58', 'AIC-42']) {
    assert.match(adr, new RegExp(`\\b${ticket}\\b`), `the record must name ${ticket}`);
  }
});

test('records every decision of the owner ruling, each under the Decisions section', () => {
  const decisions = section(readAdr(), 'Decisions');
  for (const [decision, pattern] of [
    ['PostgreSQL is the single coordination substrate', /PostgreSQL is the single coordination substrate/],
    ['no second coordinator without measured need', /Redis[\s\S]*?SQS[\s\S]*?Kafka[\s\S]*?measured need/],
    ['runs are durable records, worker identity is not run identity', /Worker or process identity is not\s+run identity/],
    ['ownership is lease-based and fenced, a lease alone is not enough', /lease-based and fenced[\s\S]*?a lease alone is not sufficient/],
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
