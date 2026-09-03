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

test('refuses a ticket it cannot recognise instead of excluding something else', () => {
  assert.throws(
    () => close([...ORDINARY_WORK, '.rig/claims/AIC-70.json'], '../../etc'),
    /ticket/i,
    'a ticket id is a key, and one that is not a ticket id must be refused loudly. Silently building a path from it is how an exclusion widens to a file nobody meant to exclude.',
  );
});
