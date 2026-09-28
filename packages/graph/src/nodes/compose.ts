import type { ExecuteInvestigationContext } from '../index.js';
import type { InvestigationNodes } from '../investigation.js';
import { createDeriveHypothesisState } from './derive-hypothesis-state.js';
import { createDerivePredictions } from './derive-predictions.js';
import { createEvaluatePredictions } from './evaluate-predictions.js';
import { createExecuteInvestigation, type ExecuteInvestigationOutcome } from './execute-investigation.js';
import { createPlanInvestigation } from './plan-investigation.js';
import { createStateTerminationCheck } from './termination.js';

/**
 * AIC-126 slice a: the four roles a caller (a lane, a CLI) chooses — scripted
 * or model-backed — never the eight canonical nodes below.
 */
const REASONING_KEYS = [
  'generate_hypotheses',
  'interpret_residual_evidence',
  'challenge_hypothesis',
  'propose_conclusion',
] as const;

export type InvestigationReasoning = Pick<InvestigationNodes, (typeof REASONING_KEYS)[number]>;

function validateReasoning(reasoning: Readonly<Record<string, unknown>>): void {
  if (typeof reasoning !== 'object' || reasoning === null) {
    throw new TypeError('createInvestigationNodes: reasoning must be an object carrying the four reasoning roles');
  }
  const keys = Object.keys(reasoning);
  const missing = REASONING_KEYS.filter((key) => !keys.includes(key));
  if (missing.length > 0) {
    throw new TypeError(
      `createInvestigationNodes: reasoning is missing required key(s): ${missing.join(', ')}`,
    );
  }
  const extra = keys.filter((key) => !(REASONING_KEYS as readonly string[]).includes(key));
  if (extra.length > 0) {
    throw new TypeError(
      `createInvestigationNodes: reasoning carries unexpected key(s): ${extra.join(', ')}`,
    );
  }
  const notFunctions = REASONING_KEYS.filter((key) => typeof reasoning[key] !== 'function');
  if (notFunctions.length > 0) {
    throw new TypeError(
      `createInvestigationNodes: reasoning role(s) must be functions: ${notFunctions.join(', ')}`,
    );
  }
}

/**
 * AIC-126 slice a: `@aic/graph`'s one canonical, package-owned composition of
 * the investigation's twelve nodes.
 *
 * `reasoning`'s four roles (`generate_hypotheses`, `interpret_residual_evidence`,
 * `challenge_hypothesis`, `propose_conclusion`) are wired by identity — the
 * caller owns whether they are scripted or model-backed, and this function
 * neither wraps nor inspects them beyond checking the reasoning object carries
 * exactly those four keys. A reasoning object missing a role, or carrying an
 * extra one, throws a `TypeError` naming the offending key(s): a lane that
 * silently ran with seven live roles or five instead of four is a defect this
 * catches at wiring time rather than at whatever node happens to be called
 * first.
 *
 * `normalize_incident` and `collect_baseline` are canonical no-ops
 * (`() => ({})`): no normalisation or baseline-collection step exists yet in
 * any arm, so there is nothing for either node to do.
 *
 * The other six nodes are the canonical, state-driven factories this package
 * already exports individually (`createDerivePredictions`,
 * `createPlanInvestigation`, `createExecuteInvestigation`,
 * `createEvaluatePredictions`, `createDeriveHypothesisState`,
 * `createStateTerminationCheck`), called with their defaults except for
 * `execute` and `asOf`, which only the caller can supply.
 * see investigation-nodes-composition.test.mjs for the behavioural proof of
 * every row.
 */
export function createInvestigationNodes({
  reasoning,
  execute,
  asOf,
}: Readonly<{
  reasoning: InvestigationReasoning;
  execute(context: ExecuteInvestigationContext): Promise<ExecuteInvestigationOutcome>;
  asOf: () => string;
}>): InvestigationNodes {
  validateReasoning(reasoning as unknown as Readonly<Record<string, unknown>>);

  return {
    normalize_incident: () => ({}),
    collect_baseline: () => ({}),
    generate_hypotheses: reasoning.generate_hypotheses,
    derive_predictions: createDerivePredictions(),
    plan_investigation: createPlanInvestigation(),
    execute_investigation: createExecuteInvestigation({ execute }),
    evaluate_predictions: createEvaluatePredictions({ asOf }),
    interpret_residual_evidence: reasoning.interpret_residual_evidence,
    derive_hypothesis_state: createDeriveHypothesisState(),
    termination_check: createStateTerminationCheck(),
    challenge_hypothesis: reasoning.challenge_hypothesis,
    propose_conclusion: reasoning.propose_conclusion,
  };
}
