import { createEvidenceSourceForBinding, SecretNameError, type ResolveSecretResult } from '@aic/tools';
import type { CredentialRef, Environment, RegistrySnapshot, SourceBinding } from '@aic/domain';

/**
 * AIC-99 slice e: the per-binding classification `aic source check` and
 * `aic doctor` both report, kept as ONE implementation
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation")
 * rather than two copies that could disagree. See
 * test/cli-source-check.test.mjs and test/cli-doctor.test.mjs for the full
 * pinned contract this module satisfies.
 */

export type BindingStatus = 'ready' | 'denied' | 'unreachable' | 'error' | 'absent' | 'misconfigured';

export interface BindingRow {
  readonly service: string | null;
  readonly environment: string | null;
  readonly binding: string | null;
  readonly status: BindingStatus;
  readonly reason?: string;
}

export interface ClassificationDeps {
  readonly resolveSecret: (secretName: string) => Promise<ResolveSecretResult>;
  readonly fetch?: typeof fetch;
}

function credentialForBinding(binding: SourceBinding, registry: RegistrySnapshot): CredentialRef | null {
  if (binding.credentialRefId === null) {
    return null;
  }
  return registry.credentialRefs.find((candidate) => candidate.id === binding.credentialRefId) ?? null;
}

/**
 * Classifies one binding already known to exist: `check()` a source built
 * through `@aic/tools`'s `createEvidenceSourceForBinding`, mapping its
 * outcome into exactly the six words `BindingStatus` names. A factory refusal never reaches the filesystem/network path below —
 * `secret-absent` reads as `absent`; every other factory refusal reads as
 * `misconfigured`, naming its own reason.
 */
async function classifyKnownBinding(
  service: string,
  environment: string,
  binding: SourceBinding,
  registry: RegistrySnapshot,
  deps: ClassificationDeps,
): Promise<BindingRow> {
  const credentialRef = credentialForBinding(binding, registry);
  // One binding the catalog cannot build (a stored secret name the resolver
  // refuses, anything else that throws) is that binding's own
  // `misconfigured` row with a fixed reason word; it never ends the run and
  // never carries the thrown message, which may name a stored value.
  let built;
  try {
    built = await createEvidenceSourceForBinding(binding, {
      credentialRef,
      resolveSecret: deps.resolveSecret,
      fetch: deps.fetch,
    });
  } catch (error) {
    const reason = error instanceof SecretNameError ? 'invalid-secret-name' : 'catalog-error';
    return { service, environment, binding: binding.name, status: 'misconfigured', reason };
  }

  if (built.status === 'refused') {
    if (built.reason === 'secret-absent') {
      return { service, environment, binding: binding.name, status: 'absent' };
    }
    return { service, environment, binding: binding.name, status: 'misconfigured', reason: built.reason };
  }

  let checkResult;
  try {
    checkResult = await built.source.check();
  } catch {
    return { service, environment, binding: binding.name, status: 'unreachable' };
  }

  if (checkResult.status === 'ready') {
    return { service, environment, binding: binding.name, status: 'ready' };
  }
  if (checkResult.reason === 'denied') {
    return { service, environment, binding: binding.name, status: 'denied' };
  }
  if (checkResult.reason === 'unavailable' || checkResult.reason === 'timeout') {
    return { service, environment, binding: binding.name, status: 'unreachable' };
  }
  return { service, environment, binding: binding.name, status: 'error', reason: checkResult.reason };
}

export interface ScopedBindingsResult {
  readonly rows: readonly BindingRow[];
  readonly ready: boolean;
}

/**
 * Classifies every `SourceBinding` in scope for one already-resolved
 * `Environment` — every binding when `bindingName` is `undefined`, or
 * exactly the named one. Reports one `{ binding: null, status: 'absent' }`
 * row, naming the given `bindingName` when one was given, when nothing is in
 * scope at all.
 */
export async function classifyEnvironmentBindings(
  service: string,
  environment: Environment,
  registry: RegistrySnapshot,
  bindingName: string | undefined,
  deps: ClassificationDeps,
): Promise<ScopedBindingsResult> {
  const bindingsInEnvironment = registry.sourceBindings.filter(
    (candidate) => candidate.environmentId === environment.id,
  );

  let targets: SourceBinding[];
  if (bindingName !== undefined) {
    const found = bindingsInEnvironment.find((candidate) => candidate.name === bindingName);
    if (!found) {
      return {
        rows: [{ service, environment: environment.name, binding: bindingName, status: 'absent' }],
        ready: false,
      };
    }
    targets = [found];
  } else if (bindingsInEnvironment.length === 0) {
    return {
      rows: [{ service, environment: environment.name, binding: null, status: 'absent' }],
      ready: false,
    };
  } else {
    targets = bindingsInEnvironment;
  }

  const rows: BindingRow[] = [];
  let ready = true;
  for (const binding of targets) {
    const row = await classifyKnownBinding(service, environment.name, binding, registry, deps);
    rows.push(row);
    if (row.status !== 'ready') {
      ready = false;
    }
  }
  return { rows, ready };
}

/** One `absent` row for a service/environment name this registry does not resolve. */
export function unresolvedScopeRow(
  service: string | null,
  environment: string | null,
  binding: string | null,
): BindingRow {
  return { service, environment, binding, status: 'absent' };
}

export function findService(registry: RegistrySnapshot, serviceName: string) {
  return registry.services.find((candidate) => candidate.name === serviceName);
}

export function findEnvironment(registry: RegistrySnapshot, serviceId: string, environmentName: string) {
  return registry.environments.find(
    (candidate) => candidate.serviceId === serviceId && candidate.name === environmentName,
  );
}
