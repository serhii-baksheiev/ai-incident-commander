import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createScanner, LanguageVariant, SyntaxKind } from 'typescript/unstable/ast';

const projectRoot = process.cwd();
const packagesRoot = resolve(projectRoot, 'packages');
const domainRoot = resolve(packagesRoot, 'domain');
const sourceExtension = /\.[cm]?[jt]sx?$/;

function isWithin(parent, path) {
  const pathFromParent = relative(parent, path);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function sourceFilesIn(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFilesIn(path));
    if (entry.isFile() && sourceExtension.test(entry.name)) files.push(path);
  }
  return files;
}

function moduleSpecifiersIn(path) {
  const scanner = createScanner(true, LanguageVariant.Standard, readFileSync(path, 'utf8'));
  const tokens = [];
  let kind;
  do {
    kind = scanner.scan();
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  } while (kind !== SyntaxKind.EndOfFile);

  const specifiers = [];
  for (const [index, token] of tokens.entries()) {
    if (token.kind === SyntaxKind.ImportKeyword) {
      for (const candidate of tokens.slice(index + 1)) {
        if (candidate.kind === SyntaxKind.StringLiteral) {
          specifiers.push(candidate.value);
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
      for (const candidate of tokens.slice(index + 1)) {
        if (candidate.kind === SyntaxKind.FromKeyword) hasFrom = true;
        if (hasFrom && candidate.kind === SyntaxKind.StringLiteral) {
          specifiers.push(candidate.value);
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
    if (token.kind === SyntaxKind.Identifier && token.text === 'require') {
      const [openParen, moduleName] = tokens.slice(index + 1, index + 3);
      if (
        openParen?.kind === SyntaxKind.OpenParenToken &&
        moduleName?.kind === SyntaxKind.StringLiteral
      ) {
        specifiers.push(moduleName.value);
      }
    }
  }
  return specifiers;
}

function forbiddenReason(importer, specifier) {
  if (/^(?:langchain(?:\/|$)|@langchain\/)/.test(specifier)) {
    return 'domain must not import LangChain or LangGraph';
  }
  if (specifier.startsWith('@aic/')) {
    return 'domain must not depend on another product package';
  }
  if (specifier.startsWith('.')) {
    const target = resolve(dirname(importer), specifier);
    if (isWithin(packagesRoot, target) && !isWithin(domainRoot, target)) {
      return 'domain must not depend on another product package';
    }
  }
  return null;
}

const violations = [];
for (const importer of sourceFilesIn(domainRoot)) {
  for (const specifier of moduleSpecifiersIn(importer)) {
    const reason = forbiddenReason(importer, specifier);
    if (reason) violations.push(`${relative(projectRoot, importer)} imports ${specifier}: ${reason}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Architecture boundary violations:\n${violations.map((line) => `- ${line}`).join('\n')}\n`);
  process.exitCode = 1;
}
