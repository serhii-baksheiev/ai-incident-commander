/**
 * AIC-55: the development persistence substrate moves from SQLite to a
 * PostgreSQL checkpointer, before Safe Operations, without changing graph or
 * domain semantics.
 *
 * This file is the half of that acceptance set that is decidable WITHOUT a
 * database: what the checkpointer is built with, what schema it declares, what
 * the manifest pins, and which layers may name the checkpointer's storage at
 * all. The half that needs a real PostgreSQL — a run that executes, is
 * interrupted, and resumes in a FRESH PROCESS — cannot be decided here and
 * lives on its own line, `npm run test:live-postgres`; the last row below is
 * what keeps that line out of `npm test` and `npm run check`.
 *
 * Two things this file deliberately does NOT do:
 *
 *   - it does not connect. Every row builds the checkpointer against a
 *     connection string pointing at a closed loopback port, which is safe
 *     because `pg.Pool` is lazy: measured, a freshly constructed pool reports
 *     `totalCount === 0` and issues nothing until the first `connect()`. Two
 *     rows below turn that laziness from an assumption into an assertion.
 *   - it does not re-test the own-value serde. That behaviour is pinned in
 *     `test/checkpoint-serde-own-values.test.mjs`; the single row here asks the
 *     narrower question AIC-55 introduces — whether the NEW checkpointer is
 *     wired to it at all, or silently ships the library default.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { MemorySaver } from '@langchain/langgraph-checkpoint';

import * as persistence from '@aic/persistence';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A connection string that resolves and never answers: port 1 on loopback.
 *
 * Nothing here dials it, and that is the point — a row that started connecting
 * by accident would fail loudly on this address instead of quietly reaching
 * whatever PostgreSQL the developer happens to be running.
 */
const UNREACHABLE_CONNECTION_STRING = 'postgresql://aic@127.0.0.1:1/aic_checkpointer';

/** The tables the checkpointer library owns, as it names them in its SQL. */
const CHECKPOINTER_TABLES = [
  'checkpoints',
  'checkpoint_blobs',
  'checkpoint_writes',
  'checkpoint_migrations',
];

/**
 * The environment variable the database-backed lane reads its connection string
 * from, assembled rather than written out.
 *
 * The last row scans the whole of `test/` for this name, and a literal here
 * would make that scan report its own scanner. Assembling it is the same move
 * `test/child-process-environment.test.mjs` makes for a credential shape, for
 * the same reason: the file has to name a thing it is also looking for.
 */
const CONNECTION_VARIABLE = ['AIC', 'POSTGRES', 'URL'].join('_');

/** Where the database-backed lane lives, and why it is not under `test/`. */
const LIVE_LANE_SCRIPT = 'test:live-postgres';
const LIVE_LANE_FILE = 'infra/postgres/tests/postgres-checkpointer.live.mjs';

/**
 * The factory, fetched through the namespace rather than a named import.
 *
 * A named `import { createPostgresCheckpointer }` of an export that does not
 * exist is a link-time error, and a link-time error takes the WHOLE file down —
 * including the manifest and boundary rows, which have nothing to do with it.
 * Through the namespace each row fails on its own, saying what is missing.
 */
function checkpointerFactory() {
  assert.equal(
    typeof persistence.createPostgresCheckpointer,
    'function',
    '@aic/persistence must export createPostgresCheckpointer(connectionString) — the single place this repository builds a PostgreSQL checkpointer, the way createSqliteCheckpointer is the single place it builds a SQLite one',
  );
  return persistence.createPostgresCheckpointer;
}

/**
 * Builds a checkpointer and registers its pool for shutdown.
 *
 * `await` rather than a bare call: it works whether the factory is synchronous
 * or asynchronous, so the rows below pin BEHAVIOUR (nothing reaches the
 * database) rather than a calling convention nobody asked for.
 */
