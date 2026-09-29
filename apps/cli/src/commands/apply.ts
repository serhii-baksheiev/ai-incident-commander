import { randomUUID } from 'node:crypto';

import {
  ActionPolicySchema,
  CredentialRefSchema,
  ServiceInputSchema,
  SourceBindingSchema,
  type RegistrySnapshot,
} from '@aic/domain';
import type { RegistryStore } from '@aic/persistence';
import { parseDocument } from 'yaml';

import { readBoundedRegularFile } from './bounded-file.js';
import { splitAdapterReference } from './registry.js';

/**
 * AIC-99 slice g: `runApplyCommand(argv, deps)` — `aic apply -f <file>
 * [--overwrite] [--dry-run]`, the declarative onboarding manifest the
 * owner's 2026-09-25 ruling fixes as idempotent INPUT, never a source of
 * truth (Jira AIC-99, the 2026-09-25 plan comment).
 *
 * See test/cli-apply.test.mjs for the full pinned manifest schema, entity
 * order, JSON-line shape and field-name vocabulary this module is built
 * against; `infra/postgres/tests/cli-apply.live.mjs` pins the same command
 * end to end through a real registry.
 */

export type ApplyCommandStore = Pick<
  RegistryStore,
  'snapshot' | 'addService' | 'addEnvironment' | 'addCredentialRef' | 'addSourceBinding' | 'setActionPolicy'
>;

export interface ApplyCommandDeps {
  readonly store: ApplyCommandStore;
  readonly stdout: (text: string) => void;
  readonly readManifest?: (path: string) => unknown;
}

type EntityKind = 'service' | 'environment' | 'credential' | 'source' | 'policy';
type Action = 'created' | 'unchanged' | 'drift' | 'updated' | 'unmanaged';

interface ApplyRow {
  readonly action: Action;
  readonly entity: EntityKind;
  readonly service: string | null;
  readonly environment: string | null;
  readonly name: string | null;
  readonly fields: string[];
}

interface ManifestCredential {
  readonly name: string;
  readonly secretName: string;
  readonly access: 'read' | 'write';
}

interface ManifestSource {
  readonly name: string;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly config: Record<string, string>;
  readonly credentialName: string | null;
}

interface ManifestPolicy {
  readonly allow: string[];
  readonly writeCredentials: string[];
}

interface ManifestEnvironment {
  readonly name: string;
  readonly credentials: readonly ManifestCredential[];
  readonly sources: readonly ManifestSource[];
  readonly policy: ManifestPolicy | null;
}

interface ManifestService {
  readonly name: string;
  readonly repositoryAliases: readonly string[];
  readonly environments: readonly ManifestEnvironment[];
}

/* -------------------------------------------------------------------------- */
/* -f <file>: bounded, single-descriptor read (apps/cli/src/commands/         */
/* investigate.ts's readReplayFile pattern, reused over YAML with a 1 MiB     */
/* bound rather than 16 MiB)                                                  */
/* -------------------------------------------------------------------------- */

const MANIFEST_FILE_MAX_BYTES = 1024 * 1024;

function readManifestText(path: string): string {
  return readBoundedRegularFile(path, { flag: '-f', maxBytes: MANIFEST_FILE_MAX_BYTES });
}

/**
 * A YAML refusal — syntax error, duplicate key, or an unresolved tag warning
 * — names only the line and column a real `yaml` `errors`/`warnings` entry
 * carries — never `error.message`, whose own rendering includes a source
 * snippet of the surrounding manifest text. `logLevel: 'error'` turns off
 * `yaml`'s own console logging, so no source line reaches stderr either way;
 * a warning (an unresolved tag) is read as a refusal here, not silently
 * applied with its fallback value.
 * see cli-apply.test.mjs › "invalid YAML syntax is refused naming only the
 * line and column, never the surrounding text"
 * see cli-apply.test.mjs › "an unresolved YAML tag in the manifest, run
 * through the built CLI, exits non-zero and never lets the credential-shaped
 * value or the tag text reach stdout or stderr"
 */
