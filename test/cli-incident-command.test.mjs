/**
 * AIC-99 slice f: `runIncidentCommand(argv, deps)`
 * (`apps/cli/src/commands/incident.ts`) — the argv → `IncidentStore` call
 * mapping for `aic incident start <service> <env> --title <text>
 * [--started-at <iso>] [--external-ref <ref>] [--idempotency-key <key>]
 * [--signal <source>=<statement>]... [--signal-at <iso>]`.
 *
 * No database here: `deps.store` is a fake recording every call, so this
 * file pins argv parsing and the success/error/stdout contract only.
 * `infra/postgres/tests/incident-store.live.mjs` pins `createIncidentStore`'s
 * own transactional behaviour against a real PostgreSQL. The connection
 * variable is never named under `test/` (postgres-checkpointer.test.mjs ›
 * "keeps the database-backed lane out of npm test and npm run check").
 *
 * ## Design choices this file pins
 *
 *   - `argv` passed to `runIncidentCommand` is the `start` subcommand's OWN
 *     remainder — `apps/cli/src/index.ts` consumes `incident start` itself
 *     (the same nested-dispatch shape it already uses for `dev spike` and
 *     `source check`) before calling `runIncidentCommand([<service>, <env>,
 *     ...flags], deps)`. `incident` has exactly one subcommand, unlike
 *     `service`/`env`/`source`, which is why this file does not repeat the
 *     multi-subcommand `requireSubcommand` shape those nouns use.
 *   - `deps.store` carries BOTH `snapshot()` (to resolve `<service>`/`<env>`
 *     names to ids, the same registry a `RegistryStore` reads) and
 *     `startIncident(intake, { id })` (to actually start it) — one narrow
 *     interface a caller composes from a `RegistryStore` and the
 *     `IncidentStore` `@aic/persistence` exports, rather than two separate
 *     `deps` fields this module would have to thread through independently.
 *   - `deps.now(): string` and `deps.generateId(): string` are the clock and
 *     id-generator seams: `--started-at`'s absence defaults to `deps.now()`,
 *     and the id `startIncident` is called with is always `deps.generateId()`
 *     — never a value the CLI invents from argv.
 *   - a signal's `observedAt` defaults to the resolved `startedAt`
 *     (`--started-at` or `deps.now()`) unless `--signal-at` is given, in
 *     which case EVERY signal in the call gets that one value: one flag
 *     naming one instant for the whole batch is the simplest form that lets
 *     an operator record signals observed before the incident started.
 *   - `<service>`/`<env>` are screened by the same
 *     `requireRegistryName`/slug rule `apps/cli/src/commands/registry.ts`
 *     already uses, imported from that module rather than re-implemented,
 *     before `deps.store.snapshot()` is ever called.
 *   - name resolution against the snapshot: a `<service>` that names no
 *     Service is refused as "unknown service"; an `<env>` that names no
 *     Environment of that Service, but names one belonging to a DIFFERENT
 *     Service, is refused as belonging to a different service (found via
 *     `@aic/domain`'s `checkPrimaryScope`, fed a real environment id found by
 *     name ANYWHERE in the registry once the scoped lookup fails, so
 *     `checkPrimaryScope` itself decides `unknown-environment` versus
 *     `environment-of-another-service` — one mechanism, not a second
 *     re-implementation of its branching); an `<env>` that names no
 *     Environment anywhere is refused as "unknown environment". None of the
 *     three ever calls `startIncident`.
 *   - the fully-built intake (after scope resolution) is validated with
 *     `@aic/domain`'s `IncidentIntakeSchema.safeParse` before `startIncident`
 *     is ever called — the same "validate with the domain's own schema,
 *     never echo the rejected value" shape
 *     `apps/cli/src/commands/registry.ts`'s `assertConfigIsSafe` already
 *     uses for `SourceBindingSchema` — which is what makes a credential-shaped
 *     `--title`/`--external-ref`/`--idempotency-key`/signal `source` or
 *     `statement` refused without an echo: see
 *     test/incident-intake-credential-screen.test.mjs for that screen's own
 *     domain-level rows.
 *   - `--started-at` and `--signal-at` are also checked directly against the
 *     ISO-datetime-with-offset shape before the intake is even built, so
 *     their own refusal names the flag rather than surfacing only as a
 *     generic schema-validation failure.
 *   - success prints exactly one line to `deps.stdout`:
 *     `{"incident": <startIncident's own incident>, "created": true|false}` —
 *     for both a fresh start and a deduplicated one, exit 0 either way (no
 *     `process.exitCode` is touched by this module, the same convention
 *     every other registry command in this slice follows).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

/** A github-pat shape, assembled at runtime — never written as one contiguous literal (`.claude/rules/autonomy.md`). */
const pastedSecret = () => ['ghp', 'B'.repeat(28)].join('_');