async function buildCheckpointer(t) {
  const saver = await checkpointerFactory()(UNREACHABLE_CONNECTION_STRING);
  t.after(async () => {
    await saver?.pool?.end?.();
  });
  return saver;
}

/** The pg pool the checkpointer owns, asserted rather than assumed. */
function poolOf(saver) {
  assert.equal(
    typeof saver?.pool,
    'object',
    'the checkpointer must expose the pg Pool it owns: the pool is what this suite watches for connections, and what a process has to close on the way out',
  );
  return saver.pool;
}

/* -------------------------------------------------------------------------- */
/* Row 1 — the serde AIC-93 added must travel to the new backend               */
/* -------------------------------------------------------------------------- */

/** The field the whole ownership boundary was measured on, in the sibling file. */
const POLLUTED_FIELD = 'humanReview';
const DECLARED_VALUE = true;
const SUBSTITUTED_VALUE = false;

/**
 * The gadget the repaired serde exists for: an inherited setter that answers the
 * deserializer's assignment by DEFINING the attacker's value as a genuine own
 * data property, so no ownership check downstream can see the substitution.
 *
 * Copied in shape from `test/checkpoint-serde-own-values.test.mjs` ›
 * "keeps the own value the serialized form declares when an inherited setter
 * writes another", which is where the gadget's variants and the serde's limits
 * are pinned. Here it is one probe with one job: tell a wrapped serde from an
 * unwrapped one.
 */
