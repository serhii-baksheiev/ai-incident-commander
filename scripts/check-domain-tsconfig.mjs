import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

const projectRoot = process.cwd();
const domainRoot = resolve(projectRoot, 'packages/domain');
const configurationPath = resolve(domainRoot, 'tsconfig.json');
const configuration = JSON.parse(readFileSync(configurationPath, 'utf8'));
const allowedSharedConfig = resolve(projectRoot, 'tsconfig.base.json');
const forbiddenPackage = /^(?:@aic\/(?:graph|tools)(?:\/|$)|langchain(?:\/|$)|@langchain\/)/;

function isWithin(parent, candidate) {
  const pathFromParent = relative(parent, candidate);
  return pathFromParent === '' || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

function resolvedPath(target) {
  return resolve(domainRoot, String(target).replace(/\/\*$/, ''));
}

function isForbiddenTarget(target, { allowSharedConfig = false } = {}) {
  if (typeof target !== 'string' || forbiddenPackage.test(target)) return true;
  const resolvedTarget = resolvedPath(target);
  if (allowSharedConfig && resolvedTarget === allowedSharedConfig) return false;
  return !isWithin(domainRoot, resolvedTarget);
}

const violations = [];
for (const target of [configuration.extends ?? []].flat()) {
  if (isForbiddenTarget(target, { allowSharedConfig: true })) {
    violations.push(`extends targets ${JSON.stringify(target)}`);
  }
}

for (const reference of configuration.references ?? []) {
  if (isForbiddenTarget(reference?.path)) {
    violations.push(`references targets ${JSON.stringify(reference?.path)}`);
  }
}

for (const [alias, targets] of Object.entries(configuration.compilerOptions?.paths ?? {})) {
  if (forbiddenPackage.test(alias) || [targets].flat().some((target) => isForbiddenTarget(target))) {
    violations.push(`compilerOptions.paths.${alias} targets ${JSON.stringify(targets)}`);
  }
}

const baseUrl = configuration.compilerOptions?.baseUrl;
if (baseUrl !== undefined && isForbiddenTarget(baseUrl)) {
  violations.push(`compilerOptions.baseUrl targets ${JSON.stringify(baseUrl)}`);
}

if (violations.length > 0) {
  process.stderr.write(
    `Domain tsconfig boundary violations:\n${violations.sort().map((line) => `- ${line}`).join('\n')}\n`,
  );
  process.exitCode = 1;
}
