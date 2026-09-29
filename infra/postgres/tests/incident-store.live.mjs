/**
 * AIC-99 slice f — the half of `createIncidentStore` that needs a real
 * database: `startIncident` actually storing `incidentFromIntake(intake,
 * {id})` keyed by its derived idempotency key, a second start with the same
 * derived key actually returning the FIRST row unchanged rather than a
 * second one, `checkPrimaryScope` actually refusing an intake whose
 * `primaryScope` names an unknown Service, an unknown Environment, or an
 * Environment belonging to a different Service (validated against a registry
 * snapshot read INSIDE `startIncident`'s own transaction — a caller-side
 * check, like the CLI's, is a courtesy; this is the authority), a concurrent
 * race on the same derived key actually leaving one row, and that an
 * Incident survives its owning Service being removed — migration 3's
 * `incidents` table carries no foreign key to `services`/`environments`
 * (`app-schema.ts`), exactly as `registry-store.live.mjs`'s own audit-table
 * row already proves for a row seeded directly with SQL; this file adds the
 * one case that row cannot cover — a row written through
 * `createIncidentStore` itself, with a real derived idempotency key and a
 * real `incidentFromIntake` body, going through the public API end to end.
 *
 * The half decidable WITHOUT a database — `IncidentIntakeSchema`,
 * `deriveIdempotencyKey`, `incidentFromIntake`, `checkPrimaryScope` — is
 * pinned in test/incident-intake-idempotency.test.mjs and
 * test/incident-intake-credential-screen.test.mjs, and migration 3's own SQL
 * shape (the `incidents` table already exists, unmodified by this slice) in
 * test/registry-schema.test.mjs.
 *
 * Copied in shape and convention from the sibling
 * `infra/postgres/tests/registry-store.live.mjs` — see that file's header
 * for "why this file is not under `test/`", "it refuses; it never skips",
 * and "independent verification" (raw SQL against the store's own pool,
 * never through the methods under test). Not repeated here in full.
 *
 * ## How to run it
 *
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml up --detach --wait
 *   AIC_POSTGRES_URL=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres
 *   AIC_POSTGRES_HOST_PORT=5433 docker compose \
 *     --file infra/postgres/compose.yaml down
 *
 * ## Design choices this file pins
 *
 *   - `createIncidentStore` takes an already-open `pg.Pool`, the same
 *     overload shape `createRegistryStore` uses (this file builds its own
 *     `Pool` from `AIC_POSTGRES_URL` and passes it to both stores).
 *   - a `primaryScope` that `checkPrimaryScope` refuses (`unknown-service`,
 *     `unknown-environment`, `environment-of-another-service`) is refused
 *     with a new named error, `IncidentScopeError`, carrying `.reason` as
 *     one of those three exact strings — never a bare database error, and
 *     never a `RegistryValidationError`/`RegistryConflictError`: an Incident
 *     is not a `RegistrySnapshot` mutation, so neither existing registry
 *     error class is the right shape for this refusal to carry.
 *   - a second `startIncident` call with the same DERIVED idempotency key
 *     (whether from an explicit `idempotencyKey`, the same `externalRef`, or
 *     falling into the same intake window) returns the exact incident the
 *     FIRST call stored, `created: false` — including its `id`, which is the
 *     first call's `{ id }` even when the second call is given a different
 *     one. `startIncident` never overwrites the stored row.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import { Pool } from 'pg';

import * as persistence from '@aic/persistence';

const CONNECTION_VARIABLE = 'AIC_POSTGRES_URL';

const START_THE_SUBSTRATE = `set ${CONNECTION_VARIABLE} to a PostgreSQL connection string, e.g.

  AIC_POSTGRES_HOST_PORT=5433 docker compose --file infra/postgres/compose.yaml up --detach --wait
  ${CONNECTION_VARIABLE}=postgresql://aic@127.0.0.1:5433/aic npm run test:live-postgres

This lane refuses rather than skipping: it is the only place createIncidentStore's
transactional idempotency, scope refusal and concurrency behaviour are measured
against a real PostgreSQL, so a skip would report them as met.`;

function requireConnectionString() {
  const value = process.env[CONNECTION_VARIABLE];
  assert.equal(typeof value === 'string' && value.trim() !== '', true, START_THE_SUBSTRATE);
  return value;
}

/**
 * A store pair against a freshly (idempotently) provisioned `aic_app`
 * schema, with every registry and incident table truncated, and the pool
 * closed at the end of the row — copied in shape from
 * registry-store.live.mjs's own `freshRegistryStore`.
 */
async function freshStores(t) {
  const connectionString = requireConnectionString();
  await persistence.setupApplicationSchema(connectionString);
  const pool = new Pool({ connectionString });
  t.after(async () => {
    await pool.end();
  });
  await pool.query(
    `truncate table aic_app.registry_events, aic_app.incidents, aic_app.action_policies,
       aic_app.source_bindings, aic_app.credential_refs, aic_app.environments, aic_app.services
     restart identity cascade`,
  );
  const registryStore = persistence.createRegistryStore(pool);
  const incidentStore = persistence.createIncidentStore(pool);
  return { registryStore, incidentStore, pool };
}

