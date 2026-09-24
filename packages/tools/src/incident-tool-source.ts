import type { IncidentTool, ToolResult } from './contracts.js';
import type { EvidenceSource, EvidenceSourceOutcome, EvidenceSourceProvenance } from './evidence-source.js';

/**
 * AIC-100, slice d: an `EvidenceSource` over one legacy `IncidentTool`, with
 * the fixed adapter identity `aic.incident-tool@1` that
 * `migrateReplayFixtureV1` also uses. The tool's `ToolResult` is carried whole
 * as the `ok` output; a throw propagates to the registry's classifier.
 */

export const INCIDENT_TOOL_ADAPTER_ID = 'aic.incident-tool';
export const INCIDENT_TOOL_ADAPTER_VERSION = '1';

/** The registry rebuilds provenance itself, so this value is never returned. */
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