function parseManifestYaml(path: string, text: string): unknown {
  const document = parseDocument(text, { uniqueKeys: true, logLevel: 'error' });
  const issue = [...document.errors, ...document.warnings][0];
  if (issue !== undefined) {
    const position = issue.linePos?.[0];
    const location = position ? ` at line ${position.line}, column ${position.col}` : '';
    throw new Error(`-f file at ${path} is not valid YAML${location}`);
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    if (error instanceof ReferenceError) {
      throw new Error(`-f file at ${path} is not valid YAML: aliases and anchors are not accepted`);
    }
    throw new Error(`-f file at ${path} is not valid YAML`);
  }
}

function readManifestDefault(path: string): unknown {
  return parseManifestYaml(path, readManifestText(path));
}

/* -------------------------------------------------------------------------- */
/* manifest shape + credential screen — all BEFORE any store call            */
/* -------------------------------------------------------------------------- */

function ownRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requireKnownKeys(record: Record<string, unknown>, known: ReadonlySet<string>, label: string): void {
  for (const key of Object.keys(record)) {
    if (!known.has(key)) {
      throw new Error(label === 'manifest' ? 'manifest carries an unrecognised key' : `manifest ${label} carries an unrecognised key`);
    }
  }
}

/**
 * Refuses the first sibling repeat among names in one list — services,
 * environments within a service, credentials within an environment, sources
 * within an environment — before any store call. Never echoes the repeated
 * name itself, only the duplicate's own array index under `label`.
 */
function requireUniqueNames(items: readonly { readonly name: string }[], label: string): void {
  const seen = new Set<string>();
  items.forEach((item, index) => {
    if (seen.has(item.name)) {
      throw new Error(`manifest ${label}[${index}] duplicates the name of an earlier entry`);
    }
    seen.add(item.name);
  });
}

function requireArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`manifest ${label} must be an array`);
  }
  return value;
}

/** The registry's own slug rule (`@aic/domain`'s `SlugSchema`, read off `ServiceInputSchema`), credential-screened already. */
const NameSchema = ServiceInputSchema.shape.name;
const RepositoryAliasesSchema = ServiceInputSchema.shape.repositoryAliases;
const AccessSchema = CredentialRefSchema.shape.access;
const SecretNameSchema = CredentialRefSchema.shape.secretName;
const AllowedActionTypesSchema = ActionPolicySchema.shape.allowedActionTypes;

function requireName(label: string, value: unknown): string {
  const result = NameSchema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `manifest ${label} must be a lowercase, hyphen-separated slug of at most 100 characters that is not shaped like a credential`,
    );
  }
  return result.data;
}

function requireRepositoryAliases(value: unknown): string[] {
  const result = RepositoryAliasesSchema.safeParse(value ?? []);
  if (!result.success) {
    throw new Error('manifest repositoryAliases must be an array of screened strings');
  }
  return result.data;
}

function parseManifestCredential(raw: unknown, label: string): ManifestCredential {
  const record = ownRecord(raw);
  if (record === undefined) throw new Error(`manifest ${label} must be an object`);
  requireKnownKeys(record, KNOWN_CREDENTIAL_KEYS, label);
  const name = requireName(`${label}.name`, record.name);
  const secretResult = SecretNameSchema.safeParse(record.secret);
  if (!secretResult.success) {
    throw new Error(`manifest ${label}.secret must be an UPPERCASE_WITH_UNDERSCORES secret name`);
  }
  const accessResult = AccessSchema.safeParse(record.access);
  if (!accessResult.success) {
    throw new Error(`manifest ${label}.access must be "read" or "write"`);
  }
  return { name, secretName: secretResult.data, access: accessResult.data };
}

function parseAdapter(label: string, raw: unknown): { adapterId: string; adapterVersion: string } {
  if (typeof raw !== 'string') {
    throw new Error(`manifest ${label}.adapter must be a string "<adapterId>@<adapterVersion>"`);
  }
  const split = splitAdapterReference(raw);
  if (split === undefined) {
    throw new Error(`manifest ${label}.adapter must be "<adapterId>@<adapterVersion>"`);
  }
  return split;
}

