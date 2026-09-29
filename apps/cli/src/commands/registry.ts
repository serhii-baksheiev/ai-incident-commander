import { randomUUID } from 'node:crypto';

import { SourceBindingSchema } from '@aic/domain';
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
    throw new Error(`aic ${noun} has no subcommand "${sub}"; expected one of: ${allowed.join(', ')}`);
  }
  return sub;
}

function requirePositionals(positionals: readonly string[], names: readonly string[]): string[] {
  if (positionals.length < names.length) {
    throw new Error(`missing required argument <${names[positionals.length]}>`);
  }
  if (positionals.length > names.length) {
    throw new Error(`unexpected extra positional argument: ${positionals[names.length]}`);
  }
  return [...positionals];
}

interface FlagSpec {
  readonly name: string;
  readonly repeatable: boolean;
}

interface ParsedArgs {
  readonly positionals: string[];
  readonly flags: Map<string, string[]>;
}

/**
 * A strict `--flag value` reader: an undeclared flag, or a non-repeatable
 * flag given twice, is refused by name before any store method is ever
 * called. Unlike `node:util`'s `parseArgs`, every declared flag here takes
 * exactly one value, so no separate "which token is a value" inference is
 * needed.
 */
function parseFlags(args: readonly string[], specs: readonly FlagSpec[]): ParsedArgs {
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
        throw new Error(`unknown flag --${name}`);
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
    throw new Error(`--access must be "read" or "write", got ${JSON.stringify(access)}`);
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
 * `--adapter <id>@<version>` split at exactly one `@`, with both halves
 * non-empty. Refused before any store method is called — see
 * test/cli-registry-commands.test.mjs's malformed-adapter row.
 */
function parseAdapter(raw: string): { adapterId: string; adapterVersion: string } {
  const parts = raw.split('@');
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') {
    throw new Error(`--adapter must be "<adapterId>@<adapterVersion>", got ${JSON.stringify(raw)}`);
  }
  return { adapterId: parts[0], adapterVersion: parts[1] };
}

/** `--config key=value`, split at the FIRST `=` — a value may itself carry `=`. */
function parseConfig(values: readonly string[]): Record<string, string> {
  const config: Record<string, string> = {};
  for (const raw of values) {
    const eq = raw.indexOf('=');
    if (eq === -1) {
      throw new Error(`--config must be "key=value", got ${JSON.stringify(raw)}`);
    }
    config[raw.slice(0, eq)] = raw.slice(eq + 1);
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

  const credentialRefName = flags.get('credential')?.[0] ?? null;

  const result = await deps.store.addSourceBinding({
    serviceName: service,
    environmentName: environment,
    name,
    adapterId,
    adapterVersion,
    config,
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
    writeCredentialRefNames: flags.get('write-credential') ?? [],
  });
  writeJsonLine(deps.stdout, result);
}

async function runDbCommand(argv: readonly string[], deps: RegistryCommandDeps): Promise<void> {
  const [sub] = argv;
  if (sub !== 'migrate') {
    throw new Error(`aic db has no subcommand "${sub ?? ''}"; the only known db subcommand is migrate`);
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
