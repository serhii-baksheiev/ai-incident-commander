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
 * The camelCase-slug shape every adapter config key must fit (`baseUrl`,
 * `owner`, `repo`). Anchored at both ends and capped at sixty-four
 * characters by the quantifier itself, so testing it costs at most
 * sixty-four characters of work regardless of how long the candidate key
 * actually is.
 */
const CONFIG_KEY_PATTERN = /^[a-z][a-zA-Z0-9]{0,63}$/;

/**
 * The JavaScript prototype-chain property names a slug-shaped regex alone
 * does not exclude. `__proto__` is included because `JSON.parse` can produce
 * it as a genuine OWN enumerable property (registry-names-and-config.test.mjs
 * › "refuses a __proto__ own property supplied through JSON.parse, rather
 * than silently dropping it") - refusing it here, read via `Reflect.ownKeys`
 * before any spread could turn that own property into a prototype
 * assignment instead, is what keeps it from being silently dropped with no
 * issue reported at all.
 */
const CONFIG_KEY_DENY_SET = new Set(['constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']);

const MAX_CONFIG_KEYS = 16;
const MAX_CONFIG_VALUE_LENGTH = 512;

/**
 * The domain's own credential vocabulary - a framework-free mirror of
 * `SECRET_VALUE_PATTERNS` (`.claude/scripts/lib/secrets.mjs`), which the
 * domain cannot import (scoped-domain-contract.test.mjs › "the domain
 * package imports only zod, node:crypto and its own modules"). Kept aligned
 * by a two-way check rather than by this comment alone
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation"): see
 * registry-names-and-config.test.mjs › "every SECRET_VALUE_PATTERNS family is
 * either mirrored by the correspondence corpus or explicitly excluded, with a
 * reason" and › "refuses a config value if and only if findSecretValues
 * flags it, over a shared corpus of credential-shaped and benign values".
 *
 * Mirrors every `SECRET_VALUE_PATTERNS` family except `assigned-secret` - a
 * KEYWORD+SEPARATOR+VALUE construction with its own bounded candidate walk,
 * reproducing which here would be the duplicated-complexity risk
 * `.claude/rules/invariants.md` warns about; the exclusion and its reasoning
 * are recorded once, in registry-names-and-config.test.mjs's
 * `EXCLUDED_SECRET_FAMILIES`.
 *
 * Three domain-only additions the owner's 2026-09-25 ruling names, none of
 * them in `SECRET_VALUE_PATTERNS`: a `Bearer `-prefixed value, `scheme://
 * user:pass@` userinfo, and an AWS STS session key id (`ASIA`-prefixed). See
 * › "refuses a config value carrying a Bearer-prefixed token", › "refuses a
 * config value carrying userinfo (scheme://user:pass@host)" and › "refuses a
 * config value carrying an AWS STS session key id (ASIA-prefixed), asserted
 * directly rather than through findSecretValues".
 *
 * Every pattern is unanchored, so a credential shape is refused wherever it
 * sits in a value, not only at the start - see › "refuses a config value
 * carrying a recognised credential shape embedded anywhere in it, not only at
 * the start". The userinfo pattern is the LINEAR form: the first class
 * excludes `:` so there is only one place the required `:` can match, and the
 * second class excludes `@` so its run and the trailing `@` cannot overlap -
 * the ambiguous `[^/@]*:[^/@]*@` shape this replaced backtracked
 * quadratically over a value with many colons and no closing `@` (see the
 * "Bounded by construction" comment on `SourceBindingConfigSchema` below for
 * the measured rows).
 */
const DOMAIN_SECRET_PATTERNS = [
  /ATATT3x[A-Za-z0-9_\-=]{16,}/, // atlassian-token
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/, // github-pat
  /\bAKIA(?!IOSFODNN7EXAMPLE\b)[A-Z0-9]{16}\b/, // cloud-access-key
  /\bsk-ant-[A-Za-z0-9\-_]{16,}/, // anthropic-key
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, // private-key-block
  /\bxox[baprs]-[A-Za-z0-9-]{16,}/, // slack-token
  /\bAIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/, // google-api-key
  /\b[sr]k_live_[A-Za-z0-9]{16,}/, // stripe-live-key
  /\bsk-proj-[A-Za-z0-9_-]{16,}/, // openai-project-key
  /\bnpm_[A-Za-z0-9]{30,}/, // npm-token
  /\bglpat-[A-Za-z0-9_-]{16,}/, // gitlab-pat
  /\bBearer [A-Za-z0-9\-._~+/]+=*/, // domain-only: Bearer-prefixed value
  /[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@:\s]*:[^/@\s]*@/, // domain-only: scheme://user:pass@ userinfo (linear form)
  /\bASIA[A-Z0-9]{16}\b/, // domain-only: AWS STS session key id
];

