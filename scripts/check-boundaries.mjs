import { readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { parse } from '@babel/parser';

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
  const loads = [];
  let tree;
  try {
    tree = parse(readFileSync(path, 'utf8'), {
      sourceType: 'unambiguous',
      plugins: path.endsWith('x') ? ['typescript', 'jsx'] : ['typescript'],
      createParenthesizedExpressions: true,
    });
  } catch (error) {
    return [{ problem: `domain source cannot be parsed: ${error.message}` }];
  }

  const unwrap = (node) => {
    let current = node;
    while (
      current &&
      [
        'ParenthesizedExpression',
        'TSAsExpression',
        'TSTypeAssertion',
        'TSNonNullExpression',
        'TypeCastExpression',
      ].includes(current.type)
    ) {
      current = current.expression;
    }
    return current;
  };
  const literalValue = (node) => {
    const current = unwrap(node);
    if (current?.type === 'StringLiteral') return current.value;
    if (current?.type === 'TemplateLiteral' && current.expressions.length === 0) {
      return current.quasis[0]?.value.cooked ?? current.quasis[0]?.value.raw;
    }
    return null;
  };
  const addModuleSpecifier = (argument, syntax) => {
    const specifier = literalValue(argument);
    if (specifier !== null) {
      loads.push({ specifier });
    } else {
      loads.push({ problem: `domain uses ${syntax} with a nonliteral module specifier` });
    }
  };
  const memberName = (node) => {
    if (!node || !['MemberExpression', 'OptionalMemberExpression'].includes(node.type)) {
      return null;
    }
    if (node.computed) return literalValue(node.property);
    return node.property?.type === 'Identifier' ? node.property.name : null;
  };
  const containsReference = (node, names) => {
    const current = unwrap(node);
    if (!current) return false;
    if (current.type === 'Identifier') return names.has(current.name);
    if (current.type === 'SequenceExpression') {
      return current.expressions.some((expression) => containsReference(expression, names));
    }
    if (['MemberExpression', 'OptionalMemberExpression'].includes(current.type)) {
      return containsReference(current.object, names);
    }
    return false;
  };
  const moduleLoaderSyntax = (callee) => {
    const current = unwrap(callee);
    if (current?.type === 'Identifier' && current.name === 'require') return 'require()';
    if (
      ['MemberExpression', 'OptionalMemberExpression'].includes(current?.type) &&
      containsReference(current.object, new Set(['require'])) &&
      memberName(current) === 'resolve'
    ) {
      return 'require.resolve()';
    }
    return null;
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }

    if (
      ['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) &&
      node.source
    ) {
      addModuleSpecifier(node.source, node.type.startsWith('Export') ? 'export' : 'import');
    }
    if (node.type === 'ImportExpression') {
      addModuleSpecifier(node.source, 'dynamic import');
    }
    if (node.type === 'TSExternalModuleReference') {
      addModuleSpecifier(node.expression, 'import equals');
    }
    if (['CallExpression', 'OptionalCallExpression'].includes(node.type)) {
      const callee = unwrap(node.callee);
      if (callee?.type === 'Import') {
        addModuleSpecifier(node.arguments[0], 'dynamic import');
      } else if (containsReference(callee, new Set(['eval', 'Function']))) {
        loads.push({ problem: 'domain uses eval or Function as an interpreted module loader' });
      } else {
        const syntax = moduleLoaderSyntax(callee);
        if (syntax) {
          addModuleSpecifier(node.arguments[0], syntax);
        } else if (containsReference(callee, new Set(['require']))) {
          loads.push({ problem: 'domain uses an indirect require module loader' });
        }
      }
    }
    if (
      node.type === 'NewExpression' &&
      containsReference(node.callee, new Set(['eval', 'Function']))
    ) {
      loads.push({ problem: 'domain uses eval or Function as an interpreted module loader' });
    }

    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'errors', 'tokens'].includes(key)) continue;
      visit(child);
    }
  };
  visit(tree.program);
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

function dependencyTarget(specifier) {
  if (typeof specifier !== 'string') return null;
  for (const protocol of ['file:', 'link:']) {
    if (specifier.startsWith(protocol)) return specifier.slice(protocol.length);
  }
  for (const protocol of ['npm:', 'workspace:']) {
    if (!specifier.startsWith(protocol)) continue;
    const target = specifier.slice(protocol.length);
    const match = target.match(/^(@[^/]+\/[^@]+|[^@/]+)(?:@.*)?$/);
    return match?.[1] ?? null;
  }
  return specifier;
}

function forbiddenTargetReason(importer, specifier) {
  const target = dependencyTarget(specifier);
  return target === null ? null : forbiddenReason(importer, target);
}

function stringLeaves(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringLeaves);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringLeaves);
  return [];
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
  for (const [dependency, specification] of Object.entries(domainManifest?.[section] ?? {})) {
    const reason = forbiddenReason(domainManifestPath, dependency);
    if (reason) violations.push(`packages/domain/package.json ${section} includes ${dependency}: ${reason}`);
    const targetReason = forbiddenTargetReason(domainManifestPath, specification);
    if (targetReason) {
      violations.push(
        `packages/domain/package.json ${section} maps ${dependency} to ${specification}: ${targetReason}`,
      );
    }
  }
}
for (const [alias, mapping] of Object.entries(domainManifest?.imports ?? {})) {
  for (const target of stringLeaves(mapping)) {
    const reason = forbiddenTargetReason(domainManifestPath, target);
    if (reason) {
      violations.push(`packages/domain/package.json imports maps ${alias} to ${target}: ${reason}`);
    }
  }
}

const domainTsconfigPath = resolve(domainRoot, 'tsconfig.json');
let domainTsconfig;
try {
  domainTsconfig = JSON.parse(readFileSync(domainTsconfigPath, 'utf8'));
} catch (error) {
  violations.push(`packages/domain/tsconfig.json is unreadable: ${error.message}`);
}
for (const reference of domainTsconfig?.references ?? []) {
  const reason = forbiddenTargetReason(domainTsconfigPath, reference?.path);
  if (reason) {
    violations.push(`packages/domain/tsconfig.json references ${reference.path}: ${reason}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(`Architecture boundary violations:\n${violations.map((line) => `- ${line}`).join('\n')}\n`);
  process.exitCode = 1;
}
