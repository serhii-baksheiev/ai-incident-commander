import type { RegistrySnapshot } from '@aic/domain';
import type { ResolveSecretResult } from '@aic/tools';

import {
  classifyEnvironmentBindings,
  findEnvironment,
  findService,
  unresolvedScopeRow,
  type BindingRow,
} from './binding-classification.js';

/**
 * AIC-99 slice e: `runSourceCheckCommand(argv, deps)` — `aic source check
 * <service> <env> [<binding>]`. See test/cli-source-check.test.mjs for the
 * full pinned argv/deps/classification contract, and
 * `.claude/runs/20260929-aic99e/design.md` for the design this satisfies.
 */

export interface SourceCheckStore {
  snapshot(): Promise<RegistrySnapshot>;
}

export interface SourceCheckDeps {
  readonly store: SourceCheckStore;
  readonly resolveSecret: (secretName: string) => Promise<ResolveSecretResult>;
  readonly fetch?: typeof fetch;
  readonly stdout: (text: string) => void;
}

export interface SourceCheckSummary {
  readonly allReady: boolean;
}

function writeRow(stdout: (text: string) => void, row: BindingRow): void {
  stdout(JSON.stringify(row));
}

export async function runSourceCheckCommand(
  argv: readonly string[],
  deps: SourceCheckDeps,
): Promise<SourceCheckSummary> {
  const [serviceName, environmentName, bindingName] = argv;
  const registry = await deps.store.snapshot();

  const service = findService(registry, serviceName);
  if (!service) {
    writeRow(deps.stdout, unresolvedScopeRow(serviceName, environmentName, bindingName ?? null));
    return { allReady: false };
  }

  const environment = findEnvironment(registry, service.id, environmentName);
  if (!environment) {
    writeRow(deps.stdout, unresolvedScopeRow(serviceName, environmentName, bindingName ?? null));
    return { allReady: false };
  }

  const { rows, ready } = await classifyEnvironmentBindings(serviceName, environment, registry, bindingName, {
    resolveSecret: deps.resolveSecret,
    fetch: deps.fetch,
  });
  for (const row of rows) {
    writeRow(deps.stdout, row);
  }
  return { allReady: ready };
}
