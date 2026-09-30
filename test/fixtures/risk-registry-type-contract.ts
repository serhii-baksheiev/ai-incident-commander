/**
 * AIC-21 slice 1: the compile-time half of the risk-vocabulary contract —
 * `@aic/tools`'s `ToolRisk` must be exactly `@aic/domain`'s `RiskClass`, one
 * spelling of the risk vocabulary rather than two independently maintained
 * unions (`.claude/rules/invariants.md`, "one mechanism, one
 * implementation").
 *
 * A real value, not a `declare`: like its sibling fixtures
 * (test/fixtures/evidence-provenance-type-contract.ts,
 * test/fixtures/scoped-domain-type-contract.ts), `test/fixtures` is swept by
 * node's default test-file discovery, so this file is also EXECUTED with its
 * types stripped — every binding below must be valid plain JavaScript too.
 * No `node:` import here: every sibling `*-type-contract.ts` fixture is
 * compiled standalone, `--ignoreConfig`, with no `@types/node` in scope.
 */
import type { RiskClass } from '@aic/domain';
import type { ToolRisk } from '@aic/tools';

function acceptsToolRisk(value: ToolRisk): void {
  void value;
}

function acceptsRiskClass(value: RiskClass): void {
  void value;
}

// Built and typed against the DOMAIN vocabulary, then handed to a function
// that only accepts the TOOLS vocabulary: this compiles only if the two are
// the same union.
const riskClassValue: RiskClass = 'safe-write';
acceptsToolRisk(riskClassValue);

// The mirror image.
const toolRiskValue: ToolRisk = 'dangerous';
acceptsRiskClass(toolRiskValue);

/**
 * Mutual assignability alone would still accept a `ToolRisk` widened with an
 * extra member `RiskClass` lacks, or the reverse — a union comparison in one
 * direction only cannot see that. Mutual `extends` closes the gap: green only
 * when the two unions name exactly the same members.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const exact: Exact<ToolRisk, RiskClass> = true;
void exact;

// Not vacuous: a member outside the three-value vocabulary is refused by
// both, or a widened union would satisfy this whole file for the wrong
// reason.
// @ts-expect-error ToolRisk never accepts a member outside read | safe-write | dangerous
const notARisk: ToolRisk = 'delete';
void notARisk;

void acceptsToolRisk;
void acceptsRiskClass;
