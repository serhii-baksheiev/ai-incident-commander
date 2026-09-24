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

/**
 * Adapter-specific config key: a slug-like camelCase word (`baseUrl`,
 * `owner`, `repo`). The domain does not know which keys a given adapter
 * expects - that catalog is a later slice (packages/tools/src/lab-source.ts,
 * github-source.ts). This only bounds the SHAPE every adapter's config must
 * fit.
 */
const ConfigKeySchema = z.string().regex(/^[a-z][a-zA-Z0-9]{0,63}$/);

/**
 * Credential-shaped patterns a config value must never carry - a config
 * value travels with the SourceBinding record itself, never through the
 * CredentialRef indirection, so anything that reads as a live credential is
 * refused here rather than accepted and left to leak downstream. Every
 * pattern below is anchored and unquantified-inside-a-quantifier (no nested
 * repetition), so this predicate is O(length) per pattern with no
 * backtracking blowup.
 *
 * Limit, stated rather than left to be found: this is a fixed, small
 * vocabulary (GitHub PAT, AWS access key, Slack token, a Bearer-prefixed
 * value, `scheme://user:pass@` userinfo) - not an entropy analyser. A
 * credential shaped some other way passes; a placeholder that happens to
 * match one of these shapes is refused. See
 * registry-names-and-config.test.mjs for the corpus this is checked against.
 */
const SECRET_SHAPE_PATTERNS = [
  /^ghp_/,
  /^github_pat_/,
  /^AKIA/,
  /^xox[baprs]-/,
  /^Bearer /,
  /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@]*:[^/@]*@/,
];

const looksLikeSecret = (value: string) => SECRET_SHAPE_PATTERNS.some((pattern) => pattern.test(value));

/**
 * A per-adapter config object. Bounded at sixteen keys, each a slug-like
 * name, each value a non-empty string of at most 512 characters that does
 * not read as a credential (see `looksLikeSecret` above). What each adapter
 * actually requires is validated by the adapter catalog in a later slice -
 * this schema only enforces the shape every adapter's config must fit.
 */
const SourceBindingConfigSchema = z
  .record(ConfigKeySchema, z.string().min(1).max(512))
  .refine((config) => Object.keys(config).length <= 16, 'a SourceBinding config carries at most sixteen keys')
  .refine(
    (config) => Object.values(config).every((value) => !looksLikeSecret(value)),
    'a SourceBinding config value must not be shaped like a credential',
  );

export const SourceBindingSchema = z.strictObject({
  id: RegistryIdSchema,
  environmentId: RegistryIdSchema,
  adapterId: nonEmptyString(200),
  adapterVersion: nonEmptyString(200),
  name: SlugSchema,
  config: SourceBindingConfigSchema,
  credentialRefId: RegistryIdSchema.nullable(),
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
  name: SlugSchema,
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
    const credentialRefNamesByEnvironment = new Map<string, Set<string>>();
    registry.credentialRefs.forEach((ref, index) => {
      if (!environmentById.has(ref.environmentId))
        issue(ctx, 'CredentialRef.environmentId does not name a known Environment', [
          'credentialRefs',
          index,
          'environmentId',
        ]);
      const names = credentialRefNamesByEnvironment.get(ref.environmentId) ?? new Set<string>();
      if (names.has(ref.name)) issue(ctx, 'duplicate CredentialRef name within one Environment', ['credentialRefs', index, 'name']);
      names.add(ref.name);
      credentialRefNamesByEnvironment.set(ref.environmentId, names);
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

    const sourceBindingNamesByEnvironment = new Map<string, Set<string>>();
    registry.sourceBindings.forEach((binding, index) => {
      if (!environmentById.has(binding.environmentId))
        issue(ctx, 'SourceBinding.environmentId does not name a known Environment', [
          'sourceBindings',
          index,
          'environmentId',
        ]);
      const names = sourceBindingNamesByEnvironment.get(binding.environmentId) ?? new Set<string>();
      if (names.has(binding.name)) issue(ctx, 'duplicate SourceBinding name within one Environment', ['sourceBindings', index, 'name']);
      names.add(binding.name);
      sourceBindingNamesByEnvironment.set(binding.environmentId, names);

      // A null credentialRefId names a credential-less adapter (e.g. lab@1)
      // and skips the credential checks below entirely.
      if (binding.credentialRefId === null) return;
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