/**
 * At most `MAX_CONFIG_VALUE_LENGTH` characters, capped before any pattern
 * reads it - the credential scan never reads past this slice, whatever the
 * candidate's actual length.
 */
const boundedCredentialSlice = (value: string) =>
  value.length > MAX_CONFIG_VALUE_LENGTH ? value.slice(0, MAX_CONFIG_VALUE_LENGTH) : value;

const looksLikeCredential = (value: string) =>
  DOMAIN_SECRET_PATTERNS.some((pattern) => pattern.test(boundedCredentialSlice(value)));

/**
 * A per-adapter config object.
 *
 * Bounded by construction, not by the length of anything it is handed - each
 * ceiling is checked before the work it would otherwise cost is done:
 *
 *   1. more than sixteen keys refuses the whole config without reading a
 *      single key or value - registry-names-and-config.test.mjs › "screens
 *      one thousand keys of 600-character values in under 250ms, and still
 *      refuses the binding";
 *   2. a key is judged by `CONFIG_KEY_PATTERN`, anchored at both ends and
 *      capped at sixty-four characters by its own quantifier, so a key of
 *      any length costs at most sixty-four characters of work;
 *   3. a value's credential screen reads at most `MAX_CONFIG_VALUE_LENGTH`
 *      characters of it, whatever its actual length, before the value's own
 *      length ceiling is even checked - › "screens a single 1 MiB config
 *      value in under 250ms, and still refuses the binding", › "screens
 *      sixteen keys of 40,004-character userinfo-shaped values in under
 *      250ms, and still refuses the binding".
 *
 * Keys are read via `Reflect.ownKeys` on the raw input before anything else
 * touches it, so a `__proto__` own property (as `JSON.parse` produces one) is
 * seen as a key rather than dropped by a spread or a zod-internal copy - ›
 * "refuses a __proto__ own property supplied through JSON.parse, rather than
 * silently dropping it". `CONFIG_KEY_DENY_SET` refuses the other
 * prototype-shadowing names a slug-shaped regex alone would accept - ›
 * "refuses constructor, toString, valueOf, hasOwnProperty and prototype as
 * config keys". A key that is itself slug-shaped is still screened for a
 * credential shape anywhere within it - › "refuses a config key that is
 * itself slug-shaped but reads as a credential anywhere within it".
 *
 * A refused key or value is never echoed into the issue it reports: every
 * issue carries a fixed message and `path: []`, which zod resolves to
 * `['config']` on the parent `SourceBindingSchema` - never the key or value
 * text itself. See › "refuses a credential-shaped config key, and never
 * echoes the refused key into the reported issues" and › "never carries a
 * refused secret-shaped config value into the error".
 */
const SourceBindingConfigSchema = z.unknown().superRefine((value, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message, path: [] });

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail('a SourceBinding config must be a plain object');
    return;
  }

  const keys = Reflect.ownKeys(value).filter((key): key is string => typeof key === 'string');

  if (keys.length > MAX_CONFIG_KEYS) {
    fail('a SourceBinding config carries at most sixteen keys');
    return;
  }

  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (CONFIG_KEY_DENY_SET.has(key)) {
      fail('a SourceBinding config key must not be a JavaScript prototype-chain property name');
      continue;
    }
    if (!CONFIG_KEY_PATTERN.test(key)) {
      fail('a SourceBinding config key must be a camelCase slug of at most sixty-four characters');
      continue;
    }
    if (looksLikeCredential(key)) {
      fail('a SourceBinding config key must not be shaped like a credential');
      continue;
    }

    const rawValue = record[key];
    if (typeof rawValue !== 'string' || rawValue.length < 1 || rawValue.length > MAX_CONFIG_VALUE_LENGTH) {
      fail('a SourceBinding config value must be a non-empty string of at most 512 characters');
      continue;
    }
    if (looksLikeCredential(rawValue)) {
      fail('a SourceBinding config value must not be shaped like a credential');
    }
  }
}) as unknown as z.ZodType<Record<string, string>>;

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
