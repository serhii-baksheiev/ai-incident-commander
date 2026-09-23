/**
 * AIC-96, slice A: the scoped domain types the integration boundary ADR is
 * built against (docs/decisions/integration-boundary.md, "Terminology") -
 * `Service`, `Environment`, `SourceBinding`, `CredentialRef`, `ActionPolicy`,
 * the `RegistrySnapshot` that holds them consistent, and the `primaryScope`
 * an incident carries.
 *
 * Framework-free: the domain package may import only `zod`, `node:crypto` and
 * its own modules (this file needs only `zod`), enforced by
 * scoped-domain-contract.test.mjs › "the domain package imports only zod,
 * node:crypto and its own modules".
 */
import { z } from 'zod';

const nonEmptyString = (max: number) => z.string().min(1).max(max);

/**
 * A lowercase, hyphen-separated name - `Service.name` and `Environment.name`.
 * Distinct from `RegistryIdSchema` below: a slug is a single word or several
 * hyphen-joined words (`checkout`, `checkout-v2`), never a caller-facing
 * identifier.
 */
const SlugSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/**
 * A server-assigned registry identifier (the decision record's "identity is
 * server-assigned"), and always a UUID. That is what makes "a repository is an
 * alias, never identity" mechanical: no name — `checkout`, `payments-api` — can
 * stand where an id belongs. See scoped-domain-contract.test.mjs › "refuses a
 * repository-style name or a bare word as a registry id, and accepts a UUID".
 */
export const RegistryIdSchema = z.uuid();

export const PrimaryScopeSchema = z.strictObject({
  serviceId: RegistryIdSchema,
  environmentId: RegistryIdSchema,
});

export const ServiceInputSchema = z.strictObject({
  name: SlugSchema,
  repositoryAliases: z.array(nonEmptyString(200)),
});

export const ServiceSchema = ServiceInputSchema.extend({
  id: RegistryIdSchema,
});

export const EnvironmentSchema = z.strictObject({
  id: RegistryIdSchema,
  serviceId: RegistryIdSchema,
  name: SlugSchema,
});

export const SourceBindingSchema = z.strictObject({
  id: RegistryIdSchema,
  environmentId: RegistryIdSchema,
  adapterId: nonEmptyString(200),
  adapterVersion: nonEmptyString(200),
  credentialRefId: RegistryIdSchema,
});

/**
 * A secret's NAME as known to AIC's secret backend - never the secret's own
 * value (docs/decisions/integration-boundary.md, "Trust boundary": "its
 * value must never enter incident state").
 *
 * Limit, stated rather than left to be found: an uppercase-underscore value
 * that happens to be random is accepted - this schema cannot distinguish it
 * from a real secret name, which is exactly what
 * credential-ref-secrets.test.mjs › "states its limit: an uppercase-underscore random value is accepted"
 * pins.
 */
export const SecretNameSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/);

export const CredentialRefSchema = z.strictObject({
  id: RegistryIdSchema,
  environmentId: RegistryIdSchema,
  access: z.enum(['read', 'write']),
  secretName: SecretNameSchema,
});

export const ActionPolicySchema = z.strictObject({
  id: RegistryIdSchema,
  environmentId: RegistryIdSchema,
  allowedActionTypes: z.array(nonEmptyString(200)),
  writeCredentialRefIds: z.array(RegistryIdSchema),
});

const issue = (
  ctx: z.RefinementCtx,
  message: string,
  path: (string | number)[],
) => ctx.addIssue({ code: 'custom', message, path });

