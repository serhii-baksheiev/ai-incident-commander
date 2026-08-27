import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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
const ignoredDomainDirectories = new Set([
  resolve(domainRoot, 'dist'),
  resolve(domainRoot, 'node_modules'),
]);

function canonicalPath(path) {
  let cursor = resolve(path);
  const suffix = [];
  while (true) {
    try {
      return resolve(realpathSync.native(cursor), ...suffix);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return resolve(path);
      suffix.unshift(basename(cursor));
      cursor = parent;
    }
  }
}

function isWithin(parent, path) {
  const pathFromParent = relative(canonicalPath(parent), canonicalPath(path));
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function sourceTreeIn(directory) {
  const files = [];
  const symlinks = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (ignoredDomainDirectories.has(path)) continue;
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
  const walk = (node, visitor) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visitor);
      return;
    }
    visitor(node);
    for (const [key, child] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'errors', 'tokens'].includes(key)) continue;
      walk(child, visitor);
    }
  };
  const evaluatorNames = new Set(['eval', 'Function']);
  const requireFactoryNames = new Set(['createRequire']);
  const requireNames = new Set(['require']);
  const resolverNames = new Set();
  const referenceKind = (node) => {
    const current = unwrap(node);
    if (!current) return null;
    if (current.type === 'Identifier') {
      if (evaluatorNames.has(current.name)) return 'evaluator';
      if (requireFactoryNames.has(current.name)) return 'require-factory';
      if (requireNames.has(current.name)) return 'require';
      if (resolverNames.has(current.name)) return 'require-resolve';
      return null;
    }
    if (current.type === 'SequenceExpression') {
      for (const expression of current.expressions.toReversed()) {
        const kind = referenceKind(expression);
        if (kind) return kind;
      }
      return null;
    }
    if (['MemberExpression', 'OptionalMemberExpression'].includes(current.type)) {
      const name = memberName(current);
      const objectKind = referenceKind(current.object);
      if (name === 'eval' || name === 'Function') return 'evaluator';
      if (name === 'createRequire') return 'require-factory';
      if (name === 'require') return 'require';
      if (name === 'resolve' && objectKind === 'require') return 'require-resolve';
      return objectKind;
    }
    return null;
  };
  const addAlias = (names, name) => {
    if (!name || names.has(name)) return false;
    names.add(name);
    return true;
  };
  const addProducedAlias = (name, expression) => {
    const current = unwrap(expression);
    if (!name || !current) return false;
    const kind = referenceKind(current);
    if (kind === 'evaluator') return addAlias(evaluatorNames, name);
    if (kind === 'require-factory') return addAlias(requireFactoryNames, name);
    if (kind === 'require') return addAlias(requireNames, name);
    if (kind === 'require-resolve') return addAlias(resolverNames, name);
    if (
      ['CallExpression', 'OptionalCallExpression', 'NewExpression'].includes(current.type) &&
      referenceKind(current.callee) === 'require-factory'
    ) {
      return addAlias(requireNames, name);
    }
    return false;
  };
  walk(tree.program, (node) => {
    if (node.type !== 'ImportDeclaration' || literalValue(node.source) !== 'node:module') return;
    for (const specifier of node.specifiers) {
      if (
        specifier.type === 'ImportSpecifier' &&
        (specifier.imported?.name ?? literalValue(specifier.imported)) === 'createRequire'
      ) {
        addAlias(requireFactoryNames, specifier.local?.name);
      }
    }
  });
  let aliasesChanged;
  do {
    aliasesChanged = false;
    walk(tree.program, (node) => {
      if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') {
        aliasesChanged = addProducedAlias(node.id.name, node.init) || aliasesChanged;
      }
      if (node.type === 'AssignmentExpression' && node.left?.type === 'Identifier') {
        aliasesChanged = addProducedAlias(node.left.name, node.right) || aliasesChanged;
      }
    });
  } while (aliasesChanged);

  walk(tree.program, (node) => {
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
    if (node.type === 'TSImportType') {
      addModuleSpecifier(node.argument, 'TypeScript import type');
    }
    if (['CallExpression', 'OptionalCallExpression'].includes(node.type)) {
      const callee = unwrap(node.callee);
      const kind = referenceKind(callee);
      if (callee?.type === 'Import') {
        addModuleSpecifier(node.arguments[0], 'dynamic import');
      } else if (kind === 'evaluator') {
        loads.push({ problem: 'domain uses eval or Function as an interpreted module loader' });
      } else if (kind === 'require-factory') {
        loads.push({ problem: 'domain uses createRequire as a module loader' });
      } else if (kind === 'require') {
        addModuleSpecifier(node.arguments[0], 'require()');
      } else if (kind === 'require-resolve') {
        addModuleSpecifier(node.arguments[0], 'require.resolve()');
      }
    }
    if (node.type === 'NewExpression') {
      const kind = referenceKind(node.callee);
      if (kind === 'evaluator') {
        loads.push({ problem: 'domain uses eval or Function as an interpreted module loader' });
      }
      if (kind === 'require-factory') {
        loads.push({ problem: 'domain uses createRequire as a module loader' });
      }
    }
  });
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
  let target = null;
  if (specifier.startsWith('file:')) {
    try {
      target = fileURLToPath(specifier);
    } catch {
      return 'domain uses an invalid file URL as a dependency target';
    }
  } else if (specifier.startsWith('.') || isAbsolute(specifier)) {
    target = resolve(dirname(importer), specifier);
  }
  if (target !== null) {
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
const inspectedTsconfigs = new Set();
function inspectTsconfig(configurationPath) {
  if (inspectedTsconfigs.has(configurationPath)) return;
  inspectedTsconfigs.add(configurationPath);

  const displayPath = relative(projectRoot, configurationPath);
  let configuration;
  try {
    configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
  } catch (error) {
    violations.push(`${displayPath} is unreadable: ${error.message}`);
    return;
  }

  for (const reference of configuration.references ?? []) {
    const reason = forbiddenTargetReason(configurationPath, reference?.path);
    if (reason) violations.push(`${displayPath} references ${reference.path}: ${reason}`);
  }

  const pathBase = resolve(dirname(configurationPath), configuration.compilerOptions?.baseUrl ?? '.');
  for (const [alias, mappings] of Object.entries(configuration.compilerOptions?.paths ?? {})) {
    const visibleAlias = alias.replaceAll('*', '');
    if (forbiddenReason(configurationPath, visibleAlias)) continue;
    for (const mapping of stringLeaves(mappings)) {
      const pathTarget = mapping.replaceAll('*', '');
      const target = pathTarget.startsWith('file:')
        ? pathTarget
        : resolve(pathBase, pathTarget);
      const reason = forbiddenReason(configurationPath, target);
      if (reason) {
        violations.push(`${displayPath} paths maps ${alias} to ${mapping}: ${reason}`);
      }
    }
  }

  for (const extended of stringLeaves(configuration.extends)) {
    if (!extended.startsWith('.') && !isAbsolute(extended)) continue;
    const target = resolve(dirname(configurationPath), extended);
    inspectTsconfig(target.endsWith('.json') ? target : `${target}.json`);
  }
}
inspectTsconfig(domainTsconfigPath);

if (violations.length > 0) {
  process.stderr.write(`Architecture boundary violations:\n${violations.map((line) => `- ${line}`).join('\n')}\n`);
  process.exitCode = 1;
}