function armOwnWritingGadget(field = POLLUTED_FIELD) {
  Object.defineProperty(Object.prototype, field, {
    configurable: true,
    get() {
      return SUBSTITUTED_VALUE;
    },
    set() {
      Object.defineProperty(this, field, {
        value: SUBSTITUTED_VALUE,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    },
  });
}

/** Round-trips one declared value through `serde` with the gadget armed. */
async function loadUnderGadget(serde) {
  assert.equal(
    POLLUTED_FIELD in {},
    false,
    `the prototype is already carrying ${POLLUTED_FIELD} before this row started: an earlier row leaked it`,
  );
  const [type, data] = await serde.dumpsTyped({
    control: { [POLLUTED_FIELD]: DECLARED_VALUE },
  });
  try {
    armOwnWritingGadget();
    return await serde.loadsTyped(type, data);
  } finally {
    delete Object.prototype[POLLUTED_FIELD];
  }
}

test('builds the PostgreSQL checkpointer with the own-value serde, not the library default', async (t) => {
  const saver = await buildCheckpointer(t);

  // The control first, so a green row cannot mean "the gadget stopped working".
  // `MemorySaver` carries the library's default serde — the same default
  // `PostgresSaver.fromConnString` hands back, because it passes no serde
  // argument (measured in the installed 1.0.5: `new PostgresSaver(new Pool(...),
  // void 0, options)`). If this half ever stops substituting, the half below
  // proves nothing.
  const unwrapped = await loadUnderGadget(new MemorySaver().serde);
  assert.equal(
    unwrapped.control[POLLUTED_FIELD],
    SUBSTITUTED_VALUE,
    'the probe is no longer discriminating: an unwrapped serde kept the declared value, so the assertion below would pass for a checkpointer that wires no repair at all',
  );

  const loaded = await loadUnderGadget(saver.serde);
  assert.equal(
    loaded.control[POLLUTED_FIELD],
    DECLARED_VALUE,
    'the PostgreSQL checkpointer loaded the gadget\'s value where the serialized form declared another: the AIC-93 own-value repair is not wired into this backend, so moving the substrate off SQLite silently gives up that protection',
  );
  assert.equal(
    Object.hasOwn(loaded.control, POLLUTED_FIELD),
    true,
    'the repaired value must be the run\'s OWN property, since an inherited one is exactly what the graph\'s refusal sites read as absent',
  );
});

/* -------------------------------------------------------------------------- */
/* Rows 2 and 3 — construction touches nothing; setup is what touches          */
/* -------------------------------------------------------------------------- */

test('opens no connection and issues no statement while the checkpointer is being built', async (t) => {
  const saver = await buildCheckpointer(t);
  const pool = poolOf(saver);

  assert.deepEqual(
    { totalCount: pool.totalCount, idleCount: pool.idleCount, waitingCount: pool.waitingCount },
    { totalCount: 0, idleCount: 0, waitingCount: 0 },
    'building the checkpointer created a pg client: construction must not reach the database, and `connect()` increments totalCount synchronously (measured), so a floating setup() promise cannot hide behind this counter',
  );

  // The counters say no client was created; the spy says no call was even
  // attempted. Both, because they fail differently: a counter can be reset, and
  // a spy that is never reached reports nothing.
  //
  // The prototype is reached THROUGH the pool this factory built rather than by
  // importing `pg`, which is a transitive dependency of this workspace and not
  // one it declares. Same object either way: `pg` is installed once at the
  // repository root (measured), so the library and this file would patch the
  // same prototype — the difference is only that this way cannot silently start
  // watching a second copy.
  const poolPrototype = Object.getPrototypeOf(pool);
  const attempts = [];
  const realConnect = poolPrototype.connect;
  const realQuery = poolPrototype.query;
  poolPrototype.connect = function spyConnect() {
    attempts.push('connect');
    throw new Error('a test refused this connection attempt');
  };
  poolPrototype.query = function spyQuery(text) {
    attempts.push(`query ${String(text).slice(0, 60)}`);
    throw new Error('a test refused this statement');
  };

  let second;
  try {
    second = await buildCheckpointer(t);
  } finally {
    poolPrototype.connect = realConnect;
    poolPrototype.query = realQuery;
  }

  assert.deepEqual(
    attempts,
    [],
    'building the checkpointer reached the database: schema creation and migration belong to the explicit setup() step, and a factory that runs them turns every construction — including one in a test, a CLI --help, or a process that only reads — into a schema mutation',
  );
  assert.equal(
    typeof second?.setup,
    'function',
    'the second checkpointer was not built at all, so the empty attempt list above says nothing',
  );
});

test('reaches the database when setup runs, so the untouched-pool row above is not vacuous', async (t) => {
  const saver = await buildCheckpointer(t);
  const poolPrototype = Object.getPrototypeOf(poolOf(saver));
  const attempts = [];
  const realConnect = poolPrototype.connect;
  poolPrototype.connect = function spyConnect() {
    attempts.push('connect');
    throw new Error('a test refused this connection attempt');
  };

  try {
    await assert.rejects(
      async () => saver.setup(),
      'setup() resolved without ever asking the pool for a client: then "construction issues no query" is a claim about a step that does nothing, and nothing in this file distinguishes an explicit setup from an absent one',
    );
  } finally {
    poolPrototype.connect = realConnect;
  }

  assert.deepEqual(
    attempts,
    ['connect'],
    'setup() must be the step that reaches the database — it is the one that runs CREATE SCHEMA and the migrations, and acceptance row 5 asks for it to be explicit rather than implied by first use',
  );
});

test('exposes setup as a step of its own, distinct from construction', async (t) => {
  const saver = await buildCheckpointer(t);

  assert.equal(
    typeof saver.setup,
    'function',
    'setup() must be callable on the checkpointer this repository builds: an operator provisioning a new database has no other explicit, version-pinned step to run',
  );
  assert.equal(
    saver.setup.length,
    0,
    'setup() must take no arguments — everything it needs (the pool, the schema) is decided where the checkpointer is built, so a caller cannot provision a schema the checkpointer does not read',
  );
});

/* -------------------------------------------------------------------------- */
/* Rows 4 and 5 — the checkpointer schema is separate, and spelled once        */
/* -------------------------------------------------------------------------- */

test('declares a checkpointer schema that is neither public nor the application schema', async (t) => {
  const { CHECKPOINTER_SCHEMA, APPLICATION_SCHEMA } = persistence;

  for (const [name, value] of [
    ['CHECKPOINTER_SCHEMA', CHECKPOINTER_SCHEMA],
    ['APPLICATION_SCHEMA', APPLICATION_SCHEMA],
  ]) {
    assert.equal(
      typeof value,
      'string',
      `@aic/persistence must export ${name}: the two schema names are a fact two artifacts encode — the checkpointer's options and every operator command — and a second spelling is the one that goes stale`,
    );
    // The library interpolates the schema straight into `CREATE SCHEMA IF NOT
    // EXISTS "<schema>"` and into every statement (measured in 1.0.5's
    // `sql.js`); it is not a bound parameter. A plain lowercase identifier is
    // the shape that carries nothing to interpolate.
    assert.match(
      value,
      /^[a-z][a-z0-9_]*$/,
      `${name} must be a plain lowercase SQL identifier: the checkpointer library interpolates it into DDL unquoted-escaped, so anything else is a string that reaches the database as syntax`,
    );
  }

  assert.equal(
    APPLICATION_SCHEMA,
    'aic_app',
    'the application schema is named aic_app by the acceptance row this file covers; renaming it here would leave the row it cites describing a different database',
  );
  assert.notEqual(
    CHECKPOINTER_SCHEMA,
    'public',
    'the checkpointer must not live in public: that is the library default, and it puts LangGraph\'s tables in the same namespace as everything else the database ever grows',
  );
  assert.notEqual(
    CHECKPOINTER_SCHEMA,
    APPLICATION_SCHEMA,
    'the checkpointer schema and the application schema must differ — one name for both makes "checkpointer schema lives separately from aic_app" true only by wording',
  );

  const saver = await buildCheckpointer(t);
  assert.equal(
    saver.options?.schema,
    CHECKPOINTER_SCHEMA,
    'the checkpointer was built without the declared schema, so the constant describes an intention and the tables land wherever the library defaults to',
  );
});

test('qualifies every checkpointer table with the checkpointer schema', async (t) => {
  const { CHECKPOINTER_SCHEMA } = persistence;
  const saver = await buildCheckpointer(t);
  const statements = saver.SQL_STATEMENTS;

  assert.equal(
    typeof statements,
    'object',
    'the checkpointer must expose the statements it will run: without them this row can only re-read the option it was given, which is the thing that would be wrong',
  );

  // Asking the statements rather than the option is what makes this row
  // independent of row 4: the option is what we passed in, the SQL is what the
  // database will actually be told. Measured against the installed 1.0.5 — with
  // the right schema this finds 0 unqualified names across the 9 statements,
  // and with `public` or `aic_app` in its place it finds 11.
  const unqualified = [];
  for (const [name, sql] of Object.entries(statements)) {
    for (const table of CHECKPOINTER_TABLES) {
      const pattern = new RegExp(
        String.raw`(?<!"${CHECKPOINTER_SCHEMA}"\.)(?<!["\w])${table}\b`,
        'g',
      );
      for (const match of String(sql).matchAll(pattern)) {
        unqualified.push(`${name}: …${String(sql).slice(Math.max(0, match.index - 24), match.index + table.length)}`);
      }
    }
  }

  assert.deepEqual(
    unqualified,
    [],
    `every checkpointer table must be qualified with "${CHECKPOINTER_SCHEMA}": an unqualified name resolves through search_path at runtime, which is how checkpointer tables end up beside the application's own`,
  );
});

/* -------------------------------------------------------------------------- */
/* Row 6 — the pin                                                            */
/* -------------------------------------------------------------------------- */

test('pins the PostgreSQL checkpointer dependency to an exact version', () => {
  const manifestPath = resolve(projectRoot, 'packages/persistence/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const dependencies = manifest.dependencies ?? {};

  assert.equal(
    dependencies['@langchain/langgraph-checkpoint-postgres'],
    '1.0.5',
    'the PostgreSQL checkpointer must be pinned to exactly 1.0.5: acceptance row 5 asks for a version-pinned setup(), and setup() is where the schema and the migration sequence are decided — a range lets a `npm install` on another machine run a different migration set against the same database',
  );

  // The style claim, measured rather than asserted in prose: the SQLite
  // checkpointer beside it is pinned with no range operator either.
  for (const name of [
    '@langchain/langgraph-checkpoint-postgres',
    '@langchain/langgraph-checkpoint-sqlite',
  ]) {
    assert.match(
      String(dependencies[name]),
      /^\d+\.\d+\.\d+$/,
      `${name} must carry a bare version with no ^ or ~: both checkpointers decide an on-disk schema, and a range is a schema change that arrives without a commit`,
    );
  }
});

/* -------------------------------------------------------------------------- */
/* Row 7 — nothing outside persistence knows how checkpoints are stored        */
/* -------------------------------------------------------------------------- */

function sourceFiles(directory) {
  const found = [];
  const walk = (current) => {
    for (const entry of readdirSync(current)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (path.endsWith('.ts') || path.endsWith('.mjs')) found.push(path);
    }
  };
  walk(directory);
  return found;
}

/**
 * AIC-56 slice B: the `aic_app` application schema (`runs`,
 * `schema_migrations`) gets the same boundary the checkpointer schema already
 * has, folded into this row rather than duplicated into a second walk of the
 * same tree.
 *
 * `runs` itself is deliberately NOT added as a bare `\bruns\b` pattern the way
 * `CHECKPOINTER_TABLES` are: measured against this repository's own `src`
 * trees, "runs" appears constantly as an ordinary English verb ("the run
 * store's own SQL", "before anything runs", "runs already recorded" — none of
 * it a reference to the table) — the same table-name pattern that finds zero
 * matches for `checkpoint_blobs` finds dozens for `runs`, which would make this
 * row fail on prose that has nothing to do with the database. `aic_app.runs`,
 * the schema-qualified form any real reference to the table would use, is
 * measured to have zero such false positives and is what this row scans for
 * instead; `schema_migrations` is distinctive enough on its own (also measured
 * at zero false positives) to stay a bare word like the checkpointer tables.
 *
 * AIC-56 slice F extends the same list with slice C's five remaining
 * `aic_app` tables — `node_results`, `run_events`, `run_event_counters`,
 * `run_trials`, `run_evidence`, `fence_rejections` — each measured the same
 * way `schema_migrations` was: zero matches anywhere in `packages/` or
 * `apps/` outside `packages/persistence` today, so each stays a bare word
 * rather than needing `aic_app.` qualification the way `runs` does.
 *
 * AIC-99 slice c extends the list again with the registry tables migration 3
 * adds — `services`, `environments`, `credential_refs`, `source_bindings`,
 * `action_policies`, `incidents`, `registry_events` — and this time the
 * measurement comes out the other way: `services` and `environments` are
 * ordinary English/domain words that already appear outside
 * `packages/persistence` (`services` and `environments` each have false-positive
 * matches elsewhere in the tree today), the same reason `runs` needed the
 * `aic_app.` qualifier above rather than a bare word. Every one of the seven
 * new names is added `aic_app.`-qualified, uniformly, so the row's own scan
 * pattern does not have to be re-measured per-name every time a table joins it.
 */
const APPLICATION_SCHEMA_SURFACE_PATTERNS = Object.freeze([
  'aic_app\\.runs',
  'schema_migrations',
  'node_results',
  'run_events',
  'run_event_counters',
  'run_trials',
  'run_evidence',
  'fence_rejections',
  'aic_app\\.services',
  'aic_app\\.environments',
  'aic_app\\.credential_refs',
  'aic_app\\.source_bindings',
  'aic_app\\.action_policies',
  'aic_app\\.incidents',
  'aic_app\\.registry_events',
]);

test('keeps checkpointer storage, the application schema\'s tables, and the PostgreSQL driver out of every layer but persistence', () => {
  // `dependency-cruiser` cannot answer this one: `only-persistence-imports-pg`
  // refuses the driver only from `packages/`, so `apps/` is outside it, and a
  // table name in a SQL string is not an import edge at all. Hence a text scan, in the shape
  // `test/roles-boundary.test.mjs` uses to hold the provider to one file.
  const scanned = [
    ...sourceFiles(resolve(projectRoot, 'packages')),
    ...sourceFiles(resolve(projectRoot, 'apps')),
  ].filter((path) => !path.startsWith(resolve(projectRoot, 'packages/persistence')));

  const STORAGE_SURFACE = new RegExp(
    [
      String.raw`from ['"]pg['"]`,
      String.raw`require\(['"]pg['"]\)`,
      String.raw`langgraph-checkpoint-postgres`,
      ...CHECKPOINTER_TABLES.map((table) => String.raw`\b${table}\b`),
      ...APPLICATION_SCHEMA_SURFACE_PATTERNS,
    ].join('|'),
  );

  // Non-vacuity, and specifically for the half no lint rule covers: `apps/` is
  // outside `only-persistence-imports-pg`, so if the walk ever stops reaching it
  // this row would report clean while looking at packages alone.
  assert.equal(
    scanned.map((path) => relative(projectRoot, path)).includes('apps/cli/src/index.ts'),
    true,
    'the scan no longer reaches apps/: an empty or packages-only file list makes the assertion below pass by looking nowhere, which is the failure mode of every text-scan boundary check',
  );

  const naming = scanned
    .filter((path) => STORAGE_SURFACE.test(readFileSync(path, 'utf8')))
    .map((path) => relative(projectRoot, path));

  assert.deepEqual(
    naming,
    [],
    'a layer outside packages/persistence named a checkpointer table, an aic_app table, or the PostgreSQL driver: acceptance row 3 says no API or domain code reads storage tables directly, and the moment one does, the substrate stops being replaceable and every schema decision becomes a cross-layer change',
  );
});

/* -------------------------------------------------------------------------- */
/* Row 8 — the database-backed lane stays off the mandatory line               */
/* -------------------------------------------------------------------------- */

test('keeps the database-backed lane out of npm test and npm run check', () => {
  const manifest = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));

  assert.equal(
    typeof manifest.scripts[LIVE_LANE_SCRIPT],
    'string',
    `package.json must declare ${LIVE_LANE_SCRIPT}: the acceptance rows about executing, interrupting and resuming on PostgreSQL are only claims until something runs them, and a lane nobody can invoke is a lane nobody runs`,
  );
  for (const scriptName of ['test', 'check']) {
    assert.doesNotMatch(
      manifest.scripts[scriptName],
      new RegExp(LIVE_LANE_SCRIPT),
      `npm run ${scriptName} must not run the database-backed lane: the Definition-of-Done gate executes npm run check, and a check that needs a container is a gate that goes red on every machine without one — the same separation incident-lab keeps (see test/incident-lab-operator-contract.test.mjs › "keeps Docker live work outside ordinary test and check lanes")`,
    );
  }

  // Measured on node 22.23.2: `node --test` with no paths treats EVERY `.mjs`
  // under a directory named `test` as a test file — not only `*.test.mjs`. So a
  // database-dependent file placed at `test/infra/…` would join `npm test`
  // silently, whatever it was named. The lane lives outside `test/` for that
  // reason, the way incident-lab's live files live under `incident-lab/tests/`.
  const ordinaryLaneFiles = sourceFiles(resolve(projectRoot, 'test')).map((path) =>
    relative(projectRoot, path),
  );
  assert.equal(
    ordinaryLaneFiles.includes('test/persistent-resume.test.mjs'),
    true,
    'the walk over test/ no longer reaches the suite it is meant to scan, so the assertion below would report clean over an empty list',
  );

  const insideOrdinaryLane = ordinaryLaneFiles.filter((path) =>
    readFileSync(resolve(projectRoot, path), 'utf8').includes(CONNECTION_VARIABLE),
  );

  assert.deepEqual(
    insideOrdinaryLane,
    [],
    `a file under test/ reads ${CONNECTION_VARIABLE}: node --test discovers every .mjs under a directory named test, so that file has just made a running PostgreSQL a precondition of npm run check`,
  );

  const liveLane = readFileSync(resolve(projectRoot, LIVE_LANE_FILE), 'utf8');
  assert.equal(
    liveLane.includes(CONNECTION_VARIABLE),
    true,
    `${LIVE_LANE_FILE} must read its connection string from ${CONNECTION_VARIABLE}: the row above passes trivially if the lane it points at does not exist or reads the address from somewhere else`,
  );
});

/* -------------------------------------------------------------------------- */
/* The schemaVersion validation seam                                          */
/* -------------------------------------------------------------------------- */

/**
 * AIC-55's scope asks for a `schemaVersion` validation seam and leaves the
 * historical migration, corruption and DR policy to AIC-41. These rows pin the
 * seam's two behaviours and nothing about policy, because policy is not this
 * ticket's to define.
 *
 * ⚠ Written AFTER the implementation, which inverts this repository's order.
 * `code-reviewer` found the scope line dropped at the AIC-55 gate; the seam was
 * built to close it and these rows were added behind it, so none of them was
 * watched to fail before the code it checks existed.
 *
 * The source is structural on purpose: the library declares its pool private,
 * so a typed caller cannot pass the saver's own, and a narrow port keeps `pg`
 * out of the module's type surface.
 */
test('refuses a checkpointer schema at a migration version this build was not written against', async () => {
  const { assertCheckpointerSchemaVersion, CHECKPOINTER_MIGRATION_VERSION, CHECKPOINTER_SCHEMA } =
    persistence;

  assert.equal(
    typeof assertCheckpointerSchemaVersion,
    'function',
    '@aic/persistence must export the schemaVersion validation seam AIC-55 scope asks for: without it a process opens a store written by a different checkpointer and reads on',
  );
  assert.equal(
    Number.isInteger(CHECKPOINTER_MIGRATION_VERSION) && CHECKPOINTER_MIGRATION_VERSION > 0,
    true,
    'the expected migration version must be a positive integer measured against a real setup(), not a placeholder',
  );

  const asked = [];
  const sourceAt = (v) => ({
    async query(sql) {
      asked.push(sql);
      return { rows: [{ v }] };
    },
  });

  await assert.rejects(
    () => assertCheckpointerSchemaVersion(sourceAt(CHECKPOINTER_MIGRATION_VERSION + 1)),
    /migration version/,
    'a store one version ahead must be refused before execution, not read as if it were this one',
  );
  await assert.rejects(
    () => assertCheckpointerSchemaVersion(sourceAt(null)),
    /migration version/,
    'an unprovisioned store reports no version at all, and that must refuse rather than pass as "nothing to check"',
  );

  // The matching version is the only one that may pass, and it must still have
  // asked — a seam that never queries would satisfy the two rejections above.
  await assertCheckpointerSchemaVersion(sourceAt(CHECKPOINTER_MIGRATION_VERSION));
  assert.equal(
    asked.length,
    3,
    'the seam must read the version rather than assume it: three calls, three queries',
  );
  assert.match(
    asked[0],
    new RegExp(`"${CHECKPOINTER_SCHEMA}"\\.checkpoint_migrations`),
    'the seam must read the migration ledger of the checkpointer schema, qualified — an unqualified read resolves through search_path',
  );
});
