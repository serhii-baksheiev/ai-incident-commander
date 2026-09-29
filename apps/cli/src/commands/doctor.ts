import type { Environment, RegistrySnapshot, Service } from '@aic/domain';
import type { ResolveSecretResult } from '@aic/tools';

import { classifyEnvironmentBindings, findEnvironment, findService, unresolvedScopeRow } from './binding-classification.js';

/**
 * AIC-99 slice e: `runDoctorCommand(argv, deps)` — `aic doctor [<service>
 * [<environment>]]`. Reuses `classifyEnvironmentBindings`
 * (`./binding-classification.ts`), the same per-binding classification
 * `aic source check` reports, and adds one informational `actionPolicy` row
 * per Environment in scope. See test/cli-doctor.test.mjs for the full pinned
 * argv/deps/output contract, and `.claude/runs/20260929-aic99e/design.md`
 * for the design this satisfies.
 */

export interface DoctorStore {
  snapshot(): Promise<RegistrySnapshot>;
}

export interface DoctorDeps {
  readonly store: DoctorStore;
  readonly resolveSecret: (secretName: string) => Promise<ResolveSecretResult>;
  readonly fetch?: typeof fetch;
  readonly stdout: (text: string) => void;
}

export interface DoctorSummary {
  readonly allReady: boolean;
}

interface EnvironmentInScope {
  readonly service: Service;
  readonly environment: Environment;
}

function environmentsOfService(registry: RegistrySnapshot, service: Service): Environment[] {
  return registry.environments.filter((candidate) => candidate.serviceId === service.id);
}

export async function runDoctorCommand(argv: readonly string[], deps: DoctorDeps): Promise<DoctorSummary> {
  const [serviceName, environmentName] = argv;
  const registry = await deps.store.snapshot();

  let scope: EnvironmentInScope[];

  if (serviceName === undefined) {
    scope = registry.services.flatMap((service) =>
      environmentsOfService(registry, service).map((environment) => ({ service, environment })),
    );
  } else {
    const service = findService(registry, serviceName);
    if (!service) {
      deps.stdout(JSON.stringify(unresolvedScopeRow(serviceName, environmentName ?? null, null)));
      return { allReady: false };
    }
    if (environmentName === undefined) {
      scope = environmentsOfService(registry, service).map((environment) => ({ service, environment }));
    } else {
      const environment = findEnvironment(registry, service.id, environmentName);
      if (!environment) {
        deps.stdout(JSON.stringify(unresolvedScopeRow(serviceName, environmentName, null)));
        return { allReady: false };
      }
      scope = [{ service, environment }];
    }
  }

  let allReady = true;
  for (const { service, environment } of scope) {
    const hasActionPolicy = registry.actionPolicies.some((policy) => policy.environmentId === environment.id);
    deps.stdout(JSON.stringify({ service: service.name, environment: environment.name, actionPolicy: hasActionPolicy }));

    const { rows, ready } = await classifyEnvironmentBindings(service.name, environment, registry, undefined, {
      resolveSecret: deps.resolveSecret,
      fetch: deps.fetch,
    });
    for (const row of rows) {
      deps.stdout(JSON.stringify(row));
    }
    if (!ready) {
      allReady = false;
    }
  }

  return { allReady };
}
