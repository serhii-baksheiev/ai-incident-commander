import type { Evidence } from '@aic/domain';
import type { ExecuteInvestigationOutcome } from '@aic/graph';
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

void accepted;
void sameStatuses;
void sameVariants;