/**
 * Reuses `@aic/domain`'s own credential screen for a SourceBinding config
 * (`SourceBindingSchema`) rather than a second copy of it
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation") — the
 * same shape `apps/cli/src/commands/registry.ts`'s `assertConfigIsSafe` uses.
 * Every issue the schema raises for `config` carries a fixed message and
 * never echoes the refused key or value, so the thrown message here never
 * does either.
 */
function requireConfig(
  label: string,
  name: string,
  adapterId: string,
  adapterVersion: string,
  raw: unknown,
): Record<string, string> {
  const candidate = {
    id: randomUUID(),
    environmentId: randomUUID(),
    adapterId,
    adapterVersion,
    name,
    config: raw,
    credentialRefId: null,
  };
  const validated = SourceBindingSchema.safeParse(candidate);
  if (!validated.success) {
    throw new Error(`manifest ${label}.config is invalid`);
  }
  return validated.data.config;
}

function parseManifestSource(raw: unknown, label: string): ManifestSource {
  const record = ownRecord(raw);
  if (record === undefined) throw new Error(`manifest ${label} must be an object`);
  requireKnownKeys(record, KNOWN_SOURCE_KEYS, label);
  const name = requireName(`${label}.name`, record.name);
  const { adapterId, adapterVersion } = parseAdapter(label, record.adapter);
  const config = requireConfig(label, name, adapterId, adapterVersion, record.config);
  const credentialName = record.credential === undefined ? null : requireName(`${label}.credential`, record.credential);
  return { name, adapterId, adapterVersion, config, credentialName };
}

function parseManifestPolicy(raw: unknown, label: string): ManifestPolicy {
  const record = ownRecord(raw);
  if (record === undefined) throw new Error(`manifest ${label} must be an object`);
  requireKnownKeys(record, KNOWN_POLICY_KEYS, label);
  const allowResult = AllowedActionTypesSchema.safeParse(record.allow ?? []);
  if (!allowResult.success) {
    throw new Error(`manifest ${label}.allow must be an array of screened strings`);
  }
  const writeCredentialsRaw = requireArray(record.writeCredentials, `${label}.writeCredentials`);
  const writeCredentials = writeCredentialsRaw.map((value, index) =>
    requireName(`${label}.writeCredentials[${index}]`, value),
  );
  return { allow: allowResult.data, writeCredentials };
}

function parseManifestEnvironment(raw: unknown, label: string): ManifestEnvironment {
  const record = ownRecord(raw);
  if (record === undefined) throw new Error(`manifest ${label} must be an object`);
  requireKnownKeys(record, KNOWN_ENVIRONMENT_KEYS, label);
  const name = requireName(`${label}.name`, record.name);
  const credentials = requireArray(record.credentials, `${label}.credentials`).map((entry, index) =>
    parseManifestCredential(entry, `${label}.credentials[${index}]`),
  );
  requireUniqueNames(credentials, `${label}.credentials`);
  const sources = requireArray(record.sources, `${label}.sources`).map((entry, index) =>
    parseManifestSource(entry, `${label}.sources[${index}]`),
  );
  requireUniqueNames(sources, `${label}.sources`);
  const policy = record.policy === undefined ? null : parseManifestPolicy(record.policy, `${label}.policy`);
  return { name, credentials, sources, policy };
}

function parseManifestService(raw: unknown, label: string): ManifestService {
  const record = ownRecord(raw);
  if (record === undefined) throw new Error(`manifest ${label} must be an object`);
  requireKnownKeys(record, KNOWN_SERVICE_KEYS, label);
  const name = requireName(`${label}.name`, record.name);
  const repositoryAliases = requireRepositoryAliases(record.repositoryAliases);
  const environments = requireArray(record.environments, `${label}.environments`).map((entry, index) =>
    parseManifestEnvironment(entry, `${label}.environments[${index}]`),
  );
  requireUniqueNames(environments, `${label}.environments`);
  return { name, repositoryAliases, environments };
}

const KNOWN_TOP_LEVEL_KEYS = new Set(['apiVersion', 'kind', 'services']);
const KNOWN_SERVICE_KEYS = new Set(['name', 'repositoryAliases', 'environments']);
const KNOWN_ENVIRONMENT_KEYS = new Set(['name', 'credentials', 'sources', 'policy']);
const KNOWN_CREDENTIAL_KEYS = new Set(['name', 'secret', 'access']);
const KNOWN_SOURCE_KEYS = new Set(['name', 'adapter', 'config', 'credential']);
const KNOWN_POLICY_KEYS = new Set(['allow', 'writeCredentials']);

