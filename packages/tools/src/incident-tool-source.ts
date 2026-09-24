import type { IncidentTool, ToolResult } from './contracts.js';
import type { EvidenceSource, EvidenceSourceOutcome, EvidenceSourceProvenance } from './evidence-source.js';

/**
 * AIC-100, slice d: an `EvidenceSource` over one legacy `IncidentTool`, with
 * the adapter identity `migrateReplayFixtureV1` also uses; the tool's
 * `ToolResult` is the `ok` output. Use it through `createBoundSourceRegistry`:
 * the provenance this source returns is a placeholder.
 */

export const INCIDENT_TOOL_ADAPTER_ID = 'aic.incident-tool';
export const INCIDENT_TOOL_ADAPTER_VERSION = '1';

const PLACEHOLDER_PROVENANCE: EvidenceSourceProvenance = Object.freeze({
  sourceBindingId: '',
  adapter: '',
  credentialRefId: null,
  fetchedAt: '',
  requestFingerprint: '',
});

export function createIncidentToolSource<Input = unknown, Output = unknown>(
  tool: IncidentTool<Input, Output>,
): EvidenceSource<ToolResult<Output>> {
  return {
    describe() {
      return {
        adapterId: INCIDENT_TOOL_ADAPTER_ID,
        version: INCIDENT_TOOL_ADAPTER_VERSION,
        operations: [tool.id],
      };
    },
    async check() {
      return { status: 'ready' };
    },
    async execute(_operation, input): Promise<EvidenceSourceOutcome<ToolResult<Output>>> {
      const output = await tool.execute(input as Input);
      return { status: 'ok', output, provenance: PLACEHOLDER_PROVENANCE };
    },
  };
}
