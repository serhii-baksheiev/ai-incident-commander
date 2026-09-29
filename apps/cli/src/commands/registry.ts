import { randomUUID } from 'node:crypto';

import { ServiceInputSchema, SourceBindingSchema } from '@aic/domain';
import { APP_SCHEMA_VERSION, type RegistryStore } from '@aic/persistence';

/**
 * AIC-99 slice d: `runRegistryCommand(noun, argv, deps)` — the argv →
 * `RegistryStore` call mapping for `service`, `env`, `credential`, `source`
 * (its `add` subcommand), `policy` (its `set` subcommand), and
 * `runRegistryCommand('db', ['migrate'], deps)` for `aic db migrate`.
 *
 * `argv` is the noun's OWN remainder (`apps/cli/src/index.ts`'s
 * `nextPositional` slicing), never the whole process argv. See
 * test/cli-registry-commands.test.mjs for the full argv/store/stdout
 * contract this module is built against.
 */

export interface RegistryCommandDeps {
  readonly store?: RegistryStore;
  readonly stdout: (text: string) => void;
  readonly setupApplicationSchema?: (connectionString: string) => Promise<void>;
  readonly connectionString?: string;
}

interface StoreDeps {
  readonly store: RegistryStore;
  readonly stdout: (text: string) => void;
}

function writeJsonLine(stdout: (text: string) => void, value: unknown): void {
  stdout(JSON.stringify(value));
}

/**
 * Names "subcommand" as the problem whether the subcommand is missing or
 * merely unrecognised — the noun ITSELF is implemented in this slice, so
 * `apps/cli/src/index.ts`'s existing "not implemented" stub wording must
 * never be what a bare or bad subcommand sees.
 */
function requireSubcommand(noun: string, argv: readonly string[], allowed: readonly string[]): string {
  const [sub] = argv;
  if (sub === undefined) {
    throw new Error(`aic ${noun} requires a subcommand: one of ${allowed.join(', ')}`);
  }
  if (!allowed.includes(sub)) {
    throw new Error(`aic ${noun} got an unknown subcommand; expected one of: ${allowed.join(', ')}`);
  }
  return sub;
}

/**
 * The registry's own slug rule for Service, Environment, CredentialRef and
 * SourceBinding names (`@aic/domain`), read through `ServiceInputSchema`
 * rather than restated. A name is checked here, before any store call, so a
 * refusal never has to reproduce an unbounded or unprintable argv token.
 */
const RegistryNameSchema = ServiceInputSchema.shape.name;

export function requireRegistryName(label: string, value: string): string {
  if (!RegistryNameSchema.safeParse(value).success) {
    throw new Error(
      `<${label}> must be a lowercase, hyphen-separated slug of at most 100 characters that is not shaped like a credential`,
    );
  }
  return value;
}

/**
 * Exported so a sibling command — `incident.ts` — reuses this SAME
 * positional/slug-screening rule rather than a second copy of it
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 */
export function requirePositionals(positionals: readonly string[], names: readonly string[]): string[] {
  if (positionals.length < names.length) {
    throw new Error(`missing required argument <${names[positionals.length]}>`);
  }
  if (positionals.length > names.length) {
    throw new Error(`unexpected extra positional argument at position ${names.length + 1}`);
  }
  return positionals.map((value, index) => requireRegistryName(names[index], value));
}

/** A flag name is echoed only when it is itself short and plain. */
const ECHOABLE_FLAG_NAME = /^[a-z][a-z-]{0,39}$/;

/**
 * An unknown flag's name is echoed only when it is short, lowercase and
 * hyphenated AND passes the registry's own name rule, whose credential
 * screen refuses lowercase members of the repository's secret vocabulary
 * (`sk-ant-…`, `xoxb-…`, `glpat-…`) — one screen, not a second list.
 */
function isEchoableFlagName(name: string): boolean {
  return ECHOABLE_FLAG_NAME.test(name) && RegistryNameSchema.safeParse(name).success;
}

export interface FlagSpec {
  readonly name: string;
  readonly repeatable: boolean;
}

export interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string[]>;
}

/**
 * A strict `--flag value` reader: an undeclared flag, or a non-repeatable
 * flag given twice, is refused by name before any store method is ever
 * called. Unlike `node:util`'s `parseArgs`, every declared flag here takes
 * exactly one value, so no separate "which token is a value" inference is
 * needed.
 *
 * Stated limits: there is no `--` escape, so a flag value that itself begins
 * with `--` is refused as a missing value. An unknown flag whose name is
 * short, lowercase and hyphenated is named in the refusal — see
 * cli-registry-commands.test.mjs › "an unknown flag is refused by name,
 * writes nothing to stdout, and never calls the store" — unless the name is
 * credential-shaped, which is refused without an echo — see › "an unknown
 * flag whose name is itself credential-shaped is refused without reproducing
 * it, even though it is lowercase and hyphenated".
 *
 * Exported so a sibling command — `incident.ts` — reuses this SAME flag
 * reader rather than a second copy of it (`.claude/rules/invariants.md`,
 * "one mechanism, one implementation").
 */