function parseManifest(raw: unknown): ManifestService[] {
  const record = ownRecord(raw);
  if (record === undefined) throw new Error('manifest must be a YAML mapping');
  requireKnownKeys(record, KNOWN_TOP_LEVEL_KEYS, 'manifest');
  if (record.apiVersion !== 'aic.onboarding/v1') {
    throw new Error('manifest apiVersion must be "aic.onboarding/v1"');
  }
  if (record.kind !== 'Onboarding') {
    throw new Error('manifest kind must be "Onboarding"');
  }
  const services = requireArray(record.services, 'services').map((entry, index) =>
    parseManifestService(entry, `services[${index}]`),
  );
  requireUniqueNames(services, 'services');
  return services;
}

/* -------------------------------------------------------------------------- */
/* -f / --overwrite / --dry-run                                              */
/* -------------------------------------------------------------------------- */

function requireFileFlag(argv: readonly string[]): string {
  const index = argv.indexOf('-f');
  if (index === -1) {
    throw new Error('-f is required: aic apply -f <file> [--overwrite] [--dry-run]');
  }
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('-f requires a value');
  }
  return value;
}

/* -------------------------------------------------------------------------- */
/* registry comparison: sets rather than ordered lists                       */
/* -------------------------------------------------------------------------- */

function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameConfig(a: Record<string, string>, b: Record<string, string>): boolean {
  const leftKeys = Object.keys(a).sort();
  const rightKeys = Object.keys(b).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => key === rightKeys[index] && a[key] === b[key]);
}

/* -------------------------------------------------------------------------- */
/* runApplyCommand                                                            */
/* -------------------------------------------------------------------------- */

