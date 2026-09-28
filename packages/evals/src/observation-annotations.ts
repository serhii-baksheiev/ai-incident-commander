import type { ObservedFact } from '@aic/domain';

/**
 * AIC-123 slice 3a — the owner's D3 ruling on AIC-123 (Jira comment, 2026-09-25):
 * typed facts for the corpus come from a separate, versioned sidecar table,
 * not from the fixtures themselves. Each fact follows from its own evidence
 * item's prose only; the table is digest-frozen before any
 * prediction-derivation template exists, and was blind-reviewed. Fixtures
 * stay unchanged.
 * see observation-annotations.test.mjs › "freezes OBSERVATION_ANNOTATIONS at
 * the reviewed digest: a content change is a new dated, reviewed version,
 * never an edit to this one"
 *
 * Keyed by (replay identity, evidence id), not identity alone: one replay
 * identity serves several evidence items in this corpus.
 * see observation-annotations.test.mjs › "the ok corpus really serves the
 * same replay identity for more than one distinct evidence item, so identity
 * alone cannot key this table"
 * see observation-annotations.test.mjs › "carries exactly one row per
 * distinct (replay identity, evidence id) pair the ok corpus serves, none
 * missing and none extra"
 * The identity itself is the v2 replay identity
 * (`packages/tools/src/bound-source-registry.ts`, `buildReplayIdentity`).
 *
 * Each row's `facts` is the deep-equality INTERSECTION of two independent
 * blind readers, each shown only the prose packet
 * (`scripts/observation-review-packet.mjs`, recorded at
 * `docs/evidence/observation-annotations/review-v1.json`) — never the
 * evidence ids, sources, scenario ids or ground truth.
 * see observation-annotations.test.mjs › "the packet carries no evidence id,
 * no scenario id, and no evidence source string — the reader sees prose only"
 * see observation-annotations.test.mjs › "every row's facts equal the
 * deep-equality intersection of the two readers' facts for that row's own
 * packet sentence number"
 *
 * No sentence claims an exhaustive check, so no fact here can read as
 * `absent` under `observedPresence` (`@aic/domain`).
 * see observation-annotations.test.mjs › "no fact in the table reads as absent under observedPresence, because no sentence claims an exhaustive check"
 *
 * A content change is a new dated, reviewed version (e.g.
 * `observation-annotations-v2`), never an edit to this file's exports.
 *
 * Nothing reads this table yet — the merge at the replay boundary is a later
 * slice.
 */

export const OBSERVATION_ANNOTATIONS_VERSION = 'observation-annotations-v1' as const;

