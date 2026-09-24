/**
 * AIC-56 slice D1: the compile-time half of the `CommittedExecution` port
 * contract.
 *
 * What it proves: `@aic/persistence`'s `RunWriteContext` is structurally
 * assignable to `@aic/domain`'s `CommittedExecution` port - the type
 * `packages/graph` is meant to depend on instead of importing
 * `@aic/persistence` directly (this file's own header note on
 * `.claude/rules/invariants.md`'s "one mechanism, one implementation": the
 * graph package never imports the persistence package for this). And that the
 * check is not vacuous: a value missing `committed` is refused.
 *
 * A real value, not a `declare`: like `scoped-domain-type-contract.ts` and
 * `graph-owned-control-type-contract.ts`, `test/fixtures` is swept by node's
 * default test-file discovery, so this file is also EXECUTED with its types
 * stripped - every binding below must be valid plain JavaScript too. A
 * `declare const` binding would compile but throw a ReferenceError once
 * stripped, which is exactly the mistake those two files' own headers warn
 * against.
 *
 * The runtime half of this same contract - a real `RunWriteContext` actually
 * satisfying the port when driven through the graph - is
 * infra/postgres/tests/durable-tool-replay.live.mjs's acceptance row.
 */
import type { CommittedExecution } from '@aic/domain';
import type { RunWriteContext } from '@aic/persistence';

function acceptsCommittedExecution(port: CommittedExecution): void {
  void port;
}

// A real (if inert) object literal, typed as `RunWriteContext` - so this line
// itself checks that the literal satisfies every member `RunWriteContext`
// declares, and the call below checks that a `RunWriteContext`-typed value is
// accepted wherever a `CommittedExecution` is asked for.
//
// `pool` is typed through an indexed access into `RunWriteContext` itself
// (`RunWriteContext['pool']`) rather than by importing `Pool` from `pg`
// directly: `pg` ships no type declarations of its own
// (`packages/persistence/src/pg.d.ts` is the project's own ambient shim,
// visible only within that package's own compilation), and a direct
// `import type { Pool } from 'pg'` here would fail this standalone compile
// with "Could not find a declaration file for module 'pg'" for a reason
// that has nothing to do with the contract this fixture exists to check.
const context: RunWriteContext = {
  pool: undefined as unknown as RunWriteContext['pool'],
  committed: async (_execKey, compute) => compute(),
  markWaitingHuman: async () => {},
  complete: async () => {},
  fail: async () => {},
  assertOwner: async () => {},
};

acceptsCommittedExecution(context);

// Not vacuous: an object missing `committed` is refused, or the check above
// would prove nothing about the shape and everything would pass regardless.
const notAPort = {};
// @ts-expect-error CommittedExecution requires a committed method
acceptsCommittedExecution(notAPort);

void notAPort;
