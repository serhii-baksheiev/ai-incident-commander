import type { IncidentTool, ToolResult } from './contracts.js';
import type { EvidenceSource, EvidenceSourceOutcome, EvidenceSourceProvenance } from './evidence-source.js';

/**
 * AIC-100, slice d: `createIncidentToolSource` — the `EvidenceSource`
 * wrapper around one legacy `IncidentTool`. See
 * test/legacy-adapters-on-registry.test.mjs's header for the design this
 * satisfies: a fixed `aic.incident-tool@1` adapter identity — the same fixed
 * identity `migrateReplayFixtureV1` (`./replay-migration.ts`) uses, so the
 * two halves of AIC-100 slice d key identically (see that test file's
 * "record-mode registry over createIncidentToolSource produces the same
 * identity ... as migrateReplayFixtureV1" row) — and the wrapped tool's own
 * `ToolResult` carried WHOLE as the outcome's `ok` `output`, never
 * reinterpreted: an `unavailable`/`error` `ToolResult` the tool itself
 * returns is not translated into one of `BoundSourceRegistry`'s typed refusal
 * reasons, it is simply the payload. A throw from the wrapped tool's own
 * `execute()` propagates unchanged out of this wrapper's `execute()`, for
 * `BoundSourceRegistry`'s `classifyEvidenceSourceFailure` to classify exactly
 * as it does for any other adapter.
 */

const INCIDENT_TOOL_ADAPTER_ID = 'aic.incident-tool';
const INCIDENT_TOOL_ADAPTER_VERSION = '1';

/**
 * `BoundSourceRegistry` is the single writer of `EvidenceSourceOutcome`
 * provenance (see `./bound-source-registry.ts`'s own doc comment): it reads
 * `describe()` once at construction and rebuilds every provenance field
 * itself on every `execute()` call, discarding whatever provenance an
 * adapter's own `execute()` hands back. This placeholder is therefore never
 * observed by any caller of a registry built over this source — it exists
 * only because `EvidenceSourceOutcome` requires the field.
 */
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