export interface ObservationAnnotationRow {
  readonly identity: string;
  readonly evidenceId: string;
  readonly statement: string;
  readonly facts: readonly ObservedFact[];
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

const RAW_OBSERVATION_ANNOTATIONS: readonly ObservationAnnotationRow[] = [
  {
    identity:
      'v2:["deployments","aic.incident-tool@1","sha256:1bc204853172acd2dcc3ce370f4487b090ff54e9baf737ca7f5ef0aac05bae60"]',
    evidenceId: 'checkout-deploy-v42',
    statement: 'checkout-v42 changed the database endpoint configuration',
    facts: [],
  },
  {
    identity:
      'v2:["logs","aic.incident-tool@1","sha256:400e29c64f128f1c8665e44756b36f9847e24c53af13ad45cb5394f820abcf48"]',
    evidenceId: 'checkout-invalid-database-endpoint',
    statement: 'checkout rejected the database endpoint after checkout-v42',
    facts: [],
  },
  {
    identity:
      'v2:["metrics","aic.incident-tool@1","sha256:a477728ddc0ec3618a47b45b70b09a51b33334c8a542968ccd10ceec6b972367"]',
    evidenceId: 'checkout-db-pool-active',
    statement: 'active connections equalled the configured pool maximum',
    facts: [],
  },
  {
    identity:
      'v2:["logs","aic.incident-tool@1","sha256:e831e1589d269ad27c37abc24acf3e785149e19dd9aa0363c24be6d39db166ac"]',
    evidenceId: 'checkout-db-pool-timeout',
    statement: 'requests timed out while acquiring a database connection',
    facts: [],
  },
  {
    identity:
      'v2:["metrics","aic.incident-tool@1","sha256:378637bfc53f26193809010781d30f2c7e79acffe85a5c8f0d703759091dcb29"]',
    evidenceId: 'checkout-normal-error-rate',
    statement: 'the error rate remained below the incident threshold',
    facts: [],
  },
  {
    identity:
      'v2:["logs","aic.incident-tool@1","sha256:347f12351e25e827c63c4d05a81aac919193b5f4de396a6a8c53f74174bdba0f"]',
    evidenceId: 'checkout-no-server-errors',
    statement: 'no matching server errors were recorded',
    facts: [],
  },
  {
    identity:
      'v2:["deployments","aic.incident-tool@1","sha256:5ddff50d9f8ddaf7d35338f315a2861893b6edd7e7b5f8f3ffaae1edc59d74d5"]',
    evidenceId: 'confirmation-deploy-v17',
    statement: 'payments-v17 completed five minutes before the first alert',
    facts: [
      { form: 'deployment-in-window', subject: 'payments', window: 'pre-onset', count: 1, coverage: 'partial' },
    ],
  },
  {
    identity:
      'v2:["dependencies","aic.incident-tool@1","sha256:4a87efa380e51ce2fee81f1e4bbadfb0d9497ffebe551c5951583421148d7c2e"]',
    evidenceId: 'payments-dependencies-healthy',
    statement: 'payments dependencies stayed healthy during the incident window',
    facts: [
      {
        form: 'signal-state',
        subject: 'payments',
        window: 'incident',
        signal: 'dependency-health',
        state: 'normal',
      },
    ],
  },
  {
    identity:
      'v2:["dependencies","aic.incident-tool@1","sha256:4a87efa380e51ce2fee81f1e4bbadfb0d9497ffebe551c5951583421148d7c2e"]',
    evidenceId: 'inventory-api-pool-saturation',
    statement: 'inventory-api reported connection pool saturation',
    facts: [],
  },
  {
    identity:
      'v2:["metrics","aic.incident-tool@1","sha256:71b48c1bef7f20015cc6eb6dede75a386c99f5d03c433dd79a62ca2bfe643165"]',
    evidenceId: 'payments-error-rate-incident',
    statement: 'payment error rate rose during the incident window',
    facts: [
      { form: 'signal-state', subject: 'payment', window: 'incident', signal: 'error-rate', state: 'elevated' },
    ],
  },
  {
    identity:
      'v2:["dependencies","aic.incident-tool@1","sha256:4a87efa380e51ce2fee81f1e4bbadfb0d9497ffebe551c5951583421148d7c2e"]',
    evidenceId: 'inventory-api-latency-incident',
    statement: 'inventory-api latency rose during the same incident window',
    facts: [
      {
        form: 'signal-state',
        subject: 'inventory-api',
        window: 'incident',
        signal: 'latency',
        state: 'elevated',
      },
    ],
  },
  {
    identity:
      'v2:["metrics","aic.incident-tool@1","sha256:98485be3126ffa6d5357553236cc12cde98425682e088ecb79a24e4f1ed15b4d"]',
    evidenceId: 'payments-cache-transient-saturation',
    statement: 'worker saturation appeared only during the incident window',
    facts: [],
  },
  {
    identity:
      'v2:["logs","aic.incident-tool@1","sha256:1956e2f972e67e833f8dd6604a728fb8a1d4b9a937c9c6e7af087e255b53f1a3"]',
    evidenceId: 'payments-cache-refill-ended',
    statement: 'the cache refill burst ended before the recovery window',
    facts: [],
  },
  {
    identity:
      'v2:["logs","aic.incident-tool@1","sha256:82360e769ec920338ba4ead7e50e3d1bc94aaaa81fa7afd0e956d2da08216841"]',
    evidenceId: 'checkout-intermittent-upstream-timeout',
    statement: 'checkout recorded intermittent upstream timeout symptoms',
    facts: [],
  },
  {
    identity:
      'v2:["deployments","aic.incident-tool@1","sha256:b9603044d291d1f9eea084431d262d79e2fc97dacde4f0371ce54fddd68d3cef"]',
    evidenceId: 'payments-deployment-overlap',
    statement: 'a payments deployment overlapped the incident window',
    facts: [
      { form: 'deployment-in-window', subject: 'payments', window: 'incident', count: 1, coverage: 'partial' },
    ],
  },
  {
    identity:
      'v2:["dependencies","aic.incident-tool@1","sha256:c83a72c22943e29e1915bb14dadd9b3df4a2d13495bfd3d49e8188902f71ebb1"]',
    evidenceId: 'inventory-api-challenge-saturation',
    statement: 'inventory-api reported connection pool saturation',
    facts: [],
  },
  {
    identity:
      'v2:["deployments","aic.incident-tool@1","sha256:9fef387c3a6f49a5bf3589fa754adecca3a6e0beb14b2b10bcb1e2f57f21c142"]',
    evidenceId: 'payments-v19-before-timeouts',
    statement: 'payments-v19 completed immediately before authorization timeouts began',
    facts: [
      { form: 'deployment-in-window', subject: 'payments', window: 'pre-onset', count: 1, coverage: 'partial' },
    ],
  },
  {
    identity:
      'v2:["logs","aic.incident-tool@1","sha256:6ab88e1a1ea6baf5c6c9566f2e74002ba755ad34af0024788022af1d7fbae6b3"]',
    evidenceId: 'payments-v19-authorization-timeouts',
    statement: 'authorization timeouts started after payments-v19',
    facts: [],
  },
  {
    identity:
      'v2:["dependencies","aic.incident-tool@1","sha256:9b59e058487299dc7c875d10ad13c8c3dd38b0c5b6cdbb1d3d64ca77d6f0170f"]',
    evidenceId: 'payments-v19-dependencies-healthy',
    statement: 'payments dependencies remained healthy during the incident window',
    facts: [
      {
        form: 'signal-state',
        subject: 'payments',
        window: 'incident',
        signal: 'dependency-health',
        state: 'normal',
      },
    ],
  },
];

export const OBSERVATION_ANNOTATIONS: readonly ObservationAnnotationRow[] = deepFreeze(
  RAW_OBSERVATION_ANNOTATIONS,
);
