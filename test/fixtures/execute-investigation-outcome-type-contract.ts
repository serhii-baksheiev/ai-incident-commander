import type { Evidence, EvidenceProvenance } from '@aic/domain';
import type { ExecuteInvestigationOutcome, ExecuteInvestigationResult } from '@aic/graph';
import type { ToolResult } from '@aic/tools';

// `@aic/graph` cannot import `@aic/tools`, so the executor's port declares
// its own result shape. This file is the correspondence check between the
// two copies: every tool result is an acceptable executor outcome, and the
// two name exactly the same statuses, in both directions.
const accepted: ExecuteInvestigationOutcome = null as unknown as ToolResult<Evidence[]>;

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const sameStatuses: Same<ToolResult<Evidence[]>['status'], ExecuteInvestigationOutcome['status']> = true;
// Every variant, payload included, in both directions: the executor's port is
// exactly a tool result over a read-only evidence list.
const sameVariants: Same<ToolResult<readonly Evidence[]>, ExecuteInvestigationOutcome> = true;

// AIC-146 b2: an added optional member keeps `sameVariants` above passing
// whether or not the ok branch carries a `provenance` slot at all (both
// `extends` directions still hold), so that check alone would not notice a
// missing or mistyped one. Pinned separately, on the narrowed 'ok' member.
type OkOutcome = Extract<ExecuteInvestigationOutcome, { status: 'ok' }>;
const okProvenanceIsExactlyOptional: Same<OkOutcome['provenance'], EvidenceProvenance | undefined> = true;

// Provenance travels alongside the durable runner's evidence, on
// ExecuteInvestigationResult.provenance, never inside evidence itself.
const evidenceFieldsCarryNoProvenance: ExecuteInvestigationResult['evidence'] = {
  kind: 'log',
  source: 'fixture',
  observedAt: '2026-09-24T00:00:00.000Z',
  statement: 'a statement',
  rawRef: 'fixture://ref',
  // @ts-expect-error ExecuteInvestigationResult['evidence'] must never accept a provenance field: it travels alongside, on ExecuteInvestigationResult.provenance, never inside evidence
  provenance: null as unknown as EvidenceProvenance,
};

void accepted;
void sameStatuses;
void sameVariants;
void okProvenanceIsExactlyOptional;
void evidenceFieldsCarryNoProvenance;
