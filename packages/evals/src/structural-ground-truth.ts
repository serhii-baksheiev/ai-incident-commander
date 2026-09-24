/**
 * Structural ground truth: which evidence each scenario expects, by the ids its
 * own fixture shows, and its root cause as a stable component plus a mechanism
 * from a closed vocabulary.
 *
 * ## Why a second table, beside the accepted ground truth rather than in it
 *
 * The accepted ground truth names evidence by a hand-written predicate that no
 * fixture statement equals, so no arm — not even the oracle — could ever be
 * credited with finding it (docs/evidence/oracle/behavior-evaluators-v0.2.json),
 * and it names a root cause in free prose that only a copy of that prose could
 * match. This table makes both comparisons structural and deterministic.
 *
 * It lives beside `REPLAY_SCENARIOS` rather than inside it because the five
 * accepted v0.1 scenarios are frozen byte for byte — see replay-scenarios.test.mjs
 * › "preserves the five accepted v0.1 ground truths and replay fixtures" — and
 * are not rewritten. The accepted fields stay what the accepted evaluator
 * version (`behavior-evaluators-v0.2`) reads; this table is what
 * `behavior-evaluators-v0.3` reads.
 *
 * Its correspondence with the accepted data is checked rather than trusted:
 * every id is one the scenario's fixture shows, every root cause names the
 * accepted component, and the counts match the accepted lists.
 * see structural-ground-truth.test.mjs › "every expected and misleading id the
 * structural table names is an evidence id the scenario's own fixture actually
 * shows"
 */
export const STRUCTURAL_GROUND_TRUTH_VERSION = 'structural-ground-truth-v1' as const;

/**
 * The closed mechanism vocabulary: the fewest classes that tell this corpus's
 * root causes apart, and nothing speculative beyond them.
 *
 * - `deployment-regression` — a change shipped by a deployment broke the service
 *   (bad-deployment, deployment-caused-incident-a, challenge-keeps-leader);
 * - `connection-pool-exhaustion` — every connection in a pool stayed occupied
 *   (db-pool-exhaustion, and the dependency's pool in
 *   dependency-caused-incident-b);
 * - `cache-stampede` — a burst of cache refills exhausted request workers
 *   (transient-self-resolved).
 *
 * A new scenario whose mechanism none of these describes extends this list, and
 * bumps `STRUCTURAL_GROUND_TRUTH_VERSION`, in the same change.
 */
export const ROOT_CAUSE_MECHANISMS = Object.freeze([
  'deployment-regression',
  'connection-pool-exhaustion',
  'cache-stampede',
] as const);

export type RootCauseMechanism = (typeof ROOT_CAUSE_MECHANISMS)[number];

export interface StructuralRootCause {
  readonly component: string;
  readonly mechanism: RootCauseMechanism;
}

export interface StructuralGroundTruthEntry {
  readonly expectedEvidenceIds: readonly string[];
  readonly misleadingEvidenceIds?: readonly string[];
  readonly rootCause?: StructuralRootCause;
}

function entry(value: StructuralGroundTruthEntry): StructuralGroundTruthEntry {
  return Object.freeze({
    expectedEvidenceIds: Object.freeze([...value.expectedEvidenceIds]),
    ...(value.misleadingEvidenceIds === undefined
      ? {}
      : { misleadingEvidenceIds: Object.freeze([...value.misleadingEvidenceIds]) }),
    ...(value.rootCause === undefined
      ? {}
      : { rootCause: Object.freeze({ ...value.rootCause }) }),
  });
}