export function parseFlags(args: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
  const specByName = new Map(specs.map((spec) => [spec.name, spec] as const));
  const flags = new Map<string, string[]>();
  const positionals: string[] = [];
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token.startsWith('--')) {
      const name = token.slice(2);
      const spec = specByName.get(name);
      if (spec === undefined) {
        throw new Error(isEchoableFlagName(name) ? `unknown flag --${name}` : 'unknown flag');
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`--${name} requires a value`);
      }
      const existing = flags.get(name);
      if (existing !== undefined && !spec.repeatable) {
        throw new Error(`--${name} may be given at most once`);
      }
      flags.set(name, existing === undefined ? [value] : [...existing, value]);
      index += 2;
    } else {
      positionals.push(token);
      index += 1;
    }
  }
  return { positionals, flags };
}

async function runServiceCommand(argv: readonly string[], deps: StoreDeps): Promise<void> {
  const sub = requireSubcommand('service', argv, ['add', 'remove']);
  const rest = argv.slice(1);
  if (sub === 'add') {
    const { positionals, flags } = parseFlags(rest, [{ name: 'repository-alias', repeatable: true }]);
    const [name] = requirePositionals(positionals, ['service']);
    const repositoryAliases = flags.get('repository-alias') ?? [];
    const result = await deps.store.addService({ name, repositoryAliases });
    writeJsonLine(deps.stdout, result);
    return;
  }
  const { positionals } = parseFlags(rest, []);
  const [name] = requirePositionals(positionals, ['service']);
  await deps.store.removeService({ serviceName: name });
  writeJsonLine(deps.stdout, { removed: { service: name } });
}

async function runEnvCommand(argv: readonly string[], deps: StoreDeps): Promise<void> {
  const sub = requireSubcommand('env', argv, ['add', 'remove']);
  const rest = argv.slice(1);
  const { positionals } = parseFlags(rest, []);
  const [service, environment] = requirePositionals(positionals, ['service', 'environment']);
  if (sub === 'add') {
    const result = await deps.store.addEnvironment({ serviceName: service, name: environment });
    writeJsonLine(deps.stdout, result);
    return;
  }
  await deps.store.removeEnvironment({ serviceName: service, environmentName: environment });
  writeJsonLine(deps.stdout, { removed: { service, environment } });
}

async function runCredentialCommand(argv: readonly string[], deps: StoreDeps): Promise<void> {
  requireSubcommand('credential', argv, ['add']);
  const rest = argv.slice(1);
  const { positionals, flags } = parseFlags(rest, [
    { name: 'secret', repeatable: false },
    { name: 'access', repeatable: false },
  ]);
  const [service, environment, name] = requirePositionals(positionals, ['service', 'environment', 'name']);

  const secretValues = flags.get('secret');
  if (secretValues === undefined) {
    throw new Error('--secret is required: credential add <service> <env> <name> --secret <SECRET_NAME>');
  }
  const secretName = secretValues[0];

  const access = flags.get('access')?.[0] ?? 'read';
  if (access !== 'read' && access !== 'write') {
    throw new Error('--access must be "read" or "write"');
  }

  const result = await deps.store.addCredentialRef({
    serviceName: service,
    environmentName: environment,
    name,
    access,
    secretName,
  });
  writeJsonLine(deps.stdout, result);
}

/**
 * Splits `<adapterId>@<adapterVersion>` at exactly one `@`, both halves
 * non-empty; `undefined` otherwise. The one rule `source add --adapter` and a
 * manifest source's `adapter` share.
 */
export function splitAdapterReference(raw: string): { adapterId: string; adapterVersion: string } | undefined {
  const parts = raw.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined;
  return { adapterId: parts[0], adapterVersion: parts[1] };
}

/**
 * `--adapter <id>@<version>` split at exactly one `@`, with both halves
 * non-empty. Refused before any store method is called — see
 * test/cli-registry-commands.test.mjs's malformed-adapter row.
 */
function parseAdapter(raw: string): { adapterId: string; adapterVersion: string } {
  const split = splitAdapterReference(raw);
  if (split === undefined) {
    throw new Error('--adapter must be "<adapterId>@<adapterVersion>"');
  }
  return split;
}

/**
 * `--config key=value`, split at the FIRST `=` — a value may itself carry `=`.
 * The record has no prototype, so `__proto__` lands as an own key and reaches
 * `SourceBindingSchema`'s prototype-key refusal instead of being swallowed by
 * `Object.prototype`'s setter. A key given twice is refused, like a repeated
 * single-valued flag.
 */
function parseConfig(values: readonly string[]): Record<string, string> {
  const config: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq === -1) {
      throw new Error('--config must be "key=value"');
    }
    const key = raw.slice(0, eq);
    if (Object.hasOwn(config, key)) {
      throw new Error('--config sets the same key twice');
    }
    config[key] = raw.slice(eq + 1);
  }
  return config;
}