function loadIncidentCommand() {
  return import('../apps/cli/dist/commands/incident.js');
}

function createStdoutSink() {
  const lines = [];
  return { stdout: (text) => lines.push(text), lines };
}

const serviceCheckoutId = randomUUID();
const environmentCheckoutStagingId = randomUUID();
const serviceBillingId = randomUUID();
const environmentBillingStagingId = randomUUID();
const serviceReportingId = randomUUID();

/**
 * Three Services: "checkout" and "billing" each have their OWN Environment
 * named "staging" (deliberately the same name under two different Services),
 * and "reporting" has no Environment at all — so a row below can ask for
 * `reporting staging` and get an Environment that exists, but only under a
 * different Service, distinct from `checkout nowhere`, where the name exists
 * under no Service at all.
 */
function registrySnapshotFixture() {
  return {
    services: [
      { id: serviceCheckoutId, name: 'checkout', repositoryAliases: [] },
      { id: serviceBillingId, name: 'billing', repositoryAliases: [] },
      { id: serviceReportingId, name: 'reporting', repositoryAliases: [] },
    ],
    environments: [
      { id: environmentCheckoutStagingId, serviceId: serviceCheckoutId, name: 'staging' },
      { id: environmentBillingStagingId, serviceId: serviceBillingId, name: 'staging' },
    ],
    sourceBindings: [],
    credentialRefs: [],
    actionPolicies: [],
  };
}

function createFakeStore(overrides = {}) {
  const calls = [];
  const store = {
    snapshot: async () => {
      calls.push({ method: 'snapshot', args: undefined });
      if (overrides.snapshot) return overrides.snapshot();
      return registrySnapshotFixture();
    },
    startIncident: async (intake, opts) => {
      calls.push({ method: 'startIncident', args: { intake, opts } });
      if (overrides.startIncident) return overrides.startIncident(intake, opts);
      return { incident: { id: opts.id, ...intake }, created: true };
    },
  };
  return { store, calls };
}

const FIXED_NOW = '2026-09-29T12:00:00.000Z';
const FIXED_ID = 'incident-fixed-id-1';

function baseDeps(overrides = {}) {
  const { store, calls } = createFakeStore(overrides.storeOverrides ?? {});
  const { stdout, lines } = createStdoutSink();
  return {
    deps: {
      store,
      stdout,
      now: () => FIXED_NOW,
      generateId: () => FIXED_ID,
      ...overrides.deps,
    },
    calls,
    lines,
  };
}

/* -------------------------------------------------------------------------- */
/* Happy path                                                                  */
/* -------------------------------------------------------------------------- */

test('incident start <service> <env> --title <text> resolves names to ids, defaults startedAt to deps.now(), and calls startIncident with the derived intake', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await incident.runIncidentCommand(['checkout', 'staging', '--title', 'Checkout failures'], deps);

  const startCall = calls.find((call) => call.method === 'startIncident');
  assert.ok(startCall, 'startIncident must have been called');
  assert.deepEqual(startCall.args.intake, {
    primaryScope: { serviceId: serviceCheckoutId, environmentId: environmentCheckoutStagingId },
    title: 'Checkout failures',
    startedAt: FIXED_NOW,
    signals: [],
  });
  assert.deepEqual(startCall.args.opts, { id: FIXED_ID });
  assert.equal(lines.length, 1, 'success must write exactly one line to stdout');
  assert.deepEqual(JSON.parse(lines[0]), {
    incident: { id: FIXED_ID, ...startCall.args.intake },
    created: true,
  });
});

test('--started-at overrides deps.now(), and a --signal with no --signal-at defaults its observedAt to that same startedAt', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls } = baseDeps();

  await incident.runIncidentCommand(
    [
      'checkout',
      'staging',
      '--title',
      'Checkout failures',
      '--started-at',
      '2026-09-29T09:30:00Z',
      '--signal',
      'pagerduty=checkout error rate spike',
    ],
    deps,
  );

  const startCall = calls.find((call) => call.method === 'startIncident');
  assert.equal(startCall.args.intake.startedAt, '2026-09-29T09:30:00Z');
  assert.deepEqual(startCall.args.intake.signals, [
    { source: 'pagerduty', statement: 'checkout error rate spike', observedAt: '2026-09-29T09:30:00Z' },
  ]);
});