async function seedScope(registryStore, serviceName, environmentName) {
  const service = await registryStore.addService({ name: serviceName, repositoryAliases: [] });
  const environment = await registryStore.addEnvironment({ serviceName, name: environmentName });
  return { serviceId: service.id, environmentId: environment.id };
}

function buildIntake(scope, overrides = {}) {
  return {
    primaryScope: scope,
    title: 'Checkout failures',
    startedAt: '2026-09-29T10:00:00Z',
    signals: [{ source: 'pagerduty', statement: 'checkout error rate spike', observedAt: '2026-09-29T10:00:00Z' }],
    ...overrides,
  };
}

async function incidentRowCount(pool) {
  const { rows } = await pool.query('select count(*)::int as n from aic_app.incidents');
  return rows[0].n;
}

/* -------------------------------------------------------------------------- */
/* Refuses rather than skips                                                  */
/* -------------------------------------------------------------------------- */

test('refuses to run without a PostgreSQL connection string instead of skipping', () => {
  const connectionString = requireConnectionString();
  assert.equal(
    /^postgres(?:ql)?:\/\//.test(connectionString),
    true,
    `${CONNECTION_VARIABLE} must be a PostgreSQL connection string; its scheme is "${connectionString.split(':')[0]}", which would fail later and further from the cause`,
  );
});

/* -------------------------------------------------------------------------- */
/* Export surface: createIncidentStore and IncidentScopeError exist          */
/* -------------------------------------------------------------------------- */

test('createIncidentStore and IncidentScopeError are exported from @aic/persistence', () => {
  assert.equal(typeof persistence.createIncidentStore, 'function', '@aic/persistence must export createIncidentStore');
  assert.equal(typeof persistence.IncidentScopeError, 'function', '@aic/persistence must export IncidentScopeError');
});

/* -------------------------------------------------------------------------- */
/* Created, then deduplicated: same derived key -> one row, same id          */
/* -------------------------------------------------------------------------- */

test('startIncident stores a fresh Incident with created: true, and a second call with the same derived key returns the FIRST incident unchanged with created: false, leaving exactly one row', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const scope = await seedScope(registryStore, 'checkout', 'staging');
  const intake = buildIntake(scope, { externalRef: 'pagerduty:incident-123' });

  const first = await incidentStore.startIncident(intake, { id: 'incident-first' });
  assert.equal(first.created, true, 'the first start of a fresh derived key must be created: true');
  assert.equal(first.incident.id, 'incident-first');

  const second = await incidentStore.startIncident(intake, { id: 'incident-second' });
  assert.equal(second.created, false, 'a second start with the same derived key must report created: false');
  assert.deepEqual(
    second.incident,
    first.incident,
    'a deduplicated start must return the FIRST incident unchanged, including its original id, never the second call\'s own id',
  );

  assert.equal(await incidentRowCount(pool), 1, 'exactly one aic_app.incidents row must exist after the duplicate start');
});

/* -------------------------------------------------------------------------- */
/* Two different explicit idempotencyKeys -> two rows                        */
/* -------------------------------------------------------------------------- */

test('two starts with different explicit idempotencyKeys in the same scope create two separate rows', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const scope = await seedScope(registryStore, 'checkout', 'staging');

  const first = await incidentStore.startIncident(buildIntake(scope, { idempotencyKey: 'run-one' }), {
    id: 'incident-run-one',
  });
  const secondResult = await incidentStore.startIncident(buildIntake(scope, { idempotencyKey: 'run-two' }), {
    id: 'incident-run-two',
  });

  assert.equal(first.created, true);
  assert.equal(secondResult.created, true, 'a different explicit idempotencyKey must never be treated as a duplicate');
  assert.notEqual(first.incident.id, secondResult.incident.id);
  assert.equal(await incidentRowCount(pool), 2, 'two distinct idempotencyKeys must leave exactly two rows');
});

/* -------------------------------------------------------------------------- */
/* An unknown/removed scope is refused, and nothing is stored                */
/* -------------------------------------------------------------------------- */

test('startIncident refuses an intake whose primaryScope names an unknown Service, and stores nothing', async (t) => {
  const { incidentStore, pool } = await freshStores(t);
  const scope = { serviceId: randomUUID(), environmentId: randomUUID() };

  await assert.rejects(
    () => incidentStore.startIncident(buildIntake(scope), { id: 'incident-unknown-service' }),
    (error) => {
      assert.equal(error.name, 'IncidentScopeError');
      assert.equal(error.reason, 'unknown-service');
      return true;
    },
  );
  assert.equal(await incidentRowCount(pool), 0, 'a refused start must store no row');
});

