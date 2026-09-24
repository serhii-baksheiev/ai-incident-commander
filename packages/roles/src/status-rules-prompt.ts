/**
 * AIC-119 slice 5 part C (owner ruling D1, item 6): `propose_conclusion`
 * already shows the model `derived hypothesis statuses`, including the word
 * `corroborated`, with no definition of any status anywhere in the prompt —
 * exactly the gap owner ruling D1 item 6 requires the preregistration to name
 * before calibration. `describeStatusRules` closes it by GENERATING one
 * definition sentence per status directly from the status-rules table's own
 * rule fields (`packages/domain/src/status-rules.ts`), rather than a
 * hand-written sentence per status name that could silently drift the day the
 * table changes.
 *
 * The field-by-field reading below mirrors the check order
 * `deriveHypothesisStatus` (`packages/domain/src/evaluation.ts`) actually
 * runs: `rejected` first, then `weakened`, then `supported`, then
 * `corroborated`, then the `fallback` status — `table.hypothesis.precedence`
 * is read to say so in each sentence, rather than assuming that array order.
 * see conclusion-role.test.mjs › "describeStatusRules names exactly the statuses the table declares: no status missing, none extra"
 * see conclusion-role.test.mjs › "the corroborated and supported sentences carry the table's own numbers and strengths"
 * see conclusion-role.test.mjs › "a mutated table (minimumIndependentSupports 3) yields a different corroborated sentence containing 3, proving the text is generated"
 * see conclusion-role.test.mjs › "propose_conclusion's system prompt contains every sentence describeStatusRules(STATUS_RULES[STATUS_RULES_VERSION]) returns"
 */

/**
 * The rule fields `deriveHypothesisStatus` reads off one status's rule
 * object. Every field is optional here because each status in
 * `STATUS_RULES` (`v0.1` and `v0.2`) carries only the subset its own check
 * uses — this type is a structural superset of both tables' rule shapes, not
 * a status-specific one, so the same generator reads either version.
 */
interface StatusRuleDefinition {
  readonly fallback?: boolean;
  readonly minimumIndependentSupports?: number;
  readonly independenceKey?: string;
  readonly supportStrengths?: readonly string[];
  readonly forbiddenContradictionStrengths?: readonly string[];
  readonly minimumConfirmedPredictions?: number;
  readonly maximumConfirmedPredictions?: number;
  readonly contradictionStrengths?: readonly string[];
  readonly predictionStatus?: string;
  readonly evidenceReliability?: string;
}

/**
 * The shape `describeStatusRules` needs from a status-rules table — a
 * structural reading of `STATUS_RULES[version]`
 * (`packages/domain/src/status-rules.ts`), not a copy of its literal types,
 * so a table gaining a status or a rule field keeps type-checking here
 * without this file changing.
 */
export interface StatusRulesTableLike {
  readonly hypothesis: {
    readonly statuses: readonly string[];
    readonly precedence: readonly string[];
    readonly rules: { readonly [status: string]: StatusRuleDefinition };
  };
}

function listOr(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} or ${items[1]}`;
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`;
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Describes where a status's check sits in the precedence order, so the
 * sentence carries the table's own precedence rather than leaving it
 * implicit. Mirrors `deriveHypothesisStatus`'s actual check order: earlier
 * statuses in `precedence` are checked, and matched, first — a hypothesis
 * that would also qualify for a later status still reports the earliest one
 * that matches.
 */
function describePrecedence(status: string, precedence: readonly string[]): string {
  const index = precedence.indexOf(status);
  if (index <= 0) {
    return ' This is checked before every other status, so nothing later can override it.';
  }
  const earlier = precedence.slice(0, index).map((name) => `'${name}'`);
  return ` This is only reached once ${listOr(earlier)} ${earlier.length > 1 ? 'have' : 'has'} already been ruled out.`;
}

/**
 * Turns one status's rule fields into the clauses `deriveHypothesisStatus`
 * actually evaluates for it, generated from the fields present rather than
 * from the status's name.
 */
function describeRuleClauses(rule: StatusRuleDefinition): string[] {
  const clauses: string[] = [];

  if (typeof rule.minimumIndependentSupports === 'number') {
    const strengths = rule.supportStrengths ?? [];
    const independenceKey = rule.independenceKey ?? 'evidence id';
    clauses.push(
      `at least ${pluralize(rule.minimumIndependentSupports, 'independent supporting assessment')} (distinct ${independenceKey})${
        strengths.length > 0 ? ` at strength ${listOr(strengths)}` : ''
      }`,
    );
  }

  if (rule.forbiddenContradictionStrengths && rule.forbiddenContradictionStrengths.length > 0) {
    clauses.push(`no contradicting assessment at strength ${listOr(rule.forbiddenContradictionStrengths)}`);
  }

  if (typeof rule.minimumConfirmedPredictions === 'number') {
    clauses.push(`at least ${pluralize(rule.minimumConfirmedPredictions, 'confirmed prediction')}`);
  }

  if (typeof rule.maximumConfirmedPredictions === 'number') {
    clauses.push(`at most ${pluralize(rule.maximumConfirmedPredictions, 'confirmed prediction')}`);
  }

  if (rule.contradictionStrengths && rule.contradictionStrengths.length > 0) {
    clauses.push(`at least one contradicting assessment at strength ${listOr(rule.contradictionStrengths)}`);
  }

  if (rule.predictionStatus !== undefined) {
    clauses.push(`a contradicted prediction with status '${rule.predictionStatus}'`);
  }

  if (rule.evidenceReliability !== undefined) {
    clauses.push(`the contradicting evidence at reliability '${rule.evidenceReliability}'`);
  }

  return clauses;
}

function joinClauses(clauses: readonly string[]): string {
  if (clauses.length === 0) return '';
  if (clauses.length === 1) return clauses[0];
  if (clauses.length === 2) return `${clauses[0]}, and ${clauses[1]}`;
  return `${clauses.slice(0, -1).join(', ')}, and ${clauses[clauses.length - 1]}`;
}

/**
 * One definition sentence per status named in `table.hypothesis.statuses`,
 * keyed by status name so "no status missing, none extra" is a key-set
 * comparison against the table rather than a length count that could hide a
 * duplicate. Every number, strength and field name in a sentence is read
 * from `table` at call time — mutate the table and the sentence changes with
 * it, which is what proves the text is generated rather than hand-written.
 */
export function describeStatusRules(table: StatusRulesTableLike): Record<string, string> {
  const { statuses, precedence, rules } = table.hypothesis;
  const sentences: Record<string, string> = {};

  for (const status of statuses) {
    const rule = rules[status];
    if (rule?.fallback) {
      sentences[status] = `'${status}' is the fallback status: it applies whenever a hypothesis matches none of the other statuses.`;
      continue;
    }

    const clauses = rule ? describeRuleClauses(rule) : [];
    const requirement = clauses.length > 0 ? joinClauses(clauses) : 'no stated requirement';
    sentences[status] = `'${status}' requires ${requirement}.${describePrecedence(status, precedence)}`;
  }

  return sentences;
}
