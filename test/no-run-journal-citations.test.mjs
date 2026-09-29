/**
 * `.claude/runs/` is the per-checkout run journal and is gitignored
 * (`.gitignore`), so a committed file that cites a path inside it sends every
 * other reader to a file they do not have. No file under apps/, packages/,
 * scripts/, infra/ or test/ names that directory; the rationale a citation
 * would have carried belongs in the committed file itself, a Jira ticket or a
 * decision record.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { childEnv } from './fixtures/child-env.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const JOURNAL_DIRECTORY = ['.claude', 'runs'].join('/') + '/';

test('no committed file under apps, packages, scripts, infra or test cites the gitignored run journal', () => {
  const tracked = execFileSync('git', ['ls-files', '--', 'apps', 'packages', 'scripts', 'infra', 'test'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: childEnv(),
  })
    .split('\n')
    .filter((path) => path !== '' && !path.includes('/dist/'));
  assert.ok(tracked.length > 100, 'fixture sanity: the walk must reach the repository');
  const citing = tracked.filter((path) => readFileSync(resolve(projectRoot, path), 'utf8').includes(JOURNAL_DIRECTORY));
  assert.deepEqual(citing, []);
});
