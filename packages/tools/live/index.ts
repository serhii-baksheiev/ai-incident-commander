import { DOMAIN_LAYER, type Evidence } from '@aic/domain';

import {
  isReadOnlyToolId,
  type IncidentTool,
  type ToolResult,
} from '../src/contracts.js';

export const LIVE_TOOL_DEPENDENCIES = [DOMAIN_LAYER] as const;

export class LiveToolAdapter<Input = unknown, Output = Evidence[]> {
  readonly #tools: ReadonlyMap<string, IncidentTool<Input, Output>>;

  constructor(tools: readonly IncidentTool<Input, Output>[]) {
    const registered = new Map<string, IncidentTool<Input, Output>>();
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
      registered.set(tool.id, tool);
    }
    this.#tools = registered;
  }

  async execute(toolId: string, input: Input): Promise<ToolResult<Output>> {
    const tool = this.#tools.get(toolId);
    if (!tool) {
      return { status: 'unavailable', reason: `tool is not registered: ${toolId}` };
    }

    try {
      return await tool.execute(input);
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : 'tool execution failed',
      };
    }
  }
}
