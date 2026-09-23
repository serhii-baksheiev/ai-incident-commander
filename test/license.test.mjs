import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const licensePath = resolve(projectRoot, 'LICENSE');
const rootManifestPath = resolve(projectRoot, 'package.json');
const readmePath = resolve(projectRoot, 'README.md');

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The canonical MIT text is wrapped differently by different sources, so the
// sentences are compared with every run of whitespace collapsed to one space.
const collapseWhitespace = (text) => text.replace(/\s+/g, ' ');

const canonicalMitSentences = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:',
  'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.',
  'IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.',
];

const readLicense = () => {
  assert.equal(existsSync(licensePath), true, 'LICENSE must exist at the repository root');
  return readFileSync(licensePath, 'utf8');
};

test('ships a LICENSE at the repository root that opens with the MIT License title', () => {
  const license = readLicense();
  assert.equal(license.split(/\r?\n/)[0], 'MIT License');
});

test('names Serhii Baksheiev as the 2026 copyright holder in the LICENSE', () => {
  const lines = readLicense().split(/\r?\n/).map((line) => line.trim());
  assert.ok(
    lines.includes('Copyright (c) 2026 Serhii Baksheiev'),
    'LICENSE must carry the line "Copyright (c) 2026 Serhii Baksheiev"',
  );
});

test('carries the canonical MIT grant, notice condition and warranty disclaimer verbatim', () => {
  const license = collapseWhitespace(readLicense());
  for (const sentence of canonicalMitSentences) {
    assert.ok(license.includes(sentence), `LICENSE is missing the canonical MIT sentence: ${sentence}`);
  }
});

test('declares the MIT license in the root package.json', () => {
  assert.equal(readJson(rootManifestPath).license, 'MIT');
});

test('keeps the workspace root private, so the license does not imply publishing to npm', () => {
  assert.equal(readJson(rootManifestPath).private, true);
});

test('no workspace package declares a license other than MIT', () => {
  const { workspaces } = readJson(rootManifestPath);
  assert.ok(Array.isArray(workspaces) && workspaces.length > 0, 'the root must list its workspaces');

  for (const workspace of workspaces) {
    const manifest = readJson(resolve(projectRoot, workspace, 'package.json'));
    if (Object.hasOwn(manifest, 'license')) {
      assert.equal(manifest.license, 'MIT', `${workspace}/package.json declares a non-MIT license`);
    }
  }
});

test('the README has a License section that names MIT and links the LICENSE file', () => {
  const readme = readFileSync(readmePath, 'utf8');
  const section = readme.match(/^## License[ \t]*\r?\n([\s\S]*?)(?=^## |(?![\s\S]))/m);
  assert.ok(section, 'README.md must have a "## License" section');

  const body = section[1];
  assert.match(body, /\bMIT\b/, 'the License section must name MIT');
  assert.match(body, /\]\((?:\.\/)?LICENSE\)/, 'the License section must link the LICENSE file');
});
