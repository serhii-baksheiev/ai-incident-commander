import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const projectRoot = process.cwd();
const domainRoot = resolve(projectRoot, 'packages/domain');
const manifestPath = resolve(domainRoot, 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const dependencySections = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];
const forbiddenPackage = /^(?:@aic\/(?:graph|tools)(?:\/|@|$)|langchain(?:\/|$)|@langchain\/)/;
const localProtocol = /^(?:file|link|workspace):(.+)$/;
const forbiddenRoots = [resolve(projectRoot, 'packages/graph'), resolve(projectRoot, 'packages/tools')];

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function targetIsForbidden(target) {
  if (typeof target !== 'string') return false;
  if (forbiddenPackage.test(target)) return true;

  const npmAlias = target.match(/^npm:(.+)$/)?.[1];
  if (npmAlias && forbiddenPackage.test(npmAlias)) return true;

  const localTarget = target.match(localProtocol)?.[1];
  if (!localTarget || localTarget === '*' || /^[~^<>=]/.test(localTarget)) return false;
  const resolvedTarget = resolve(domainRoot, localTarget);
  return forbiddenRoots.some((root) => isWithin(root, resolvedTarget));
}

function stringTargets(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringTargets);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringTargets);
  return [];
}

const violations = [];
for (const section of dependencySections) {
  for (const [name, target] of Object.entries(manifest[section] ?? {})) {
    if (forbiddenPackage.test(name) || targetIsForbidden(target)) {
      violations.push(`${section}.${name} targets ${JSON.stringify(target)}`);
    }
  }
}

for (const [name, target] of Object.entries(manifest.imports ?? {})) {
  if (stringTargets(target).some(targetIsForbidden)) {
    violations.push(`imports.${name} targets ${JSON.stringify(target)}`);
  }
}

if (violations.length > 0) {
  process.stderr.write(
    `Domain manifest boundary violations:\n${violations.sort().map((line) => `- ${line}`).join('\n')}\n`,
  );
  process.exitCode = 1;
}
