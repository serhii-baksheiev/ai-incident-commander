import { READ_ONLY_TOOL_REGISTRY } from './contracts.js';
import type {
  EvidenceSource,
  EvidenceSourceCheckResult,
  EvidenceSourceOutcome,
  EvidenceSourceProvenance,
  EvidenceSourceRefusalReason,
} from './evidence-source.js';

/**
 * AIC-98, slice a: `lab@1`, a formal `EvidenceSource` over the Incident
 * Lab's `/observations/:toolId` and `/health` routes
 * (`incident-lab/services/api.mjs`), replacing the ad-hoc
 * `createObservationTool` built inline in
 * `incident-lab/src/scenario-candidates.mjs`. See
 * test/lab-evidence-source.test.mjs for the pinned contract. Provenance here
 * is a placeholder: `BoundSourceRegistry` is the single writer of
 * provenance and overwrites it (`./bound-source-registry.ts`).
 */

const LAB_ADAPTER_ID = 'lab';
const LAB_ADAPTER_VERSION = '1';

const PLACEHOLDER_PROVENANCE: EvidenceSourceProvenance = Object.freeze({
  sourceBindingId: '',
  adapter: '',
  credentialRefId: null,
  fetchedAt: '',
  requestFingerprint: '',
});

type LabResponse = {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
};

type LabFetch = (url: URL, init: { readonly redirect: 'error' }) => Promise<LabResponse>;

export interface LabEvidenceSourceOptions {
  readonly baseUrl: string;
  readonly fetch?: LabFetch;
}

/** The only three refusal reasons this adapter's HTTP mapping ever produces. */
function reasonForStatus(status: number): EvidenceSourceRefusalReason {
  if (status === 401 || status === 403) return 'denied';
  if (status === 429) return 'rate_limited';
  return 'unavailable';
}

export function createLabEvidenceSource(options: LabEvidenceSourceOptions): EvidenceSource {
  const { baseUrl } = options;
  const fetchFn = options.fetch ?? (globalThis.fetch as LabFetch);
  const operations = READ_ONLY_TOOL_REGISTRY.map((entry) => entry.id);
  const operationSet = new Set<string>(operations);

  return {
    describe() {
      return { adapterId: LAB_ADAPTER_ID, version: LAB_ADAPTER_VERSION, operations };
    },

    async check(): Promise<EvidenceSourceCheckResult> {
      const response = await fetchFn(new URL('/health', baseUrl), { redirect: 'error' });
      return response.ok ? { status: 'ready' } : { status: 'refused', reason: reasonForStatus(response.status) };
    },

    async execute(operation, input): Promise<EvidenceSourceOutcome<unknown>> {
      if (!operationSet.has(operation)) {
        return { status: 'refused', reason: 'unavailable', provenance: PLACEHOLDER_PROVENANCE };
      }

      const query = new URLSearchParams(input as Record<string, string>);
      const url = new URL(`/observations/${operation}?${query.toString()}`, baseUrl);
      const response = await fetchFn(url, { redirect: 'error' });

      if (!response.ok) {
        return { status: 'refused', reason: reasonForStatus(response.status), provenance: PLACEHOLDER_PROVENANCE };
      }

      const output = await response.json();
      return { status: 'ok', output, provenance: PLACEHOLDER_PROVENANCE };
    },
  };
}