/**
 * Refuses a credential-shaped `--config` value BEFORE `addSourceBinding` is
 * ever called, over the exact same vocabulary `@aic/domain`'s
 * `SourceBindingSchema` already screens a config object with
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation") —
 * rather than a second, hand-written credential-shape regex here. The
 * `id`/`environmentId`/`credentialRefId` fields are placeholders solely to
 * satisfy the schema's shape; only `config` (and, incidentally, `name`,
 * `adapterId`, `adapterVersion`) are the caller's own values. Every issue
 * `SourceBindingSchema` raises for `config` carries a fixed message and never
 * echoes the refused key or value, so the thrown message here never does
 * either.
 */
function assertConfigIsSafe(name: string, adapterId: string, adapterVersion: string, config: Record<string, string>): void {
  const candidate = {
    id: randomUUID(),
    environmentId: randomUUID(),
    adapterId,
    adapterVersion,
    name,
    config,
    credentialRefId: null,
  };
  const validated = SourceBindingSchema.safeParse(candidate);
  if (!validated.success) {
    const detail = validated.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`source add is invalid: ${detail}`);
  }
}

async function runSourceCommand(argv: readonly string[], deps: StoreDeps): Promise<void> {
  requireSubcommand('source', argv, ['add']);
  const rest = argv.slice(1);
  const { positionals, flags } = parseFlags(rest, [
    { name: 'adapter', repeatable: false },
    { name: 'config', repeatable: true },
    { name: 'credential', repeatable: false },
  ]);
  const [service, environment, name] = requirePositionals(positionals, ['service', 'environment', 'name']);

  const adapterValues = flags.get('adapter');
  if (adapterValues === undefined) {
    throw new Error('--adapter is required: source add <service> <env> <name> --adapter <adapterId>@<adapterVersion>');
  }
  const { adapterId, adapterVersion } = parseAdapter(adapterValues[0]);
  const config = parseConfig(flags.get('config') ?? []);
  assertConfigIsSafe(name, adapterId, adapterVersion, config);

  const credentialValue = flags.get('credential')?.[0];
  const credentialRefName = credentialValue === undefined ? null : requireRegistryName('credential', credentialValue);

  const result = await deps.store.addSourceBinding({
    serviceName: service,
    environmentName: environment,
    name,
    adapterId,
    adapterVersion,
    // A plain record for the store: the prototype-free one existed only so
    // validation could see every key, and `__proto__` has been refused above.
    config: { ...config },
    credentialRefName,
  });
  writeJsonLine(deps.stdout, result);
}

async function runPolicyCommand(argv: readonly string[], deps: StoreDeps): Promise<void> {
  requireSubcommand('policy', argv, ['set']);
  const rest = argv.slice(1);
  const { positionals, flags } = parseFlags(rest, [
    { name: 'allow', repeatable: true },
    { name: 'write-credential', repeatable: true },
  ]);
  const [service, environment] = requirePositionals(positionals, ['service', 'environment']);

  const result = await deps.store.setActionPolicy({
    serviceName: service,
    environmentName: environment,
    allowedActionTypes: flags.get('allow') ?? [],
    writeCredentialRefNames: (flags.get('write-credential') ?? []).map((value) => requireRegistryName('write-credential', value)),
  });
  writeJsonLine(deps.stdout, result);
}

async function runDbCommand(argv: readonly string[], deps: RegistryCommandDeps): Promise<void> {
  const [sub] = argv;
  if (sub !== 'migrate') {
    throw new Error('aic db requires a known subcommand; the only known db subcommand is migrate');
  }
  if (deps.setupApplicationSchema === undefined || deps.connectionString === undefined) {
    throw new Error('aic db migrate is misconfigured: no setupApplicationSchema/connectionString were provided');
  }
  await deps.setupApplicationSchema(deps.connectionString);
  writeJsonLine(deps.stdout, { migrated: { schemaVersion: APP_SCHEMA_VERSION } });
}

export async function runRegistryCommand(
  noun: string,
  argv: readonly string[],
  deps: RegistryCommandDeps,
): Promise<void> {
  if (noun === 'db') {
    await runDbCommand(argv, deps);
    return;
  }

  if (deps.store === undefined) {
    throw new Error(`aic ${noun}: no registry store was configured`);
  }
  const storeDeps: StoreDeps = { store: deps.store, stdout: deps.stdout };

  switch (noun) {
    case 'service':
      await runServiceCommand(argv, storeDeps);
      return;
    case 'env':
      await runEnvCommand(argv, storeDeps);
      return;
    case 'credential':
      await runCredentialCommand(argv, storeDeps);
      return;
    case 'source':
      await runSourceCommand(argv, storeDeps);
      return;
    case 'policy':
      await runPolicyCommand(argv, storeDeps);
      return;
    default:
      throw new Error(`unknown registry noun: ${noun}`);
  }
}
