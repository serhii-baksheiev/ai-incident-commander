import { randomUUID } from 'node:crypto';

import { IncidentIntakeSchema, checkPrimaryScope, type IncidentIntake, type RegistrySnapshot } from '@aic/domain';

import { parseFlags, requirePositionals, type FlagSpec } from './registry.js';

/**
 * AIC-99 slice f: `runIncidentCommand(argv, deps)` — the argv →
 * `IncidentStore` call mapping for `aic incident start <service> <env>
 * --title <text> [--started-at <iso>] [--external-ref <ref>]
 * [--idempotency-key <key>] [--signal <source>=<statement>]...
 * [--signal-at <iso>]`.
 *
 * `argv` is the `start` subcommand's OWN remainder — `apps/cli/src/index.ts`
 * consumes `incident start` itself before calling this function. See
 * test/cli-incident-command.test.mjs for the full pinned argv/deps/store
 * contract this module is built against.
 */

export interface IncidentCommandStore {
  snapshot(): Promise<RegistrySnapshot>;
  startIncident(
    intake: IncidentIntake,
    opts: { readonly id: string },
  ): Promise<{ readonly incident: unknown; readonly created: boolean }>;
}

export interface IncidentCommandDeps {
  readonly store: IncidentCommandStore;
  readonly stdout: (text: string) => void;
  readonly now: () => string;
  readonly generateId: () => string;
}

const FLAG_SPECS: readonly FlagSpec[] = [
  { name: 'title', repeatable: false },
  { name: 'started-at', repeatable: false },
  { name: 'external-ref', repeatable: false },
  { name: 'idempotency-key', repeatable: false },
  { name: 'signal', repeatable: true },
  { name: 'signal-at', repeatable: false },
];

/**
 * The domain's own ISO-datetime-with-offset shape, read off
 * `IncidentIntakeSchema` rather than restated
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation") — so
 * `--started-at`/`--signal-at` are checked directly, before the intake is
 * even built, and their own refusal names the flag.
 */
const IsoDateTimeSchema = IncidentIntakeSchema.shape.startedAt;

function requireIsoDateTime(flagName: string, value: string): string {
  if (!IsoDateTimeSchema.safeParse(value).success) {
    throw new Error(`--${flagName} must be an ISO-8601 datetime with an offset (e.g. 2026-09-29T10:00:00Z)`);
  }
  return value;
}

interface ParsedSignal {
  readonly source: string;
  readonly statement: string;
}

/** `<source>=<statement>`, split at the FIRST "=" — a statement may itself contain "=". */
function parseSignal(raw: string): ParsedSignal {
  const eq = raw.indexOf('=');
  if (eq === -1) {
    throw new Error('--signal must be "<source>=<statement>"');
  }
  return { source: raw.slice(0, eq), statement: raw.slice(eq + 1) };
}

/**
 * Refuses an intake `IncidentIntakeSchema` itself refuses, BEFORE
 * `startIncident` is ever called — the same "validate with the domain's own
 * schema, never echo the rejected value" shape `assertConfigIsSafe`
 * (`registry.ts`) already uses. Every issue the schema raises for a
 * credential-shaped `title`/`externalRef`/`idempotencyKey`/signal
 * `source`/`statement` carries a fixed message that never echoes the value,
 * so the thrown message here never does either.
 */
function assertIntakeIsSafe(intake: IncidentIntake): void {
  const validated = IncidentIntakeSchema.safeParse(intake);
  if (!validated.success) {
    const detail = validated.error.issues.map((issue) => issue.message).join('; ');
    throw new Error(`incident start is invalid: ${detail}`);
  }
}

interface ResolvedScope {
  readonly serviceId: string;
  readonly environmentId: string;
}

export type IncidentScopeResolution =
  | { readonly ok: true; readonly serviceId: string; readonly environmentId: string }
  | {
      readonly ok: false;
      readonly reason: 'unknown-service' | 'unknown-environment' | 'environment-of-another-service';
    };

