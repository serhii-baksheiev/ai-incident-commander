/**
 * The elevated spacing ration, and the one path every task crosses by procedure.
 *
 * 🔴 **Why this file exists.** `selectNext` rations the elevated tier by
 * spacing: never two elevated items back to back. The tier is computed from the
 * change a close actually made — `recordCompletedTier` — and every task this
 * repository closes writes `.rig/claims/<ticket>.json`, because the `loop`
 * skill requires that record and `CLAUDE.md` declares the whole of `.rig/`
 * elevated. So the elevated path was not a property of the WORK. It was present
 * on every task that followed the documented procedure, and the ration fired on
 * all of them equally — which is the same as not firing at all, because a
 * signal that is always on distinguishes nothing.
 *
 * Measured before the change, on this repository's own declaration: an ordinary
 * task touching `packages/domain/src/x.ts`, `test/x.test.mjs` and its own
 * `.rig/claims/AIC-70.json` recorded `elevated-mechanism`.
 *
 * The owner's ruling (AIC-70): a task's own canonical claim record does not
 * count as an elevated mechanism change **for spacing**. Everything else under
 * `.rig/`, `.claude/` and `.github/workflows/` still does.
 *
 * 🔴 **The exclusion is for the RATION only, and this file pins that too.** The
 * gate's question — "what did this change cross" — is answered by
 * `elevatedPaths` in the same return value, and it keeps naming the claim
 * record. A close that stopped listing it would look clean to the sweep that
 * exists to catch exactly the merges that touch elevated paths, so the two
 * answers deliberately differ and both are asserted below.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { recordCompletedTier } from '../.claude/scripts/queue/state.mjs';

/**
 * A project root carrying this repository's own elevated-paths declaration.
 *
 * The declaration is read from the tree rather than restated here: a second
 * copy of the elevated list is a copy that goes stale, and the whole point of
 * the tier computation is that it calls the sweep's own reader.
 */
const projectWithDeclaration = () => {
  const root = mkdtempSync(join(tmpdir(), 'aic-70-'));
  const declaration = [
    '```elevated-paths',
    '.claude/',
    '.rig/',
    '.github/workflows/',
    'AGENTS.md',
    '```',
    '',
  ].join('\n');
  writeFileSync(join(root, 'CLAUDE.md'), `# fixture\n\n${declaration}`);
  mkdirSync(join(root, '.claude'), { recursive: true });
  return root;
};

const close = (changedFiles, ticket) => {
  const root = projectWithDeclaration();
  const statePath = join(root, '.claude', 'queue.state.json');
  const result = recordCompletedTier({ changedFiles, projectRoot: root, statePath, ticket });
  return { ...result, written: JSON.parse(readFileSync(statePath, 'utf8')) };
};

const ORDINARY_WORK = ['packages/domain/src/x.ts', 'test/x.test.mjs'];

test('does not space the next item when the only elevated path is the task\'s own claim record', () => {
  const { tier, written } = close([...ORDINARY_WORK, '.rig/claims/AIC-70.json'], 'AIC-70');

  assert.equal(
    tier,
    'normal',
    'a task whose only elevated path is the claim record its own procedure requires must not ration the next item: every task has one, so spacing on it spaces everything and distinguishes nothing.',
  );
  assert.equal(written.lastCompletedTier, 'normal', 'the ration reads the file, not the return value');
});

test('still names the claim record in elevatedPaths, because the gate asks a different question', () => {
  const { elevatedPaths } = close([...ORDINARY_WORK, '.rig/claims/AIC-70.json'], 'AIC-70');

  assert.deepEqual(
    elevatedPaths,
    ['.rig/claims/AIC-70.json'],
    'the exclusion is for the ration only. `elevatedPaths` answers what the change crossed, which is the gate sweep\'s question — a close that stopped listing it would look clean to the check that exists to catch merges across elevated paths.',
  );
});

test('spaces the next item when the change also touches a real mechanism', () => {
  for (const mechanism of ['.claude/hooks/guard-bash.mjs', '.github/workflows/ci.yml', '.rig/revalidation.json']) {
    const { tier } = close([...ORDINARY_WORK, '.rig/claims/AIC-70.json', mechanism], 'AIC-70');
    assert.equal(
      tier,
      'elevated-mechanism',
      `${mechanism} is a genuine mechanism change and must still space the next item, whatever else the diff carries`,
    );
  }
});

