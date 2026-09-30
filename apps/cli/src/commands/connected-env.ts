import { createDirectorySecretResolver } from '@aic/tools';
import { createRegistryStore, type RegistryStore } from '@aic/persistence';

/**
 * AIC-146 c5a: the pieces of `apps/cli/src/index.ts`'s connection wiring that
 * more than one command builds — `createConnectedRegistryStore` (every
 * registry noun, `doctor`, `source check`, `incident start`, `apply`) and
 * `createSecretResolver` (`doctor`, `source check`, and
 * `incident-investigate-deps.ts`) — pulled out so neither is duplicated
 * (`.claude/rules/invariants.md`, "one mechanism, one implementation").
 */

export const POSTGRES_URL_VARIABLE = 'AIC_POSTGRES_URL';

export function requirePostgresUrl(env: NodeJS.ProcessEnv): string {
  const value = env[POSTGRES_URL_VARIABLE];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${POSTGRES_URL_VARIABLE} must be set to a PostgreSQL connection string`);
  }
  return value;
}

/**
 * Every `RegistryStore` method, wrapped so `AIC_POSTGRES_URL` is read only
 * when a method is actually called — never merely because a registry noun
 * was dispatched. This is what lets a parse error (missing/unknown
 * subcommand, a bad flag) refuse before `AIC_POSTGRES_URL` is ever read: the
 * argv parsing inside `runRegistryCommand` always runs first and, on
 * failure, never calls a store method at all.
 *
 * `@aic/persistence`'s `createRegistryStore` accepts a bare connection
 * string for exactly this caller: given one, it opens its own `Pool` per
 * call, checks the schema version, runs, and closes it again — so this app
 * never imports `pg` itself (`.claude/rules/invariants.md`, "one mechanism,
 * one implementation": the PostgreSQL driver stays inside
 * `packages/persistence`).
 * see test/postgres-checkpointer.test.mjs › "keeps checkpointer storage,
 * the application schema's tables, and the PostgreSQL driver out of every
 * layer but persistence"
 * see cli-dispatcher.test.mjs › "the "service" noun with no subcommand exits
 * non-zero, names "subcommand" as the problem rather than claiming to be
 * unimplemented, and writes nothing to the working directory" (spawned with
 * no connection string at all; one row per registry noun)
 */
export function createConnectedRegistryStore(env: NodeJS.ProcessEnv): RegistryStore {
  const connected = (): RegistryStore => createRegistryStore(requirePostgresUrl(env));
  return {
    snapshot: () => connected().snapshot(),
    addService: (input) => connected().addService(input),
    addEnvironment: (input) => connected().addEnvironment(input),
    addCredentialRef: (input) => connected().addCredentialRef(input),
    addSourceBinding: (input) => connected().addSourceBinding(input),
    setActionPolicy: (input) => connected().setActionPolicy(input),
    removeEnvironment: (input) => connected().removeEnvironment(input),
    removeService: (input) => connected().removeService(input),
  };
}

const SECRETS_DIR_VARIABLE = 'AIC_SECRETS_DIR';
const DEFAULT_SECRETS_DIR = '/run/secrets';

/**
 * AIC-99 slice e: the directory a resolved `CredentialRef.secretName` is read
 * from — `AIC_SECRETS_DIR`, defaulting to `/run/secrets`. Built fresh per
 * dispatch (never at module load), so a parse error still refuses before any
 * filesystem path is even computed, mirroring `createConnectedRegistryStore`
 * above.
 */
export function createSecretResolver(env: NodeJS.ProcessEnv) {
  const configured = env[SECRETS_DIR_VARIABLE];
  const directory = typeof configured === 'string' && configured.trim() !== '' ? configured : DEFAULT_SECRETS_DIR;
  return createDirectorySecretResolver({ directory });
}