test('startIncident refuses an intake whose primaryScope names a known Service but an unknown Environment, and stores nothing', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const service = await registryStore.addService({ name: 'checkout', repositoryAliases: [] });
  const scope = { serviceId: service.id, environmentId: randomUUID() };

  await assert.rejects(
    () => incidentStore.startIncident(buildIntake(scope), { id: 'incident-unknown-environment' }),
    (error) => {
      assert.equal(error.name, 'IncidentScopeError');
      assert.equal(error.reason, 'unknown-environment');
      return true;
    },
  );
  assert.equal(await incidentRowCount(pool), 0, 'a refused start must store no row');
});

test('startIncident refuses an intake whose Environment belongs to a DIFFERENT Service than primaryScope.serviceId names, and stores nothing', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const checkout = await seedScope(registryStore, 'checkout', 'staging');
  const billing = await registryStore.addService({ name: 'billing', repositoryAliases: [] });
  const scope = { serviceId: billing.id, environmentId: checkout.environmentId };

  await assert.rejects(
    () => incidentStore.startIncident(buildIntake(scope), { id: 'incident-cross-scope' }),
    (error) => {
      assert.equal(error.name, 'IncidentScopeError');
      assert.equal(error.reason, 'environment-of-another-service');
      return true;
    },
  );
  assert.equal(await incidentRowCount(pool), 0, 'a refused start must store no row');
});

test('startIncident refuses an intake whose Environment was removed since it was read, and stores nothing', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const scope = await seedScope(registryStore, 'checkout', 'staging');
  await registryStore.removeEnvironment({ serviceName: 'checkout', environmentName: 'staging' });

  await assert.rejects(
    () => incidentStore.startIncident(buildIntake(scope), { id: 'incident-removed-environment' }),
    (error) => {
      assert.equal(error.name, 'IncidentScopeError');
      assert.equal(error.reason, 'unknown-environment');
      return true;
    },
  );
  assert.equal(await incidentRowCount(pool), 0, 'a refused start must store no row');
});

/* -------------------------------------------------------------------------- */
/* Concurrent starts with the same derived key: exactly one row, both calls  */
/* return the same incident                                                  */
/* -------------------------------------------------------------------------- */

test('concurrent startIncident calls with the same derived idempotency key leave exactly one row, and both calls return the same incident', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const scope = await seedScope(registryStore, 'checkout', 'staging');
  const intake = buildIntake(scope, { idempotencyKey: 'race-key' });

  const [first, second] = await Promise.all([
    incidentStore.startIncident(intake, { id: 'incident-race-a' }),
    incidentStore.startIncident(intake, { id: 'incident-race-b' }),
  ]);

  assert.deepEqual(
    first.incident,
    second.incident,
    'both concurrent calls racing on the same derived key must return the exact same incident',
  );
  assert.equal(
    [first.created, second.created].filter(Boolean).length,
    1,
    'exactly one of the two concurrent calls must report created: true, the other created: false',
  );
  assert.equal(await incidentRowCount(pool), 1, 'exactly one row must exist after the race, never two');
});

/* -------------------------------------------------------------------------- */
/* An Incident survives removal of its own Service                          */
/* -------------------------------------------------------------------------- */

/**
 * registry-store.live.mjs's own "removeService cascades..." row already
 * proves, for a row seeded directly with SQL, that `removeService` never
 * touches `aic_app.incidents` — this row adds the one thing that one cannot
 * cover: a row written through `createIncidentStore` itself, with its own
 * real derived idempotency key and `incidentFromIntake` body, surviving
 * `removeService` end to end.
 */
test('an Incident started through createIncidentStore survives its owning Service being removed', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const scope = await seedScope(registryStore, 'checkout', 'staging');
  const { incident } = await incidentStore.startIncident(buildIntake(scope, { idempotencyKey: 'survives-removal' }), {
    id: 'incident-survives-removal',
  });

  await registryStore.removeService({ serviceName: 'checkout' });

  const { rows } = await pool.query('select id from aic_app.incidents where id = $1', [incident.id]);
  assert.equal(rows.length, 1, 'the Incident row must survive removeService, since aic_app.incidents carries no foreign key to services/environments');
});

test('startIncident itself refuses an intake the domain schema refuses, whatever the caller checked, and stores nothing', async (t) => {
  const { registryStore, incidentStore, pool } = await freshStores(t);
  const scope = await seedScope(registryStore, 'checkout', 'prod');
  // A credential SHAPE, assembled at runtime rather than written as a literal.
  const pasted = ['ghp', 'B'.repeat(28)].join('_');
  for (const overrides of [{ title: `rotate ${pasted}` }, { startedAt: 'yesterday' }]) {
    await assert.rejects(
      () => incidentStore.startIncident(buildIntake(scope, overrides), { id: randomUUID() }),
      /incident intake is invalid/,
    );
  }
  assert.equal(await incidentRowCount(pool), 0, 'a refused intake must store no row');
});
