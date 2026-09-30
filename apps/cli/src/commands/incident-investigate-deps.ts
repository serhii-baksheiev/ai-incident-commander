import { randomUUID } from 'node:crypto';

import {
  assertCheckpointerSchemaVersion,
  createFencedCheckpointer,
  createIncidentStore,
  createPostgresCheckpointer,
  createRunStore,
  openRunWriteContext,
  type CheckpointerVersionSource,
  type RunClaim,
  type RunStore,
} from '@aic/persistence';
import { type createReferenceModelPort } from '@aic/roles';

import { createConnectedRegistryStore, createSecretResolver, requirePostgresUrl } from './connected-env.js';
import {
  CheckpointerNotProvisionedError,
  HEARTBEAT_INTERVAL_MS,
  type IncidentInvestigateDeps,
  type IncidentInvestigateWriteContext,
} from './incident-investigate.js';

/**
 * AIC-146 c5a: `createIncidentInvestigateDeps(env, overrides?)` — the real
 * wiring `apps/cli/src/index.ts`'s `incident investigate` branch used to
 * build inline, moved here so the live lane
 * (`infra/postgres/tests/incident-investigate.live.mjs`) can build the exact
 * same `IncidentInvestigateDeps` without a spawned process for the
 * investigate step itself, and `index.ts` builds it through this one
 * function instead of duplicating it. See that file's own header for the
 * exact signature this module is pinned against.
 */
export interface IncidentInvestigateDepsOverrides {
  readonly createModelPort?: typeof createReferenceModelPort;
  readonly fetch?: typeof fetch;
  readonly stdout?: (text: string) => void;
  readonly now?: () => string;
  readonly workerId?: string;
}

export interface CreateIncidentInvestigateDepsResult {
  readonly deps: IncidentInvestigateDeps;
  close(): Promise<void>;
}

function writeStdoutLine(text: string): void {
  process.stdout.write(`${text}\n`);
}

/**
 * `aic incident investigate`'s own `RunStore` session — ONE store (one
 * `pg.Pool`), built lazily on the first call any of its methods makes, so a
 * parse refusal (bad argv, missing `--roles`, no model credential) still
 * never reads `AIC_POSTGRES_URL` — the same lazy convention
 * `createConnectedRegistryStore` follows. Unlike that helper's per-call
 * open/close pattern, this pool has to survive the WHOLE command — the
 * heartbeat keeps renewing the same lease, and the write context keeps
 * reusing the same pool for every commit — so the caller closes it once with
 * `.close()` after the command settles.
 */
function createConnectedRunSession(env: NodeJS.ProcessEnv) {
  let store: RunStore | undefined;
  const ensure = (): RunStore => {
    store ??= createRunStore(requirePostgresUrl(env), {
      leaseMs: HEARTBEAT_INTERVAL_MS * 3,
      maxExecutionAttempts: 5,
    });
    return store;
  };
  return {
    runs: {
      getRun: (runId: string) => ensure().getRun(runId),
      createRun: (run: { runId: string; input: unknown }) => ensure().createRun(run),
      claimRun: (runId: string, workerId: string) => ensure().claimRun(runId, workerId),
      sweepExpired: () => ensure().sweepExpired(),
      renewLease: (claim: RunClaim) => ensure().renewLease(claim),
    },
    openWriteContext: (claim: RunClaim) => openRunWriteContext(ensure(), claim),
    versionSource: (): CheckpointerVersionSource => ensure().pool,
    close: async (): Promise<void> => {
      if (store !== undefined) await store.close();
    },
  };
}

/** PostgreSQL's undefined_table SQLSTATE. */
const UNDEFINED_TABLE = '42P01';

/**
 * The checkpointer half of the same command: the PostgreSQL checkpointer,
 * schema-version-checked first (AIC-55) through the run session's own pool,
 * fenced by the run's write context on every path but the read-only "already
 * completed" one, which passes no context. Only a missing checkpointer table
 * becomes `CheckpointerNotProvisionedError` (which the command refuses as
 * `checkpointer-not-provisioned`); a version mismatch or a connection failure
 * propagates as itself. Every saver built is ended by `closeAll`, so its pool
 * does not outlive the command.
 */
function createConnectedCheckpointers(env: NodeJS.ProcessEnv, versionSource: () => CheckpointerVersionSource) {
  const savers: Array<ReturnType<typeof createPostgresCheckpointer>> = [];
  return {
    create: async (context?: IncidentInvestigateWriteContext) => {
      try {
        await assertCheckpointerSchemaVersion(versionSource());
      } catch (error) {
        // PostgreSQL's undefined_table: no checkpointer schema in this
        // database at all. Anything else (a version mismatch, a connection
        // failure) is reported as itself.
        if ((error as { code?: unknown } | null)?.code === UNDEFINED_TABLE) {
          throw new CheckpointerNotProvisionedError({ cause: error });
        }
        throw error;
      }
      const saver = createPostgresCheckpointer(requirePostgresUrl(env));
      savers.push(saver);
      return context === undefined ? saver : createFencedCheckpointer(saver, context);
    },
    closeAll: async (): Promise<void> => {
      await Promise.all(savers.map((saver) => saver.end()));
    },
  };
}

export function createIncidentInvestigateDeps(
  env: NodeJS.ProcessEnv,
  overrides?: IncidentInvestigateDepsOverrides,
): CreateIncidentInvestigateDepsResult {
  const session = createConnectedRunSession(env);
  const checkpointers = createConnectedCheckpointers(env, session.versionSource);
  const deps: IncidentInvestigateDeps = {
    env,
    registry: createConnectedRegistryStore(env),
    incidents: {
      getIncident: (id) => createIncidentStore(requirePostgresUrl(env)).getIncident(id),
    },
    runs: session.runs,
    openWriteContext: session.openWriteContext,
    createCheckpointer: (context) => checkpointers.create(context),
    fetch: overrides?.fetch ?? globalThis.fetch,
    resolveSecret: (secretName) => createSecretResolver(env).resolve(secretName),
    createModelPort: overrides?.createModelPort,
    workerId: overrides?.workerId ?? `aic-cli-${randomUUID()}`,
    stdout: overrides?.stdout ?? writeStdoutLine,
    now: overrides?.now ?? (() => new Date().toISOString()),
  };
  return {
    deps,
    close: async (): Promise<void> => {
      try {
        await checkpointers.closeAll();
      } finally {
        await session.close();
      }
    },
  };
}
