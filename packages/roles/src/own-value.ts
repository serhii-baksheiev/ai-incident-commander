/**
 * Read one OWN data property of a value the caller supplied.
 *
 * A plain `[[Get]]` walks the prototype chain, so an object owning nothing
 * appears to carry whatever `Object.prototype` carries. Two reads in this
 * package take caller data — the environment record handed to
 * `resolveModelConfig`, and the JSON body a provider returned — and both would
 * otherwise be decidable by prototype pollution: one turns the live lane ON from
 * an environment that owns no credential, the other publishes a token count no
 * response declared.
 * see roles-port-contract.test.mjs › "reads the credential variable as an own
 * property of the supplied environment"
 * see roles-port-contract.test.mjs › "reads the completion off own properties of
 * the provider payload"
 *
 * ⚠ Limit, stated because "one mechanism, one implementation"
 * (`.claude/rules/invariants.md`) is the rule this file sits closest to: this is
 * the THIRD private spelling of that read in this repository — `ownValue` in
 * `packages/observability/src/index.ts` and `readOwnDataValue` in
 * `packages/graph/src/investigation.ts` are the other two. It is private here for
 * the same reason theirs are private there: sharing one would make
 * `packages/roles` depend on `packages/observability` (and so on `langsmith`)
 * for a four-line read. Inside this package there is exactly one copy, which is
 * the part a single package can hold itself.
 * see roles-boundary.test.mjs › "keeps one own-property read for the whole roles
 * package"
 *
 * An accessor is refused rather than invoked, and the `Object.hasOwn` below is
 * what does it. An ACCESSOR descriptor owns `get`/`set` and no `value`, so
 * reading `descriptor.value` off it is itself a prototype-chain read — a planted
 * `Object.prototype.value` then answers for every accessor, which is the exact
 * defect this function exists to prevent, inside the function. Both copies this
 * file names carry the same guard; the first version here did not, and
 * `code-reviewer` measured the divergence at the AIC-94 gate.
 * see roles-boundary.test.mjs › "spells the own-property read the same way as
 * the two copies it names"
 */
export function ownValue(target: unknown, key: string): unknown {
  if (typeof target !== 'object' || target === null) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  return descriptor === undefined || !Object.hasOwn(descriptor, 'value')
    ? undefined
    : descriptor.value;
}

/** The same read, narrowed to a non-empty string. */
export function ownTrimmedString(
  target: unknown,
  key: string,
): string | undefined {
  const value = ownValue(target, key);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
