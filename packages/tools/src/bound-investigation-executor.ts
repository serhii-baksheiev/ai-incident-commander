import {
  EvidenceProvenanceSchema,
  EvidenceSchema,
  SourceBindingSchema,
  type CredentialRef,
  type Evidence,
  type EvidenceProvenance,
  type SourceBinding,
} from '@aic/domain';

import {
  createEvidenceSourceForBinding,
  type AdapterCatalogDeps,
  type AdapterCatalogResult,
  type AdapterCatalogSourceBinding,
} from './adapter-catalog.js';
import {
  createBoundSourceRegistry,
  createMemoryReplayStore,
  type BoundSourceBinding,
  type BoundSourceEntrySnapshot,
  type BoundSourceMode,
  type ReplayStore,
  type SourceBudgets,
} from './bound-source-registry.js';
import { isReadOnlyToolId } from './contracts.js';
import { evidenceSourceOutcomeToToolResult, type EvidenceSourceOutcome } from './evidence-source.js';
import type { ResolveSecretResult } from './secret-resolver.js';

/**
 * AIC-146 slice b3: `createBoundInvestigationExecutor` — the tools-side
 * bound-source execution port. It is the only function that receives a
 * `BoundSourceRegistry` outcome for a planned `(tool, input)` call, and it
 * turns that outcome into the shape `execute_investigation`
 * (`@aic/graph`'s `createInvestigationNodes`) expects. See
 * test/bound-investigation-executor.test.mjs's header for the full pinned
 * contract this file satisfies, including the nine closed construction
 * refusal reasons and the routing rules below.
 *
 * `@aic/tools` never imports `@aic/graph` (`packages/tools/package.json`
 * depends on `@aic/domain` only), so `BoundInvestigationExecutorContext` /
 * `BoundInvestigationExecutorOutcome` restate the graph's
 * `ExecuteInvestigationContext` / `ExecuteInvestigationOutcome` shapes rather
 * than importing them — the same direction
 * `packages/graph/src/nodes/execute-investigation.ts` already restates this
 * package's own `ToolResult`. See
 * test/fixtures/bound-investigation-executor-type-contract.ts, which pins
 * `execute` as assignable to `createInvestigationNodes`'s own `execute`
 * parameter.
 *
 * Routing: a planned `(tool, input)` is routed to the one `SourceBinding`
 * whose adapter's `describe().operations`, filtered to `isReadOnlyToolId`,
 * names that tool. The route table is built once, at construction, from
 * `BoundSourceRegistry.describeBindings()` — the construction-time snapshot
 * the registry already holds — so this port never calls a binding's own
 * `describe()` itself, keeping every binding's `describe()` called exactly
 * once in total, at registry construction.
 */

export type BoundInvestigationExecutorContext = Readonly<{
  runId: string;
  testId: string;
  attempt: number;
  tool: string;
  input: unknown;
}>;

export type BoundInvestigationExecutorOutcome =
  | { readonly status: 'ok'; readonly output: readonly Evidence[]; readonly provenance: EvidenceProvenance }
  | { readonly status: 'unavailable'; readonly reason: string }
  | { readonly status: 'error'; readonly message: string };

export interface BoundInvestigationExecutor {
  execute(context: BoundInvestigationExecutorContext): Promise<BoundInvestigationExecutorOutcome>;
}

/**
 * The nine closed construction-refusal reasons: the six borrowed verbatim
 * from `AdapterCatalogRefusalReason` (`./adapter-catalog.js`, since a catalog
 * refusal IS a construction refusal here), plus `not-a-registry-binding` (a
 * binding whose id, environmentId or credentialRefId fails
 * `SourceBindingSchema`), `adapter-mismatch` (the registry's own
 * compatibility-handshake throw, caught and reported without echoing its
 * message) and `ambiguous-route` (two bindings whose routes name the same
 * tool).
 */
export type BoundInvestigationExecutorRefusalReason =
  | 'not-a-registry-binding'
  | 'unsupported-adapter'
  | 'invalid-config'
  | 'missing-credential'
  | 'credential-not-read'
  | 'secret-absent'
  | 'secret-unreadable'
  | 'adapter-mismatch'
  | 'ambiguous-route';