export const STRUCTURAL_GROUND_TRUTH: Readonly<Record<string, StructuralGroundTruthEntry>> =
  Object.freeze({
    'bad-deployment': entry({
      expectedEvidenceIds: ['checkout-deploy-v42', 'checkout-invalid-database-endpoint'],
      rootCause: { component: 'checkout', mechanism: 'deployment-regression' },
    }),
    'db-pool-exhaustion': entry({
      expectedEvidenceIds: ['checkout-db-pool-active', 'checkout-db-pool-timeout'],
      rootCause: { component: 'checkout-db-pool', mechanism: 'connection-pool-exhaustion' },
    }),
    'false-alert': entry({
      expectedEvidenceIds: ['checkout-normal-error-rate', 'checkout-no-server-errors'],
    }),
    'deployment-caused-incident-a': entry({
      expectedEvidenceIds: ['confirmation-deploy-v17'],
      rootCause: { component: 'payments', mechanism: 'deployment-regression' },
    }),
    'dependency-caused-incident-b': entry({
      expectedEvidenceIds: ['inventory-api-pool-saturation'],
      misleadingEvidenceIds: ['confirmation-deploy-v17'],
      rootCause: { component: 'inventory-api', mechanism: 'connection-pool-exhaustion' },
    }),
    'multiple-plausible-causes': entry({
      expectedEvidenceIds: ['payments-error-rate-incident', 'inventory-api-latency-incident'],
    }),
    'transient-self-resolved': entry({
      expectedEvidenceIds: ['payments-cache-transient-saturation', 'payments-cache-refill-ended'],
      rootCause: { component: 'payments-cache', mechanism: 'cache-stampede' },
    }),
    'challenge-keeps-leader': entry({
      expectedEvidenceIds: ['payments-v19-before-timeouts', 'payments-v19-authorization-timeouts'],
      rootCause: { component: 'payments', mechanism: 'deployment-regression' },
    }),
    'incomplete-evidence': entry({
      expectedEvidenceIds: ['checkout-intermittent-upstream-timeout'],
    }),
    'challenge-changes-leader': entry({
      expectedEvidenceIds: ['inventory-api-challenge-saturation'],
      misleadingEvidenceIds: ['payments-deployment-overlap'],
      rootCause: { component: 'inventory-api', mechanism: 'connection-pool-exhaustion' },
    }),
  });

/**
 * The structural ground truth for one scenario, or a refusal: a scenario this
 * table does not name cannot be scored by the structural evaluator, and scoring
 * it against nothing would read as a scenario with nothing to find.
 */
export function structuralGroundTruthFor(scenarioId: string): StructuralGroundTruthEntry {
  if (!Object.hasOwn(STRUCTURAL_GROUND_TRUTH, scenarioId)) {
    throw new Error(
      `no structural ground truth for scenario ${scenarioId}: add it to STRUCTURAL_GROUND_TRUTH before scoring it with the structural evaluator`,
    );
  }
  return STRUCTURAL_GROUND_TRUTH[scenarioId] as StructuralGroundTruthEntry;
}

const MECHANISMS: ReadonlySet<string> = new Set(ROOT_CAUSE_MECHANISMS);

function normalizedComponent(component: string): string {
  return component.trim().toLowerCase();
}

/**
 * Does a claimed cause name the structural root cause?
 *
 * The component is compared after trimming and lower-casing, because it is an
 * identifier an arm copies from telemetry. The mechanism is compared EXACTLY and
 * must be a member of the closed vocabulary: a mechanism outside it — the
 * accepted v0.1 prose included — fails closed, and there is no prose-similarity
 * fallback. Anything else a cause carries, such as its trigger, is not compared.
 * see structural-ground-truth.test.mjs › "matchesRootCause fails closed on the
 * accepted v0.1 prose mechanism for the same component" and › "matchesRootCause
 * fails closed when the truth itself names a mechanism outside the taxonomy"
 */
export function matchesRootCause(truth: StructuralRootCause, claimed: unknown): boolean {
  if (claimed === null || typeof claimed !== 'object') return false;
  const component = Object.getOwnPropertyDescriptor(claimed, 'component')?.value;
  const mechanism = Object.getOwnPropertyDescriptor(claimed, 'mechanism')?.value;
  return (
    typeof component === 'string' &&
    typeof mechanism === 'string' &&
    MECHANISMS.has(mechanism) &&
    mechanism === truth.mechanism &&
    normalizedComponent(component) === normalizedComponent(truth.component)
  );
}
