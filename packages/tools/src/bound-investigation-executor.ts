import {
  EvidenceProvenanceSchema,
  EvidenceSchema,
  RegistryIdSchema,
  SourceBindingSchema,
  type CredentialRef,
  type Evidence,
  type EvidenceProvenance,
  type SourceBinding,
  type TrialRefusal,
} from '@aic/domain';

import {
  createEvidenceSourceForBinding,
  type AdapterCatalogDeps,
  type AdapterCatalogResult,
  type AdapterCatalogSourceBinding,
} from './adapter-catalog.js';
import {
  BOUND_SOURCE_MODES,
  createBoundSourceRegistry,
  createMemoryReplayStore,
  validateSourceBudgets,
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
 * contract this file satisfies, including the closed construction refusal
 * reasons and the routing rules below.
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
 *
 * ## Construction order (review round 1)
 *
 * Before any `bindings` entry is turned into a source, or `bindings` itself
 * is ever handed to `createBoundSourceRegistry`, four checks run over the
 * OPTIONS BAG AS A WHOLE, each refusing before any per-binding work starts:
 *
 *   1. `mode` is checked against `BOUND_SOURCE_MODES`
 *      (`./bound-source-registry.js`'s own closed list, reused rather than
 *      restated) — an unrecognised value is refused `invalid-mode`.
 *   2. `budgets` is checked with `validateSourceBudgets`
 *      (`./bound-source-registry.js`'s own validation, reused rather than
 *      restated) — a value it rejects is refused `invalid-budgets`.
 *   3. `store` is checked for PRESENCE, before the `createMemoryReplayStore()`
 *      default is ever applied: `mode !== 'live'` with no `store` supplied is
 *      refused `store-required` (`live` alone tolerates the silent in-memory
 *      default, since no code path in `live` ever reads or writes it).
 *   4. every `bindings` entry is parsed against `SourceBindingSchema` and
 *      checked for a `sourceBindingId` already seen earlier in the same
 *      array, in one pass, before any entry reaches `buildSource` — a schema
 *      failure is refused `not-a-registry-binding`; a repeated id is refused
 *      `duplicate-binding`, naming the id.
 *
 * `invalid-mode`, `invalid-budgets` and `store-required` are refused
 * CONTENT-FREE (no `sourceBindingId`, `tool` or `sourceBindingIds`): the
 * option that failed is wrong for every binding, not one.
 *
 * Only once all four checks pass does the per-binding loop run: for each
 * parsed binding, its `credentialRefId` (when not `null`) is resolved
 * against `credentialRefs` and checked for a matching `environmentId` BEFORE
 * `resolveSecret` or `buildSource` is ever called — a resolved
 * `CredentialRef` in a DIFFERENT Environment is refused
 * `credential-environment-mismatch`, naming the binding — and only then is
 * `buildSource` called, whose own `refused` outcome is reported unchanged.
 *
 * Finally, the fully-built `registryBindings` are handed to
 * `createBoundSourceRegistry` in one `try`. By this point `mode`, `budgets`
 * and every `sourceBindingId` are already known-valid, so the only throws
 * this registry construction call can still raise are: the AIC-98
 * `expectedAdapter` compatibility handshake (a binding's own
 * `describe().adapterId`/`.version` disagreeing with what this port already
 * validated it against), and, in principle, `validateSafeAdapterField`'s own
 * credential-shape/pattern check on a binding's `describe()` output — no row
 * in test/bound-investigation-executor.test.mjs exercises the latter through
 * this port, so both are reported the same way: `adapter-mismatch`, naming
 * the one binding `findMismatchedBindingId` isolates by reconstructing each
 * binding alone.
 *
 * The closed `reason` values, restated exactly: `not-a-registry-binding`,
 * `unsupported-adapter`, `invalid-config`, `missing-credential`,
 * `credential-not-read`, `secret-absent`, `secret-unreadable` (the six
 * borrowed verbatim from `AdapterCatalogRefusalReason`), `adapter-mismatch`,
 * `ambiguous-route`, `duplicate-binding`, `invalid-budgets`, `invalid-mode`,
 * `credential-environment-mismatch` and `store-required`.
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
  | { readonly status: 'unavailable'; readonly reason: string; readonly refusal?: TrialRefusal }
  | { readonly status: 'error'; readonly message: string; readonly refusal?: TrialRefusal };

export interface BoundInvestigationExecutor {
  execute(context: BoundInvestigationExecutorContext): Promise<BoundInvestigationExecutorOutcome>;
}

/**
 * The closed construction-refusal reasons: the six borrowed
 * verbatim from `AdapterCatalogRefusalReason` (`./adapter-catalog.js`, since a
 * catalog refusal IS a construction refusal here); `not-a-registry-binding`
 * (a binding whose id, environmentId or credentialRefId fails
 * `SourceBindingSchema`); `adapter-mismatch` (the registry's own
 * compatibility-handshake throw, caught and reported without echoing its
 * message — see this file's own header, "Construction order"); and
 * `ambiguous-route` (two bindings whose routes name the same tool) — all from
 * the original slice — plus five more, pinned by review round 1 (see this
 * file's own header for exactly where each is checked): `duplicate-binding`
 * (the same `sourceBindingId` passed twice, naming the duplicated id),
 * `invalid-budgets` and `invalid-mode` (a `budgets` or `mode` value the
 * registry rejects for every binding, not one — so neither names a
 * `sourceBindingId`), `credential-environment-mismatch` (a binding's
 * `credentialRefId` names a read `CredentialRef` in a DIFFERENT Environment)
 * and `store-required` (mode `record` or `replay` with no `store` supplied).
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
  | 'ambiguous-route'
  | 'duplicate-binding'
  | 'invalid-budgets'
  | 'invalid-mode'
  | 'credential-environment-mismatch'
  | 'store-required';

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
 * A refusal names a binding only by an id that parses as `RegistryIdSchema`
 * (a UUID, either case). Any other string is omitted: `not-a-registry-binding`
 * covers every `SourceBindingSchema` failure, so a refused record's `id` may be
 * anything, a pasted credential included, and no allow-list of other shapes can
 * tell a label from an encoded secret. See test/bound-investigation-executor.test.mjs
 * › "not-a-registry-binding never echoes an id shaped like a lowercase hex or
 * base64url secret, which the runtime redactor does not recognise".
 */
function namedBinding(id: string | undefined): { readonly sourceBindingId?: string } {
  return id !== undefined && RegistryIdSchema.safeParse(id).success ? { sourceBindingId: id } : {};
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
 *
 * AIC-146 b4: every `unavailable`/`error` variant this function returns also
 * carries a typed `refusal` naming the reason and the routed `sourceBindingId`
 * — the one binding this call was routed to, since this function is only
 * ever reached once a route already resolved (a no-route call returns its own
 * `refusal` with `sourceBindingId: null` directly from `execute`, below,
 * without ever calling this function). `outcome.reason` on the `refused`
 * branch is already `EvidenceSourceRefusalReason` (one of the closed six),
 * read directly rather than through `evidenceSourceOutcomeToToolResult`'s own
 * `string`-typed `reason`/`message` fields.
 */
function mapOutcome(
  outcome: EvidenceSourceOutcome<unknown>,
  sourceBindingId: string,
): BoundInvestigationExecutorOutcome {
  if (outcome.status === 'refused') {
    const mapped = evidenceSourceOutcomeToToolResult(outcome);
    const refusal: TrialRefusal = { reason: outcome.reason, sourceBindingId };
    if (mapped.status === 'unavailable') {
      return { status: 'unavailable', reason: mapped.reason, refusal };
    }
    if (mapped.status === 'error') {
      return { status: 'error', message: mapped.message, refusal };
    }
    return { status: 'error', message: 'adapter_error', refusal };
  }

  const provenanceResult = EvidenceProvenanceSchema.safeParse(outcome.provenance);
  if (!provenanceResult.success) {
    return { status: 'error', message: 'adapter_error', refusal: { reason: 'adapter_error', sourceBindingId } };
  }

  if (!Array.isArray(outcome.output)) {
    return { status: 'error', message: 'adapter_error', refusal: { reason: 'adapter_error', sourceBindingId } };
  }

  const items: Evidence[] = [];
  for (const item of outcome.output) {
    // Refused regardless of whether an item's own `provenance` value is
    // itself well-formed: provenance travels alongside the outcome, never
    // inside an item.
    if (typeof item === 'object' && item !== null && Object.hasOwn(item, 'provenance')) {
      return { status: 'error', message: 'adapter_error', refusal: { reason: 'adapter_error', sourceBindingId } };
    }
    const parsedItem = EvidenceSchema.safeParse(item);
    if (!parsedItem.success) {
      return { status: 'error', message: 'adapter_error', refusal: { reason: 'adapter_error', sourceBindingId } };
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
    store: suppliedStore,
    clock,
    fetch: fetchOverride,
    resolveSecret = defaultResolveSecret,
    buildSource = createEvidenceSourceForBinding,
    budgets,
  } = options;

  // Construction order, review round 1 (see this file's own header,
  // "Construction order"): mode, then budgets, then store presence, then
  // every binding's own shape and id-uniqueness — all four checked before any
  // binding ever reaches buildSource or the registry, and each of the first
  // three refused content-free (the value is wrong for every binding, not
  // one).
  if (!BOUND_SOURCE_MODES.includes(mode)) {
    return { ok: false, reason: 'invalid-mode' };
  }

  try {
    validateSourceBudgets(budgets);
  } catch {
    return { ok: false, reason: 'invalid-budgets' };
  }

  if (suppliedStore === undefined && mode !== 'live') {
    return { ok: false, reason: 'store-required' };
  }
  const store = suppliedStore ?? createMemoryReplayStore();

  const credentialRefsById = new Map(credentialRefs.map((ref) => [ref.id, ref] as const));

  const parsedBindings: SourceBinding[] = [];
  const seenSourceBindingIds = new Set<string>();
  for (const candidate of bindings) {
    const parsedBinding = SourceBindingSchema.safeParse(candidate);
    if (!parsedBinding.success) {
      return { ok: false, reason: 'not-a-registry-binding', ...namedBinding(readCandidateId(candidate)) };
    }
    const binding = parsedBinding.data;
    if (seenSourceBindingIds.has(binding.id)) {
      return { ok: false, reason: 'duplicate-binding', ...namedBinding(binding.id) };
    }
    seenSourceBindingIds.add(binding.id);
    parsedBindings.push(binding);
  }

  const registryBindings: BoundSourceBinding[] = [];

  for (const binding of parsedBindings) {
    let credentialRef: CredentialRef | null = null;
    if (binding.credentialRefId !== null) {
      const resolvedCredentialRef = credentialRefsById.get(binding.credentialRefId);
      if (resolvedCredentialRef !== undefined) {
        if (resolvedCredentialRef.environmentId !== binding.environmentId) {
          return { ok: false, reason: 'credential-environment-mismatch', ...namedBinding(binding.id) };
        }
        credentialRef = resolvedCredentialRef;
      }
    }

    // eslint-disable-next-line no-await-in-loop
    const catalogResult = await buildSource(binding, {
      credentialRef,
      resolveSecret,
      fetch: fetchOverride,
    });

    if (catalogResult.status === 'refused') {
      return { ok: false, reason: catalogResult.reason, ...namedBinding(binding.id) };
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
      ...namedBinding(findMismatchedBindingId(registryBindings, { mode, store, clock, budgets })),
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
          // No binding at all served this tool, so routing never reached the
          // registry — the refusal names no binding (AIC-146 b4).
          return {
            status: 'unavailable',
            reason: 'unavailable',
            refusal: { reason: 'unavailable', sourceBindingId: null },
          };
        }
        const outcome = await boundRegistry.execute(sourceBindingId, context.tool, context.input);
        return mapOutcome(outcome, sourceBindingId);
      },
    },
  };
}