export const RegistrySnapshotSchema = z
  .strictObject({
    services: z.array(ServiceSchema),
    environments: z.array(EnvironmentSchema),
    sourceBindings: z.array(SourceBindingSchema),
    credentialRefs: z.array(CredentialRefSchema),
    actionPolicies: z.array(ActionPolicySchema),
  })
  .superRefine((registry, ctx) => {
    const seenIds = (kind: string, records: { id: string }[]) => {
      const seen = new Set<string>();
      records.forEach((record, index) => {
        if (seen.has(record.id)) issue(ctx, `duplicate id within ${kind}`, [kind, index, 'id']);
        seen.add(record.id);
      });
    };
    seenIds('services', registry.services);
    seenIds('environments', registry.environments);
    seenIds('sourceBindings', registry.sourceBindings);
    seenIds('credentialRefs', registry.credentialRefs);
    seenIds('actionPolicies', registry.actionPolicies);

    const serviceIds = new Set(registry.services.map((service) => service.id));
    const serviceNames = new Set<string>();
    const repositoryAliases = new Set<string>();
    registry.services.forEach((service, index) => {
      if (serviceNames.has(service.name)) issue(ctx, 'duplicate Service name', ['services', index, 'name']);
      serviceNames.add(service.name);
      const ownAliases = new Set<string>();
      service.repositoryAliases.forEach((alias, aliasIndex) => {
        const path = ['services', index, 'repositoryAliases', aliasIndex];
        if (ownAliases.has(alias)) issue(ctx, 'repository alias listed twice by one Service', path);
        else if (repositoryAliases.has(alias)) issue(ctx, 'repository alias already used by another Service', path);
        ownAliases.add(alias);
        repositoryAliases.add(alias);
      });
    });

    const environmentById = new Map(registry.environments.map((environment) => [environment.id, environment]));
    const namesByService = new Map<string, Set<string>>();
    registry.environments.forEach((environment, index) => {
      if (!serviceIds.has(environment.serviceId))
        issue(ctx, 'Environment.serviceId does not name a known Service', ['environments', index, 'serviceId']);
      const names = namesByService.get(environment.serviceId) ?? new Set<string>();
      if (names.has(environment.name))
        issue(ctx, 'duplicate Environment name within one Service', ['environments', index, 'name']);
      names.add(environment.name);
      namesByService.set(environment.serviceId, names);
    });

    const credentialRefById = new Map(registry.credentialRefs.map((ref) => [ref.id, ref]));
    const refsByEnvironment = new Map<string, typeof registry.credentialRefs>();
    registry.credentialRefs.forEach((ref) => {
      const list = refsByEnvironment.get(ref.environmentId) ?? [];
      list.push(ref);
      refsByEnvironment.set(ref.environmentId, list);
    });
    registry.credentialRefs.forEach((ref, index) => {
      if (!environmentById.has(ref.environmentId))
        issue(ctx, 'CredentialRef.environmentId does not name a known Environment', [
          'credentialRefs',
          index,
          'environmentId',
        ]);
      // Scoped to one Environment on purpose: a read reference in `staging` and
      // a write reference in `production` may name the same backend secret,
      // because each Environment's credentials are separate records. See
      // scoped-domain-contract.test.mjs › "states its limit: a read and a write CredentialRef in different Environments may name one secret".
      if (ref.access !== 'write') return;
      const siblings = refsByEnvironment.get(ref.environmentId) ?? [];
      const collides = siblings.some((sibling) => sibling.access === 'read' && sibling.secretName === ref.secretName);
      if (collides)
        issue(
          ctx,
          'a write CredentialRef must never name the same secret as a read CredentialRef in the same Environment',
          ['credentialRefs', index, 'secretName'],
        );
    });

    registry.sourceBindings.forEach((binding, index) => {
      if (!environmentById.has(binding.environmentId))
        issue(ctx, 'SourceBinding.environmentId does not name a known Environment', [
          'sourceBindings',
          index,
          'environmentId',
        ]);
      const credential = credentialRefById.get(binding.credentialRefId);
      if (!credential) {
        issue(ctx, 'SourceBinding.credentialRefId does not name a known CredentialRef', [
          'sourceBindings',
          index,
          'credentialRefId',
        ]);
      } else if (credential.environmentId !== binding.environmentId) {
        issue(ctx, 'SourceBinding.credentialRefId must name a CredentialRef in the same Environment', [
          'sourceBindings',
          index,
          'credentialRefId',
        ]);
      } else if (credential.access !== 'read') {
        issue(ctx, 'SourceBinding.credentialRefId must name a read CredentialRef', [
          'sourceBindings',
          index,
          'credentialRefId',
        ]);
      }
    });

    const policyEnvironments = new Set<string>();
    registry.actionPolicies.forEach((policy, index) => {
      if (!environmentById.has(policy.environmentId))
        issue(ctx, 'ActionPolicy.environmentId does not name a known Environment', [
          'actionPolicies',
          index,
          'environmentId',
        ]);
      if (policyEnvironments.has(policy.environmentId))
        issue(ctx, 'at most one ActionPolicy may exist per Environment', ['actionPolicies', index, 'environmentId']);
      policyEnvironments.add(policy.environmentId);

      policy.writeCredentialRefIds.forEach((refId, refIndex) => {
        const path = ['actionPolicies', index, 'writeCredentialRefIds', refIndex];
        const credential = credentialRefById.get(refId);
        if (!credential) issue(ctx, 'ActionPolicy.writeCredentialRefIds entry does not name a known CredentialRef', path);
        else if (credential.environmentId !== policy.environmentId)
          issue(ctx, 'ActionPolicy.writeCredentialRefIds entry must name a CredentialRef in the same Environment', path);
        else if (credential.access !== 'write')
          issue(ctx, 'ActionPolicy.writeCredentialRefIds entry names a read CredentialRef; only write ones belong here', path);
      });
    });
  });

export type Service = z.infer<typeof ServiceSchema>;
export type ServiceInput = z.infer<typeof ServiceInputSchema>;
export type Environment = z.infer<typeof EnvironmentSchema>;
export type SourceBinding = z.infer<typeof SourceBindingSchema>;
export type CredentialRef = z.infer<typeof CredentialRefSchema>;
export type ActionPolicy = z.infer<typeof ActionPolicySchema>;
export type RegistrySnapshot = z.infer<typeof RegistrySnapshotSchema>;
export type PrimaryScope = z.infer<typeof PrimaryScopeSchema>;

export type PrimaryScopeCheck =
  | { ok: true; environment: Environment }
  | { ok: false; reason: 'unknown-service' | 'unknown-environment' | 'environment-of-another-service' };

/**
 * Resolves a `primaryScope` against a registry snapshot, in the order the
 * reason names it: an unknown Service is reported before an unknown or
 * mismatched Environment is even looked up. See
 * scoped-domain-contract.test.mjs › "checkPrimaryScope refuses an
 * environment owned by another service".
 */
export function checkPrimaryScope(registry: RegistrySnapshot, scope: PrimaryScope): PrimaryScopeCheck {
  const service = registry.services.find((candidate) => candidate.id === scope.serviceId);
  if (!service) return { ok: false, reason: 'unknown-service' };

  const environment = registry.environments.find((candidate) => candidate.id === scope.environmentId);
  if (!environment) return { ok: false, reason: 'unknown-environment' };

  if (environment.serviceId !== service.id) return { ok: false, reason: 'environment-of-another-service' };

  return { ok: true, environment };
}