test('--signal is repeatable, split at the FIRST "=" so a statement may itself contain "=", and --signal-at overrides every signal\'s observedAt at once', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls } = baseDeps();

  await incident.runIncidentCommand(
    [
      'checkout',
      'staging',
      '--title',
      'Checkout failures',
      '--signal',
      'pagerduty=checkout error rate spike',
      '--signal',
      'datadog=p99 latency > 2s, threshold=1.5s',
      '--signal-at',
      '2026-09-29T09:45:00Z',
    ],
    deps,
  );

  const startCall = calls.find((call) => call.method === 'startIncident');
  assert.deepEqual(startCall.args.intake.signals, [
    { source: 'pagerduty', statement: 'checkout error rate spike', observedAt: '2026-09-29T09:45:00Z' },
    { source: 'datadog', statement: 'p99 latency > 2s, threshold=1.5s', observedAt: '2026-09-29T09:45:00Z' },
  ]);
});

test('--external-ref and --idempotency-key are passed through to the intake', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls } = baseDeps();

  await incident.runIncidentCommand(
    [
      'checkout',
      'staging',
      '--title',
      'Checkout failures',
      '--external-ref',
      'pagerduty:incident-123',
      '--idempotency-key',
      'checkout-prod-run-one',
    ],
    deps,
  );

  const startCall = calls.find((call) => call.method === 'startIncident');
  assert.equal(startCall.args.intake.externalRef, 'pagerduty:incident-123');
  assert.equal(startCall.args.intake.idempotencyKey, 'checkout-prod-run-one');
});

test('a deduplicated start (store reports created: false) still prints one line naming created: false, and never throws', async () => {
  const incident = await loadIncidentCommand();
  const firstIncident = { id: 'incident-real-id', primaryScope: {}, title: 'first', startedAt: FIXED_NOW, signals: [] };
  const { deps, lines } = baseDeps({ storeOverrides: { startIncident: async () => ({ incident: firstIncident, created: false }) } });

  await incident.runIncidentCommand(['checkout', 'staging', '--title', 'Checkout failures'], deps);

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), { incident: firstIncident, created: false });
});

/* -------------------------------------------------------------------------- */
/* Scope resolution refusals                                                  */
/* -------------------------------------------------------------------------- */

test('a <service> that names no Service is refused as unknown, and startIncident is never called', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () => incident.runIncidentCommand(['ghost', 'staging', '--title', 'x'], deps),
    /unknown service/i,
  );
  assert.equal(calls.some((call) => call.method === 'startIncident'), false);
  assert.equal(lines.length, 0);
});

test('an <env> that names no Environment anywhere is refused as unknown, and startIncident is never called', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'nowhere', '--title', 'x'], deps),
    /unknown environment/i,
  );
  assert.equal(calls.some((call) => call.method === 'startIncident'), false);
  assert.equal(lines.length, 0);
});