/**
 * An `<env>` that names no Environment scoped to `<service>`, but names one
 * belonging to a DIFFERENT Service, is refused naming that mismatch rather
 * than as merely unknown — found by looking up the name ANYWHERE in the
 * registry once the scoped lookup fails, so `checkPrimaryScope` itself
 * decides `unknown-environment` versus `environment-of-another-service`, one
 * mechanism rather than a second re-implementation of its branching.
 *
 * Never throws, and a refusal names no value (AIC-146 slice c4a) — so the
 * upcoming `aic incident investigate` command (slice c4b) can read the same
 * scope resolution `resolveScope` below wraps, without depending on a thrown
 * message meant for `incident start`'s own error text
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 * see cli-shared-pieces.test.mjs › "the refusal result of
 * resolveIncidentScope carries no name: exactly the own keys {ok, reason},
 * nothing else"
 */
export function resolveIncidentScope(
  registry: RegistrySnapshot,
  serviceName: string,
  environmentName: string,
): IncidentScopeResolution {
  const service = registry.services.find((candidate) => candidate.name === serviceName);
  if (!service) {
    return { ok: false, reason: 'unknown-service' };
  }

  const scopedEnvironment = registry.environments.find(
    (candidate) => candidate.serviceId === service.id && candidate.name === environmentName,
  );
  const environmentId =
    scopedEnvironment?.id ?? registry.environments.find((candidate) => candidate.name === environmentName)?.id;

  const check = checkPrimaryScope(registry, {
    serviceId: service.id,
    // No Environment anywhere names environmentName: a fresh, never-matching
    // id reads as "unknown-environment" to checkPrimaryScope, the same
    // outcome as if this scope had never resolved at all — the same
    // fresh-id convention registry-store.ts's own `resolve*` helpers use.
    environmentId: environmentId ?? randomUUID(),
  });
  if (check.ok) {
    return { ok: true, serviceId: service.id, environmentId: check.environment.id };
  }
  if (check.reason === 'unknown-environment') {
    return { ok: false, reason: 'unknown-environment' };
  }
  // 'environment-of-another-service' (checkPrimaryScope never reports
  // 'unknown-service' here, since `service` above was already found).
  return { ok: false, reason: 'environment-of-another-service' };
}

/** Maps `resolveIncidentScope`'s refusal to `incident start`'s existing, byte-identical error messages. */
function resolveScope(registry: RegistrySnapshot, serviceName: string, environmentName: string): ResolvedScope {
  const result = resolveIncidentScope(registry, serviceName, environmentName);
  if (result.ok) {
    return { serviceId: result.serviceId, environmentId: result.environmentId };
  }
  switch (result.reason) {
    case 'unknown-service':
      throw new Error(`unknown service "${serviceName}"`);
    case 'unknown-environment':
      throw new Error(`unknown environment "${environmentName}"`);
    case 'environment-of-another-service':
      throw new Error(`environment "${environmentName}" belongs to a different service than "${serviceName}" names`);
  }
}

export async function runIncidentCommand(argv: readonly string[], deps: IncidentCommandDeps): Promise<void> {
  const { positionals, flags } = parseFlags(argv, FLAG_SPECS);
  const [serviceName, environmentName] = requirePositionals(positionals, ['service', 'env']);

  const titleValues = flags.get('title');
  if (titleValues === undefined) {
    throw new Error('--title is required: incident start <service> <env> --title <text>');
  }
  const title = titleValues[0];

  const startedAtOverride = flags.get('started-at')?.[0];
  if (startedAtOverride !== undefined) {
    requireIsoDateTime('started-at', startedAtOverride);
  }

  const signalAtOverride = flags.get('signal-at')?.[0];
  if (signalAtOverride !== undefined) {
    requireIsoDateTime('signal-at', signalAtOverride);
  }

  const parsedSignals = (flags.get('signal') ?? []).map(parseSignal);

  const externalRef = flags.get('external-ref')?.[0];
  const idempotencyKey = flags.get('idempotency-key')?.[0];

  const registry = await deps.store.snapshot();
  const scope = resolveScope(registry, serviceName, environmentName);

  const startedAt = startedAtOverride ?? deps.now();

  const intake: IncidentIntake = {
    primaryScope: { serviceId: scope.serviceId, environmentId: scope.environmentId },
    title,
    startedAt,
    signals: parsedSignals.map((signal) => ({
      source: signal.source,
      statement: signal.statement,
      observedAt: signalAtOverride ?? startedAt,
    })),
    ...(externalRef !== undefined ? { externalRef } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
  };

  assertIntakeIsSafe(intake);

  const result = await deps.store.startIncident(intake, { id: deps.generateId() });
  deps.stdout(JSON.stringify({ incident: result.incident, created: result.created }));
}