test('spaces the next item for a claim record that is not this task\'s', () => {
  const { tier } = close([...ORDINARY_WORK, '.rig/claims/AIC-69.json'], 'AIC-70');

  assert.equal(
    tier,
    'elevated-mechanism',
    'only the CURRENT task\'s canonical record is excluded. Editing another task\'s claim record is editing a record that decides someone else\'s revalidation, and nothing about this task\'s procedure requires it.',
  );
});

test('spaces the next item when no ticket is given, rather than guessing', () => {
  const { tier } = close([...ORDINARY_WORK, '.rig/claims/AIC-70.json']);

  assert.equal(
    tier,
    'elevated-mechanism',
    'without a ticket there is no canonical record to exclude. Guessing one from the diff would let any change opt out of the ration by adding a file that looks like a claim record.',
  );
});

test('excludes the canonical record only, never a path that merely looks like it', () => {
  for (const lookalike of [
    '.rig/claims/AIC-70.json.bak',
    '.rig/claims/sub/AIC-70.json',
    '.rig/claims/AIC-700.json',
  ]) {
    const { tier } = close([...ORDINARY_WORK, lookalike], 'AIC-70');
    assert.equal(
      tier,
      'elevated-mechanism',
      `${lookalike} is a different file from the canonical record and must still space the next item. A containment test instead of an equality test would drop all three, which turns "exclude only the canonical record" into "exclude anything named like it".`,
    );
  }
});

test('accepts the id shapes every adapter in this rulebook emits', () => {
  // jira gives `AIC-70`; github-issues gives String(issue.number); plan-md gives
  // String(n) and is the resolver's default. An id class that fits only one of
  // them makes the documented close command throw in the other two rigs.
  for (const ticket of ['AIC-70', '42', '3', 'a1', 'AR-1234']) {
    const { tier, ticketIgnored } = close([...ORDINARY_WORK, `.rig/claims/${ticket}.json`], ticket);
    assert.equal(tier, 'normal', `${ticket} is a legitimate item id and its own claim record must not ration`);
    assert.equal(ticketIgnored, undefined, `${ticket} must not be reported as unrecognised`);
  }
});

test('records a conservative tier for an id it cannot recognise, and never leaves the ration unwritten', () => {
  // 🔴 The first version of this threw here, from inside the filter callback —
  // so the refusal was silent when nothing was elevated and, when something was,
  // aborted BEFORE the state file was written. `clearsSpacing` reads a missing
  // value as "go ahead", so the guard failed open on exactly the elevated closes
  // it exists to ration. Refusing by discarding the tier is more permissive than
  // not refusing at all.
  // The object is not decoration: without the `typeof ticket === 'string'` guard
  // it passes the regex through coercion and could be re-read differently when
  // the path is built. Nothing exploitable follows from that here — the string
  // always begins `.rig/claims/` and is only compared — but an untested guard is
  // a guess, and this is the case that holds it.
  for (const bad of ['../../etc', '.rig/claims/x', 'AIC 70', '', 'a/b', { toString: () => 'AIC-70' }]) {
    const { tier, written, ticketIgnored } = close(
      [...ORDINARY_WORK, '.claude/hooks/guard-bash.mjs', '.rig/claims/AIC-70.json'],
      bad,
    );
    assert.equal(tier, 'elevated-mechanism', `an unrecognised id must not weaken the tier (${JSON.stringify(bad)})`);
    assert.equal(written.lastCompletedTier, 'elevated-mechanism', 'the state file is always written');
    assert.equal(ticketIgnored, bad, 'and the unrecognised id is reported rather than swallowed');
  }
});

test('applies no exclusion for an unrecognised id even when nothing else is elevated', () => {
  // The dangerous half of the old defect: with nothing else elevated, the bad id
  // was never even looked at, so it was accepted in silence. Now it is reported,
  // and the record it failed to exclude still counts.
  const { tier, written, ticketIgnored } = close([...ORDINARY_WORK, '.rig/claims/AIC-70.json'], 'AIC..70');

  assert.equal(
    tier,
    'elevated-mechanism',
    'an id carrying a path character cannot name a claim record, so nothing is excluded and the tier is what it was before AIC-70',
  );
  assert.equal(written.lastCompletedTier, 'elevated-mechanism');
  assert.equal(ticketIgnored, 'AIC..70', 'and it is named in the result rather than swallowed');
});