test('an <env> that exists only under a DIFFERENT Service is refused naming that mismatch, not as merely unknown, and startIncident is never called', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  // "staging" exists under "checkout" and "billing", but not under
  // "reporting" — this must read as "belongs to a different service", not
  // "unknown environment", since checkPrimaryScope can tell the two apart
  // once it is handed the real environment id staging resolves to elsewhere.
  await assert.rejects(
    () => incident.runIncidentCommand(['reporting', 'staging', '--title', 'x'], deps),
    (error) => {
      assert.match(error.message, /different service|another service/i);
      assert.doesNotMatch(error.message, /^unknown environment/i);
      return true;
    },
  );
  assert.equal(calls.some((call) => call.method === 'startIncident'), false);
  assert.equal(lines.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Parse errors: before any store call                                        */
/* -------------------------------------------------------------------------- */

test('a missing <env> positional is refused, names the missing argument, and calls no store method at all (not even snapshot)', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(() => incident.runIncidentCommand(['checkout'], deps), /env/i);
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('a missing --title is refused, and calls no store method at all', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(() => incident.runIncidentCommand(['checkout', 'staging'], deps), /--title/);
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('an unknown flag is refused by name, and calls no store method at all', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', 'x', '--bogus-flag', 'y'], deps),
    /--bogus-flag/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('a single-valued flag given twice (--title) is refused by name, and calls no store method at all', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', 'a', '--title', 'b'], deps),
    /--title/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('an extra positional argument is refused, and calls no store method at all', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', 'extra', '--title', 'x'], deps),
    /extra|positional|argument/i,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('a --signal with no "=" is refused naming --signal, and calls no store method at all', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', 'x', '--signal', 'pagerduty-only'], deps),
    /--signal/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('a non-ISO --started-at is refused naming --started-at, and calls no store method at all', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', 'x', '--started-at', 'not-a-date'], deps),
    /--started-at/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

test('a non-ISO --signal-at is refused naming --signal-at, and calls no store method at all', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();

  await assert.rejects(
    () =>
      incident.runIncidentCommand(
        ['checkout', 'staging', '--title', 'x', '--signal', 'pagerduty=spike', '--signal-at', 'not-a-date'],
        deps,
      ),
    /--signal-at/,
  );
  assert.deepEqual(calls, []);
  assert.equal(lines.length, 0);
});

/* -------------------------------------------------------------------------- */
/* Refusals never reproduce the operator's own token                          */
/* -------------------------------------------------------------------------- */

test('a service or environment name that is not a registry slug is refused before any store call, with a bounded message that does not reproduce it', async () => {
  const incident = await loadIncidentCommand();
  const hostileNames = ['x'.repeat(200_000), `checkout\n\u001b[2Kaic: {"created":false}`, 'Checkout'];
  for (const hostile of hostileNames) {
    const { deps, calls, lines } = baseDeps();
    await assert.rejects(
      () => incident.runIncidentCommand([hostile, 'staging', '--title', 'x'], deps),
      (error) => {
        assert.ok(error.message.length < 400, `bounded message, got ${error.message.length} characters`);
        assert.ok(!error.message.includes(hostile), 'the refusal must not reproduce the hostile name');
        assert.ok(!error.message.includes('\u001b'), 'no terminal escape reaches the message');
        return true;
      },
    );
    assert.deepEqual(calls, [], 'a non-slug service/environment name must never reach any store method');
    assert.equal(lines.length, 0);
  }
});

test('a credential-shaped --title is refused before startIncident is ever called, and the refusal never echoes it', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();
  const secret = pastedSecret();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', secret], deps),
    (error) => {
      assert.ok(!error.message.includes(secret), `the refusal must never echo the credential-shaped title: ${error.message}`);
      return true;
    },
  );
  assert.equal(calls.some((call) => call.method === 'startIncident'), false);
  assert.equal(lines.length, 0);
});

test('a credential-shaped --external-ref is refused before startIncident is ever called, and the refusal never echoes it', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();
  const secret = pastedSecret();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', 'x', '--external-ref', secret], deps),
    (error) => {
      assert.ok(!error.message.includes(secret), `the refusal must never echo the credential-shaped externalRef: ${error.message}`);
      return true;
    },
  );
  assert.equal(calls.some((call) => call.method === 'startIncident'), false);
  assert.equal(lines.length, 0);
});

test('a credential-shaped --idempotency-key is refused before startIncident is ever called, and the refusal never echoes it', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();
  const secret = pastedSecret();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', 'x', '--idempotency-key', secret], deps),
    (error) => {
      assert.ok(!error.message.includes(secret), `the refusal must never echo the credential-shaped idempotencyKey: ${error.message}`);
      return true;
    },
  );
  assert.equal(calls.some((call) => call.method === 'startIncident'), false);
  assert.equal(lines.length, 0);
});

test('a credential-shaped signal statement is refused before startIncident is ever called, and the refusal never echoes it', async () => {
  const incident = await loadIncidentCommand();
  const { deps, calls, lines } = baseDeps();
  const secret = pastedSecret();

  await assert.rejects(
    () => incident.runIncidentCommand(['checkout', 'staging', '--title', 'x', '--signal', `pagerduty=${secret}`], deps),
    (error) => {
      assert.ok(!error.message.includes(secret), `the refusal must never echo the credential-shaped signal statement: ${error.message}`);
      return true;
    },
  );
  assert.equal(calls.some((call) => call.method === 'startIncident'), false);
  assert.equal(lines.length, 0);
});
