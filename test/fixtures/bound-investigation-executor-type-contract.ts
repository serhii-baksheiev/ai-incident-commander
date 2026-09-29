/**
 * AIC-146 slice b3: the compile-time half of the bound-source execution
 * port's contract. `@aic/tools` cannot import `@aic/graph`
 * (`packages/tools/package.json` depends on `@aic/domain` only), so the
 * port's own `BoundInvestigationExecutorContext` /
 * `BoundInvestigationExecutorOutcome` types restate
 * `ExecuteInvestigationContext` / `ExecuteInvestigationOutcome`'s shape
 * rather than importing it — the same direction
 * `packages/graph/src/nodes/execute-investigation.ts` already restates
 * `@aic/tools`'s `ToolResult` for the opposite dependency edge. This file
 * pins the two sides back together from the graph side: the port's
 * `execute` must be assignable to the `execute` parameter
 * `createInvestigationNodes` itself declares — read directly off the
 * imported function with `Parameters<...>`, never a second, hand-typed copy
 * of that parameter's shape (`.claude/rules/invariants.md`, "one mechanism,
 * one implementation").
 *
 * A real value, not a `declare`: like its sibling fixtures (e.g.
 * `test/fixtures/bound-source-registry-type-contract.ts`), this file is also
 * executed directly by node's bare test-file discovery, with its types
 * stripped — every binding below must be valid plain JavaScript too. In this
 * slice's RED state, `createBoundInvestigationExecutor` is not yet exported
 * from `@aic/tools`, so the import below fails to resolve both when tsc
 * compiles this file and when node loads it directly — see
 * test/bound-investigation-executor.test.mjs's own "compiles the
 * bound-investigation-executor type contract" row, which runs the former.
 */
import type { TrialRefusal } from '@aic/domain';
import { createInvestigationNodes } from '@aic/graph';
import {
  createBoundInvestigationExecutor,
  createMemoryReplayStore,
} from '@aic/tools';
import type {
  BoundInvestigationExecutor,
  BoundInvestigationExecutorContext,
  BoundInvestigationExecutorOutcome,
} from '@aic/tools';

// The one true shape a port's `execute` must satisfy: read off the real
// function `createInvestigationNodes` declares, never restated by hand here.
type CreateInvestigationNodesExecuteParam = Parameters<typeof createInvestigationNodes>[0]['execute'];

// AIC-146 b4: the unavailable/error variants gain an optional `refusal`,
// typed as exactly `@aic/domain`'s own `TrialRefusal`, never a second,
// hand-typed copy of that shape.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type UnavailableOutcome = Extract<BoundInvestigationExecutorOutcome, { status: 'unavailable' }>;
type ErrorOutcome = Extract<BoundInvestigationExecutorOutcome, { status: 'error' }>;
const unavailableRefusalIsExactlyOptional: Same<UnavailableOutcome['refusal'], TrialRefusal | undefined> = true;
const errorRefusalIsExactlyOptional: Same<ErrorOutcome['refusal'], TrialRefusal | undefined> = true;
void unavailableRefusalIsExactlyOptional;
void errorRefusalIsExactlyOptional;

function acceptsCreateInvestigationNodesExecute(execute: CreateInvestigationNodesExecuteParam): void {
  void execute;
}

function acceptsExecutor(executor: BoundInvestigationExecutor): void {
  void executor;
}

const context: BoundInvestigationExecutorContext = {
  runId: 'run-fixture',
  testId: 'test-fixture',
  attempt: 1,
  tool: 'deployments',
  input: { service: 'checkout', window: 'incident' },
};
void context;

// Type-check only: never invoked at runtime (mirrors
// bound-source-registry-type-contract.ts's own typeCheckRekey convention),
// so this stays safe to keep even once BoundInvestigationExecutorOutcome
// is a real, richer type this file does not fully reconstruct by hand.
async function typeCheckOutcomeShape(): Promise<BoundInvestigationExecutorOutcome> {
  return {
    status: 'ok',
    output: [],
    provenance: {
      sourceBindingId: 'binding-fixture',
      adapter: 'lab@1',
      credentialRefId: null,
      fetchedAt: '2026-09-29T00:00:00.000Z',
      requestFingerprint: `sha256:${'0'.repeat(64)}`,
    },
  };
}
void typeCheckOutcomeShape;

// Fixed UUID-shaped literals, not randomUUID(): this file's own compile
// invocation (test/bound-investigation-executor.test.mjs) runs `tsc
// --ignoreConfig` with no `types` field, which cannot resolve `node:crypto`'s
// ambient types — see this same file's sibling fixtures, none of which
// import a node builtin either.
const binding = {
  id: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
  adapterId: 'lab',
  adapterVersion: '1',
  name: 'lab-primary',
  config: { baseUrl: 'http://127.0.0.1:9999' },
  credentialRefId: null,
} as const;

// A real, minimal construction call — safe to actually run: lab@1's
// construction never touches the network (only describe(), never fetch).
const constructed = await createBoundInvestigationExecutor({
  bindings: [binding],
  mode: 'live',
  clock: () => new Date('2026-09-29T00:00:00.000Z'),
});

if (constructed.ok) {
  acceptsExecutor(constructed.executor);
  acceptsCreateInvestigationNodesExecute(constructed.executor.execute);
} else {
  const reason: string = constructed.reason;
  void reason;
}

// Every optional construction field, exercised at the type level (never
// invoked at runtime, since actually running it is not needed to typecheck
// the options bag's own shape).
async function typeCheckEveryOption(): Promise<void> {
  const result = await createBoundInvestigationExecutor({
    bindings: [binding],
    credentialRefs: [],
    mode: 'replay',
    store: createMemoryReplayStore(),
    clock: () => new Date('2026-09-29T00:00:00.000Z'),
    fetch: undefined,
    resolveSecret: async () => ({ status: 'absent' as const }),
    buildSource: undefined,
    budgets: { timeoutMs: 1000, maxResultBytes: 1024, maxPages: 1 },
  });
  void result;
}
void typeCheckEveryOption;