export async function runApplyCommand(
  argv: readonly string[],
  deps: ApplyCommandDeps,
): Promise<{ clean: boolean }> {
  const filePath = requireFileFlag(argv);
  const overwrite = argv.includes('--overwrite');
  const dryRun = argv.includes('--dry-run');

  const readManifest = deps.readManifest ?? readManifestDefault;
  const services = parseManifest(readManifest(filePath));

  const registry: RegistrySnapshot = await deps.store.snapshot();

  const serviceByName = new Map(registry.services.map((service) => [service.name, service] as const));
  const environmentByKey = new Map(
    registry.environments.map((environment) => [`${environment.serviceId}::${environment.name}`, environment] as const),
  );
  const credentialByKey = new Map(
    registry.credentialRefs.map((credential) => [`${credential.environmentId}::${credential.name}`, credential] as const),
  );
  const sourceByKey = new Map(
    registry.sourceBindings.map((source) => [`${source.environmentId}::${source.name}`, source] as const),
  );
  const policyByEnvironmentId = new Map(registry.actionPolicies.map((policy) => [policy.environmentId, policy] as const));
  const credentialNameById = new Map(registry.credentialRefs.map((credential) => [credential.id, credential.name] as const));

  const declaredServiceNames = new Set<string>();
  const declaredEnvironmentKeys = new Set<string>();
  const declaredCredentialKeys = new Set<string>();
  const declaredSourceKeys = new Set<string>();
  const declaredPolicyKeys = new Set<string>();

  const rows: ApplyRow[] = [];

  for (const service of services) {
    declaredServiceNames.add(service.name);
    const existingService = serviceByName.get(service.name);
    if (existingService === undefined) {
      if (!dryRun) {
        await deps.store.addService({ name: service.name, repositoryAliases: service.repositoryAliases });
      }
      rows.push({ action: 'created', entity: 'service', service: service.name, environment: null, name: null, fields: [] });
    } else {
      rows.push({ action: 'unchanged', entity: 'service', service: service.name, environment: null, name: null, fields: [] });
    }

    for (const environment of service.environments) {
      declaredEnvironmentKeys.add(`${service.name}::${environment.name}`);
      const existingEnvironment =
        existingService === undefined ? undefined : environmentByKey.get(`${existingService.id}::${environment.name}`);
      if (existingEnvironment === undefined) {
        if (!dryRun) {
          await deps.store.addEnvironment({ serviceName: service.name, name: environment.name });
        }
        rows.push({
          action: 'created',
          entity: 'environment',
          service: service.name,
          environment: environment.name,
          name: null,
          fields: [],
        });
      } else {
        rows.push({
          action: 'unchanged',
          entity: 'environment',
          service: service.name,
          environment: environment.name,
          name: null,
          fields: [],
        });
      }

      for (const credential of environment.credentials) {
        declaredCredentialKeys.add(`${service.name}::${environment.name}::${credential.name}`);
        const existingCredential =
          existingEnvironment === undefined ? undefined : credentialByKey.get(`${existingEnvironment.id}::${credential.name}`);
        if (existingCredential === undefined) {
          if (!dryRun) {
            await deps.store.addCredentialRef({
              serviceName: service.name,
              environmentName: environment.name,
              name: credential.name,
              access: credential.access,
              secretName: credential.secretName,
            });
          }
          rows.push({
            action: 'created',
            entity: 'credential',
            service: service.name,
            environment: environment.name,
            name: credential.name,
            fields: [],
          });
        } else {
          const fields: string[] = [];
          if (existingCredential.secretName !== credential.secretName) fields.push('secret');
          if (existingCredential.access !== credential.access) fields.push('access');
          fields.sort();
          rows.push({
            action: fields.length === 0 ? 'unchanged' : 'drift',
            entity: 'credential',
            service: service.name,
            environment: environment.name,
            name: credential.name,
            fields,
          });
        }
      }

      for (const source of environment.sources) {
        declaredSourceKeys.add(`${service.name}::${environment.name}::${source.name}`);
        const existingSource =
          existingEnvironment === undefined ? undefined : sourceByKey.get(`${existingEnvironment.id}::${source.name}`);
        if (existingSource === undefined) {
          if (!dryRun) {
            await deps.store.addSourceBinding({
              serviceName: service.name,
              environmentName: environment.name,
              name: source.name,
              adapterId: source.adapterId,
              adapterVersion: source.adapterVersion,
              config: source.config,
              credentialRefName: source.credentialName,
            });
          }
          rows.push({
            action: 'created',
            entity: 'source',
            service: service.name,
            environment: environment.name,
            name: source.name,
            fields: [],
          });
        } else {
          const fields: string[] = [];
          if (existingSource.adapterId !== source.adapterId) fields.push('adapterId');
          if (existingSource.adapterVersion !== source.adapterVersion) fields.push('adapterVersion');
          if (!sameConfig(existingSource.config, source.config)) fields.push('config');
          const existingCredentialName =
            existingSource.credentialRefId === null ? null : credentialNameById.get(existingSource.credentialRefId) ?? null;
          if (existingCredentialName !== source.credentialName) fields.push('credential');
          fields.sort();
          rows.push({
            action: fields.length === 0 ? 'unchanged' : 'drift',
            entity: 'source',
            service: service.name,
            environment: environment.name,
            name: source.name,
            fields,
          });
        }
      }

      if (environment.policy !== null) {
        const policy = environment.policy;
        declaredPolicyKeys.add(`${service.name}::${environment.name}`);
        const existingPolicy =
          existingEnvironment === undefined ? undefined : policyByEnvironmentId.get(existingEnvironment.id);
        if (existingPolicy === undefined) {
          if (!dryRun) {
            await deps.store.setActionPolicy({
              serviceName: service.name,
              environmentName: environment.name,
              allowedActionTypes: policy.allow,
              writeCredentialRefNames: policy.writeCredentials,
            });
          }
          rows.push({
            action: 'created',
            entity: 'policy',
            service: service.name,
            environment: environment.name,
            name: null,
            fields: [],
          });
        } else {
          const existingWriteCredentialNames = existingPolicy.writeCredentialRefIds.map(
            (id) => credentialNameById.get(id) ?? id,
          );
          const fields: string[] = [];
          if (!sameStringSet(existingPolicy.allowedActionTypes, policy.allow)) fields.push('allow');
          if (!sameStringSet(existingWriteCredentialNames, policy.writeCredentials)) fields.push('writeCredentials');
          fields.sort();
          if (fields.length === 0) {
            rows.push({
              action: 'unchanged',
              entity: 'policy',
              service: service.name,
              environment: environment.name,
              name: null,
              fields: [],
            });
          } else if (overwrite) {
            if (!dryRun) {
              await deps.store.setActionPolicy({
                serviceName: service.name,
                environmentName: environment.name,
                allowedActionTypes: policy.allow,
                writeCredentialRefNames: policy.writeCredentials,
              });
            }
            rows.push({
              action: 'updated',
              entity: 'policy',
              service: service.name,
              environment: environment.name,
              name: null,
              fields,
            });
          } else {
            rows.push({
              action: 'drift',
              entity: 'policy',
              service: service.name,
              environment: environment.name,
              name: null,
              fields,
            });
          }
        }
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* unmanaged: present in the registry, absent from the manifest — never     */
  /* removed                                                                  */
  /* ------------------------------------------------------------------------ */

  for (const service of registry.services) {
    if (!declaredServiceNames.has(service.name)) {
      rows.push({ action: 'unmanaged', entity: 'service', service: service.name, environment: null, name: null, fields: [] });
    }
  }
  for (const environment of registry.environments) {
    const owningService = registry.services.find((candidate) => candidate.id === environment.serviceId);
    const serviceName = owningService?.name ?? null;
    const key = serviceName === null ? null : `${serviceName}::${environment.name}`;
    if (key === null || !declaredEnvironmentKeys.has(key)) {
      rows.push({
        action: 'unmanaged',
        entity: 'environment',
        service: serviceName,
        environment: environment.name,
        name: null,
        fields: [],
      });
    }
  }
  for (const credential of registry.credentialRefs) {
    const owningEnvironment = registry.environments.find((candidate) => candidate.id === credential.environmentId);
    const owningService =
      owningEnvironment === undefined
        ? undefined
        : registry.services.find((candidate) => candidate.id === owningEnvironment.serviceId);
    const serviceName = owningService?.name ?? null;
    const environmentName = owningEnvironment?.name ?? null;
    const key = serviceName !== null && environmentName !== null ? `${serviceName}::${environmentName}::${credential.name}` : null;
    if (key === null || !declaredCredentialKeys.has(key)) {
      rows.push({
        action: 'unmanaged',
        entity: 'credential',
        service: serviceName,
        environment: environmentName,
        name: credential.name,
        fields: [],
      });
    }
  }
  for (const source of registry.sourceBindings) {
    const owningEnvironment = registry.environments.find((candidate) => candidate.id === source.environmentId);
    const owningService =
      owningEnvironment === undefined
        ? undefined
        : registry.services.find((candidate) => candidate.id === owningEnvironment.serviceId);
    const serviceName = owningService?.name ?? null;
    const environmentName = owningEnvironment?.name ?? null;
    const key = serviceName !== null && environmentName !== null ? `${serviceName}::${environmentName}::${source.name}` : null;
    if (key === null || !declaredSourceKeys.has(key)) {
      rows.push({
        action: 'unmanaged',
        entity: 'source',
        service: serviceName,
        environment: environmentName,
        name: source.name,
        fields: [],
      });
    }
  }
  for (const policy of registry.actionPolicies) {
    const owningEnvironment = registry.environments.find((candidate) => candidate.id === policy.environmentId);
    const owningService =
      owningEnvironment === undefined
        ? undefined
        : registry.services.find((candidate) => candidate.id === owningEnvironment.serviceId);
    const serviceName = owningService?.name ?? null;
    const environmentName = owningEnvironment?.name ?? null;
    const key = serviceName !== null && environmentName !== null ? `${serviceName}::${environmentName}` : null;
    if (key === null || !declaredPolicyKeys.has(key)) {
      rows.push({
        action: 'unmanaged',
        entity: 'policy',
        service: serviceName,
        environment: environmentName,
        name: null,
        fields: [],
      });
    }
  }

  for (const row of rows) {
    deps.stdout(JSON.stringify(row));
  }

  return { clean: !rows.some((row) => row.action === 'drift') };
}
