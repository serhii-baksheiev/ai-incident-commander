/**
 * AIC-146 sub-slice b2: two structural boundaries on where evidence gets
 * validated into existence.
 *
 * `packages/graph/src/evidence-ingestion.ts` is meant to be the one place
 * `EvidenceSchema.parse`/`.safeParse` is called inside `@aic/graph`'s own
 * source — both the canonical node (`nodes/execute-investigation.ts`) and the
 * durable runner (`index.ts`) call through it rather than parsing evidence
 * themselves, so the refusal-on-item-provenance rule and the
 * own-property provenance guard live in exactly one function
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 *
 * `projectToolResult` (`packages/tools/src/contracts.ts`) stays what it has
 * been since before AIC-146: exported, never imported by any production
 * module. Modelled on `test/run-events-table-boundary.test.mjs`'s
 * naming-boundary shape (a scan over source files, compared against a named
 * allow-list) rather than a dependency-graph tool, for the same reason that
 * file gives: a text scan over every `packages/<pkg>/src` and `apps/<pkg>/src`
 * directory is enough to decide an import edge, and needs nothing this suite
 * does not already have.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(here, '..');
const GRAPH_SRC = resolve(PROJECT_ROOT, 'packages/graph/src');

/** Every module allowed to even define `projectToolResult` or restate it under a re-export — never a caller. */
const PROJECT_TOOL_RESULT_DEFINITION = 'packages/tools/src/contracts.ts';
const PROJECT_TOOL_RESULT_REEXPORT = 'packages/tools/src/index.ts';

function walkTsFiles(root) {
  const out = [];
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, dirent.name);
    if (dirent.isDirectory()) {
      out.push(...walkTsFiles(full));
      continue;
    }
    if (dirent.isFile() && full.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Every `packages/<name>/src` and `apps/<name>/src` directory this repository has. */
function everySourceDir() {
  const dirs = [];
  for (const group of ['packages', 'apps']) {
    const groupPath = join(PROJECT_ROOT, group);
    for (const name of readdirSync(groupPath)) {
      const srcPath = join(groupPath, name, 'src');
      if (existsSync(srcPath) && statSync(srcPath).isDirectory()) {
        dirs.push(srcPath);
      }
    }
  }
  return dirs;
}

test('within packages/graph/src, EvidenceSchema.parse and EvidenceSchema.safeParse appear only in evidence-ingestion.ts', () => {
  const files = walkTsFiles(GRAPH_SRC);

  // Non-vacuity: the scan must actually be looking at graph's own source.
  assert.ok(
    files.some((file) => file.endsWith('nodes/execute-investigation.ts')),
    `packages/graph/src must contain nodes/execute-investigation.ts for this scan to mean anything; found: ${JSON.stringify(files.map((file) => relative(GRAPH_SRC, file)))}`,
  );

  const EVIDENCE_PARSE = /\bEvidenceSchema\.(?:parse|safeParse)\b/;
  const namingFiles = files
    .filter((file) => EVIDENCE_PARSE.test(readFileSync(file, 'utf8')))
    .map((file) => relative(GRAPH_SRC, file));

  assert.deepEqual(
    namingFiles.slice().sort(),
    ['evidence-ingestion.ts'],
    `only evidence-ingestion.ts may call EvidenceSchema.parse/safeParse inside packages/graph/src; the scan found ${JSON.stringify(namingFiles.sort())} calling it directly — every other ingestion site must go through evidence-ingestion.ts instead`,
  );
});

test('no module under packages/*/src or apps/*/src imports projectToolResult, other than its own definition file and the tools package re-export', () => {
  const sourceDirs = everySourceDir();

  // Non-vacuity: the walk must actually reach both declared roots.
  assert.ok(sourceDirs.some((dir) => dir.endsWith('packages/tools/src')), 'the scan must reach packages/tools/src');
  assert.ok(sourceDirs.some((dir) => dir.endsWith('apps/cli/src')), 'the scan must reach apps/cli/src');

  const IMPORTS_PROJECT_TOOL_RESULT = /\bimport\s+(?:type\s+)?\{[^}]*\bprojectToolResult\b[^}]*\}\s*from/;

  const importingFiles = sourceDirs
    .flatMap((dir) => walkTsFiles(dir))
    .map((file) => relative(PROJECT_ROOT, file))
    .filter((relativePath) => relativePath !== PROJECT_TOOL_RESULT_DEFINITION && relativePath !== PROJECT_TOOL_RESULT_REEXPORT)
    .filter((relativePath) =>
      IMPORTS_PROJECT_TOOL_RESULT.test(readFileSync(join(PROJECT_ROOT, relativePath), 'utf8')),
    );

  assert.deepEqual(
    importingFiles,
    [],
    `no production module may import projectToolResult; the scan found it imported by ${JSON.stringify(importingFiles)}`,
  );
});
