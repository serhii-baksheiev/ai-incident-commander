import { DOMAIN_LAYER, type Evidence } from '@aic/domain';

import type { BoundSourceBinding, BoundSourceRegistry, SourceBudgets } from '../src/bound-source-registry.js';
import { createBoundSourceRegistry, createMemoryReplayStore } from '../src/bound-source-registry.js';
import {
  isReadOnlyToolId,
  type IncidentTool,
  type ToolResult,
} from '../src/contracts.js';
import { createIncidentToolSource } from '../src/incident-tool-source.js';

export const LIVE_TOOL_DEPENDENCIES = [DOMAIN_LAYER] as const;

/**
 * AIC-100, slice d: `LiveToolAdapter` becomes a thin wrapper over
 * `createBoundSourceRegistry`'s `live` mode — each bound `IncidentTool` is
 * wrapped by `createIncidentToolSource` (`../src/incident-tool-source.ts`),
 * so a credential-shaped value anywhere in a tool's `ToolResult` is redacted
 * through `BoundSourceRegistry`'s own `redactEvidenceOutput` pass before it
 * ever reaches this class's caller. Every existing public signature and
 * error string is kept exactly: the constructor still throws
 * `` `v0.1 tool is not registered: ${id}` ``, `` `duplicate incident tool: ${id}` ``
 * and `` `v0.1 tool ${id} must be read-only` `` for the same three
 * violations, in the same order, and `execute()` still returns
 * `` { status: 'unavailable', reason: `tool is not registered: ${toolId}` } ``
 * for an unregistered id and `{ status: 'error', message: 'tool execution
 * failed' }` for any execution failure — see
 * test/tool-registry-replay.test.mjs's unmodified rows for both.
 *
 * The constructor gains one ADDITIVE second argument, `{ budgets?, clock? }`
 * (AIC-100 slice d), which reaches the registry's own budget enforcement
 * unchanged — an omitted `clock` defaults to the real wall clock, which is
 * never observed by any caller: `execute()` below unwraps a registry outcome
 * down to the wrapped tool's own `ToolResult`, discarding every
 * `EvidenceSourceOutcome.provenance` field (including `fetchedAt`) along the
 * way. See test/legacy-adapters-on-registry.test.mjs's "d4" section,
 * including the timeout row that DOES observe a REFUSAL reason (mapped back
 * to `{ status: 'unavailable', reason: 'timeout' }`, the one typed refusal
 * this wrapper surfaces as-is) and the two non-JSON-input rows, where the
 * registry's own `createRequestFingerprint` failure keeps the wrapped tool
 * from ever being called at all — this class adds no pre-check of its own for
 * that case.
 */
export interface LiveToolAdapterOptions {
  readonly budgets?: Partial<SourceBudgets>;
  readonly clock?: () => Date;
}

export class LiveToolAdapter<Input = unknown, Output = Evidence[]> {
  readonly #toolIds: ReadonlySet<string>;
  readonly #registry: BoundSourceRegistry;

  constructor(tools: readonly IncidentTool<Input, Output>[], options: LiveToolAdapterOptions = {}) {
    const registered = new Set<string>();
    const bindings: BoundSourceBinding[] = [];
    for (const tool of tools) {
      if (!isReadOnlyToolId(tool.id)) {
        throw new Error(`v0.1 tool is not registered: ${tool.id}`);
      }
      if (registered.has(tool.id)) {
        throw new Error(`duplicate incident tool: ${tool.id}`);
      }
      if (tool.risk !== 'read') {
        throw new Error(`v0.1 tool ${tool.id} must be read-only`);
      }
      registered.add(tool.id);
      bindings.push({
        sourceBindingId: tool.id,
        source: createIncidentToolSource(tool),
        credentialRefId: null,
      });
    }
    this.#toolIds = registered;
    this.#registry = createBoundSourceRegistry({
      mode: 'live',
      bindings,
      store: createMemoryReplayStore(),
      clock: options.clock ?? (() => new Date()),
      budgets: options.budgets,
    });
  }

  async execute(toolId: string, input: Input): Promise<ToolResult<Output>> {
    if (!this.#toolIds.has(toolId)) {
      return { status: 'unavailable', reason: `tool is not registered: ${toolId}` };
    }

    const outcome = await this.#registry.execute(toolId, toolId, input);

    if (outcome.status === 'ok') {
      return outcome.output as ToolResult<Output>;
    }

    if (outcome.reason === 'adapter_error') {
      return { status: 'error', message: 'tool execution failed' };
    }

    return { status: 'unavailable', reason: outcome.reason };
  }
}
