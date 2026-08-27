import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';

const projectRoot = process.cwd();
const packagesRoot = resolve(projectRoot, 'packages');
const domainRoot = resolve(packagesRoot, 'domain');
const sourceExtension = /\.[cm]?[jt]sx?$/;
const forbiddenProductRoots = [
  resolve(packagesRoot, 'graph'),
  resolve(packagesRoot, 'tools'),
  resolve(packagesRoot, 'evals'),
];
const forbiddenProductPackages = ['@aic/graph', '@aic/tools', '@aic/evals'];

function isWithin(parent, path) {
  const pathFromParent = relative(parent, path);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function sourceTreeIn(directory) {
  const files = [];
  const symlinks = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      symlinks.push(path);
      continue;
    }
    if (entry.isDirectory()) {
      const nested = sourceTreeIn(path);
      files.push(...nested.files);
      symlinks.push(...nested.symlinks);
    }
    if (entry.isFile() && sourceExtension.test(entry.name)) files.push(path);
  }
  return { files, symlinks };
}

function moduleLoadsIn(path) {
  const scanner = createScanner(true, LanguageVariant.Standard, readFileSync(path, 'utf8'));
  const tokens = [];
  let kind;
  do {
    kind = scanner.scan();
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value: scanner.getTokenValue(),
    });
  } while (kind !== SyntaxKind.EndOfFile);

  const loads = [];
  const literalKinds = new Set([
    SyntaxKind.StringLiteral,
    SyntaxKind.NoSubstitutionTemplateLiteral,
  ]);
  const addCallArgument = (argument, syntax) => {
    if (literalKinds.has(argument?.kind)) {
      loads.push({ specifier: argument.value });
    } else {
      loads.push({ problem: `domain uses ${syntax} with a nonliteral module specifier` });
    }
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === SyntaxKind.ImportKeyword) {
      const next = tokens[index + 1];
      if (next?.kind === SyntaxKind.DotToken) continue;
      if (next?.kind === SyntaxKind.OpenParenToken) {
        addCallArgument(tokens[index + 2], 'dynamic import');
        continue;
      }
      if (literalKinds.has(next?.kind)) {
        loads.push({ specifier: next.value });
        continue;
      }
      let hasFrom = false;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.kind === SyntaxKind.FromKeyword) hasFrom = true;
        if (hasFrom && literalKinds.has(candidate.kind)) {
          loads.push({ specifier: candidate.value });
          break;
        }
        if (
          candidate.kind === SyntaxKind.SemicolonToken ||
          candidate.kind === SyntaxKind.EndOfFile
        ) {
          break;
        }
      }
    }
    if (token.kind === SyntaxKind.ExportKeyword) {
      let hasFrom = false;
      for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
        const candidate = tokens[cursor];
        if (candidate.kind === SyntaxKind.FromKeyword) hasFrom = true;
        if (hasFrom && literalKinds.has(candidate.kind)) {
          loads.push({ specifier: candidate.value });
          break;
        }
        if (
          candidate.kind === SyntaxKind.SemicolonToken ||
          candidate.kind === SyntaxKind.EndOfFile
        ) {
          break;
        }
      }
    }
    if (
      (token.kind === SyntaxKind.Identifier || token.kind === SyntaxKind.RequireKeyword) &&
      token.text === 'require'
    ) {
      const next = tokens[index + 1];
      if (next?.kind === SyntaxKind.OpenParenToken) {
        addCallArgument(tokens[index + 2], 'require()');
      } else if (
        next?.kind === SyntaxKind.DotToken &&
        tokens[index + 2]?.kind === SyntaxKind.Identifier &&
        tokens[index + 2]?.text === 'resolve' &&
        tokens[index + 3]?.kind === SyntaxKind.OpenParenToken
      ) {
        addCallArgument(tokens[index + 4], 'require.resolve()');
      }
    }
  }
  return loads;
}

function forbiddenReason(importer, specifier) {
  if (/^(?:langchain(?:\/|$)|@langchain\/)/.test(specifier)) {
    return 'domain must not import LangChain or LangGraph';
  }
  if (
    forbiddenProductPackages.some(
      (packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`),
    )
  ) {
    return 'domain must not depend on graph, tools, or evals';
  }
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(importer), specifier);
    if (forbiddenProductRoots.some((packageRoot) => isWithin(packageRoot, target))) {
      return 'domain must not depend on graph, tools, or evals';
    }
  }
  return null;
}

const violations = [];
const sourceTree = sourceTreeIn(domainRoot);
for (const symlink of sourceTree.symlinks) {
  violations.push(`${relative(projectRoot, symlink)} is a symlink: domain sources must be physical files`);
}
for (const importer of sourceTree.files) {
  for (const load of moduleLoadsIn(importer)) {
    if (load.problem) {
      violations.push(`${relative(projectRoot, importer)}: ${load.problem}`);
      continue;
    }
    const reason = forbiddenReason(importer, load.specifier);
    if (reason) {
      violations.push(
        `${relative(projectRoot, importer)} imports ${load.specifier}: ${reason}`,
      );
    }
  }
}

const domainManifestPath = resolve(domainRoot, 'package.json');
let domainManifest;
try {
  domainManifest = JSON.parse(readFileSync(domainManifestPath, 'utf8'));
} catch (error) {
  violations.push(`packages/domain/package.json is unreadable: ${error.message}`);
}
for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
  for (const dependency of Object.keys(domainManifest?.[section] ?? {})) {
    const reason = forbiddenReason(domainManifestPath, dependency);
    if (reason) violations.push(`packages/domain/package.json ${section} includes ${dependency}: ${reason}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Architecture boundary violations:\n${violations.map((line) => `- ${line}`).join('\n')}\n`);
  process.exitCode = 1;
}