export type BoundInvestigationExecutorConstructionResult =
  | { readonly ok: true; readonly executor: BoundInvestigationExecutor }
  | {
      readonly ok: false;
      readonly reason: BoundInvestigationExecutorRefusalReason;
      readonly sourceBindingId?: string;
      readonly tool?: string;
      readonly sourceBindingIds?: readonly string[];
    };

export interface CreateBoundInvestigationExecutorOptions {
  readonly bindings: readonly SourceBinding[];
  readonly credentialRefs?: readonly CredentialRef[];
  readonly mode: BoundSourceMode;
  readonly store?: ReplayStore;
  readonly clock: () => Date;
  readonly fetch?: typeof fetch;
  readonly resolveSecret?: (secretName: string) => Promise<ResolveSecretResult>;
  readonly buildSource?: (
    binding: AdapterCatalogSourceBinding,
    deps: AdapterCatalogDeps,
  ) => Promise<AdapterCatalogResult>;
  readonly budgets?: Partial<SourceBudgets>;
}

/** Never resolves a real secret: used only when a caller supplies none, for bindings that carry no credential. */
async function defaultResolveSecret(): Promise<ResolveSecretResult> {
  return { status: 'absent' };
}

/** Reads a raw construction candidate's own `id`, without trusting its shape otherwise — used only to name a refusal. */
function readCandidateId(candidate: unknown): string | undefined {
  if (typeof candidate !== 'object' || candidate === null) {
    return undefined;
  }
  const id = (candidate as { readonly id?: unknown }).id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Identifies which bound binding the registry's own compatibility-handshake
 * throw came from, by reconstructing each binding ALONE, in order, until one
 * throws — never by parsing the registry's own thrown message. This only
 * ever runs after the combined construction already failed, so the extra
 * `describe()` calls it costs land in the refusal path, not the one
 * `describe()`-per-binding path construction guarantees on success — see
 * test/bound-investigation-executor.test.mjs's adapter-mismatch rows, which
 * assert `check`/`execute`/`fetch` are never called but never assert a
 * `describe()` count for this path.
 */
function findMismatchedBindingId(
  registryBindings: readonly BoundSourceBinding[],
  options: Readonly<{
    mode: BoundSourceMode;
    store: ReplayStore;
    clock: () => Date;
    budgets?: Partial<SourceBudgets>;
  }>,
): string | undefined {
  for (const binding of registryBindings) {
    try {
      createBoundSourceRegistry({
        mode: options.mode,
        bindings: [binding],
        store: options.store,
        clock: options.clock,
        budgets: options.budgets,
      });
    } catch {
      return binding.sourceBindingId;
    }
  }
  return undefined;
}

type RouteTableResult =
  | { readonly ok: true; readonly routeTable: ReadonlyMap<string, string> }
  | { readonly ok: false; readonly tool: string; readonly sourceBindingIds: readonly string[] };

/**
 * Builds the tool -> sourceBindingId route table from the registry's own
 * construction-time snapshot: only operations `isReadOnlyToolId` accepts
 * become routes, and a tool named by more than one binding is refused
 * `ambiguous-route` rather than silently picking one — mirrors
 * `replay/index.ts`'s `assertOneFormPerTool`.
 */
function buildRouteTable(entries: readonly BoundSourceEntrySnapshot[]): RouteTableResult {
  const owners = new Map<string, Set<string>>();
  for (const entry of entries) {
    for (const operation of entry.operations) {
      if (!isReadOnlyToolId(operation)) continue;
      const existing = owners.get(operation);
      if (existing === undefined) {
        owners.set(operation, new Set([entry.sourceBindingId]));
      } else {
        existing.add(entry.sourceBindingId);
      }
    }
  }

  for (const [tool, ids] of owners) {
    if (ids.size > 1) {
      return { ok: false, tool, sourceBindingIds: Array.from(ids) };
    }
  }

  const routeTable = new Map<string, string>();
  for (const [tool, ids] of owners) {
    const [sourceBindingId] = ids;
    routeTable.set(tool, sourceBindingId);
  }
  return { ok: true, routeTable };
}

/**
 * Maps one `BoundSourceRegistry.execute` outcome to this port's own outcome
 * shape. A refused outcome reuses `evidenceSourceOutcomeToToolResult`
 * (`./evidence-source.js`) rather than a second reason-to-status mapping. An
 * ok outcome is re-validated here, independent of the registry's own
 * guarantees: `outcome.provenance` against `EvidenceProvenanceSchema`, and
 * every output item against `EvidenceSchema` — a non-array output, an item
 * carrying its own `provenance` key (regardless of whether that value is
 * itself well-formed) or an item failing `EvidenceSchema` all refuse the same
 * fixed, content-free `adapter_error`, never echoing adapter output text.
 */
function mapOutcome(outcome: EvidenceSourceOutcome<unknown>): BoundInvestigationExecutorOutcome {
  if (outcome.status === 'refused') {
    const mapped = evidenceSourceOutcomeToToolResult(outcome);
    if (mapped.status === 'unavailable') {
      return { status: 'unavailable', reason: mapped.reason };
    }
    if (mapped.status === 'error') {
      return { status: 'error', message: mapped.message };
    }
    return { status: 'error', message: 'adapter_error' };
  }

  const provenanceResult = EvidenceProvenanceSchema.safeParse(outcome.provenance);
  if (!provenanceResult.success) {
    return { status: 'error', message: 'adapter_error' };
  }

  if (!Array.isArray(outcome.output)) {
    return { status: 'error', message: 'adapter_error' };
  }

  const items: Evidence[] = [];
  for (const item of outcome.output) {
    // Refused regardless of whether an item's own `provenance` value is
    // itself well-formed: provenance travels alongside the outcome, never
    // inside an item.
    if (typeof item === 'object' && item !== null && Object.hasOwn(item, 'provenance')) {
      return { status: 'error', message: 'adapter_error' };
    }
    const parsedItem = EvidenceSchema.safeParse(item);
    if (!parsedItem.success) {
      return { status: 'error', message: 'adapter_error' };
    }
    items.push(parsedItem.data);
  }

  return { status: 'ok', output: items, provenance: provenanceResult.data };
}

export async function createBoundInvestigationExecutor(
  options: CreateBoundInvestigationExecutorOptions,
): Promise<BoundInvestigationExecutorConstructionResult> {
  const {
    bindings,
    credentialRefs = [],
    mode,
    store = createMemoryReplayStore(),
    clock,
    fetch: fetchOverride,
    resolveSecret = defaultResolveSecret,
    buildSource = createEvidenceSourceForBinding,
    budgets,
  } = options;

  const credentialRefsById = new Map(credentialRefs.map((ref) => [ref.id, ref] as const));

  const registryBindings: BoundSourceBinding[] = [];

  for (const candidate of bindings) {
    const parsedBinding = SourceBindingSchema.safeParse(candidate);
    if (!parsedBinding.success) {
      return { ok: false, reason: 'not-a-registry-binding', sourceBindingId: readCandidateId(candidate) };
    }
    const binding = parsedBinding.data;

    const credentialRef =
      binding.credentialRefId === null ? null : (credentialRefsById.get(binding.credentialRefId) ?? null);

    // eslint-disable-next-line no-await-in-loop
    const catalogResult = await buildSource(binding, {
      credentialRef,
      resolveSecret,
      fetch: fetchOverride,
    });

    if (catalogResult.status === 'refused') {
      return { ok: false, reason: catalogResult.reason, sourceBindingId: binding.id };
    }

    registryBindings.push({
      sourceBindingId: binding.id,
      source: catalogResult.source,
      credentialRefId: binding.credentialRefId,
      expectedAdapter: `${binding.adapterId}@${binding.adapterVersion}`,
    });
  }

  let registry;
  try {
    registry = createBoundSourceRegistry({ mode, bindings: registryBindings, store, clock, budgets });
  } catch {
    return {
      ok: false,
      reason: 'adapter-mismatch',
      sourceBindingId: findMismatchedBindingId(registryBindings, { mode, store, clock, budgets }),
    };
  }

  const routeResult = buildRouteTable(registry.describeBindings());
  if (!routeResult.ok) {
    return { ok: false, reason: 'ambiguous-route', tool: routeResult.tool, sourceBindingIds: routeResult.sourceBindingIds };
  }

  const { routeTable } = routeResult;
  const boundRegistry = registry;

  return {
    ok: true,
    executor: {
      async execute(context) {
        const sourceBindingId = routeTable.get(context.tool);
        if (sourceBindingId === undefined) {
          return { status: 'unavailable', reason: 'unavailable' };
        }
        const outcome = await boundRegistry.execute(sourceBindingId, context.tool, context.input);
        return mapOutcome(outcome);
      },
    },
  };
}
