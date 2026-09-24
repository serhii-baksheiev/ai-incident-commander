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
 * AIC-100, slice d: a thin wrapper over `createBoundSourceRegistry`'s `live`
 * mode, one `createIncidentToolSource` binding per tool. The public signature
 * and error strings are unchanged (test/tool-registry-replay.test.mjs); the
 * optional second argument reaches the registry's budgets and clock
 * (test/legacy-adapters-on-registry.test.mjs, "d4" rows).
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
