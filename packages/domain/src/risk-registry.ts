import { z } from 'zod';

/**
 * AIC-21 slice 1: the tool/action risk registry, held as data in
 * `@aic/domain` rather than as a private literal on either side of the
 * boundary. `@aic/tools`'s `READ_ONLY_TOOL_REGISTRY`
 * (`packages/tools/src/contracts.ts`) derives its `kind:'tool'` view from
 * `RISK_REGISTRY` below, the same direction `EVIDENCE_SOURCE_REFUSAL_REASONS`
 * already derives from `EvidenceSourceRefusalReasonSchema.options`
 * (`contracts.ts`) — one spelling of the risk vocabulary, not two
 * independently maintained copies (`.claude/rules/invariants.md`, "one
 * mechanism, one implementation").
 *
 * Framework-free: the domain package may import only `zod`, `node:crypto` and
 * its own modules (this file needs only `zod`), enforced by
 * scoped-domain-contract.test.mjs › "the domain package imports only zod,
 * node:crypto and its own modules".
 */

export const RiskClassSchema = z.enum(['read', 'safe-write', 'dangerous']);
// Frozen the same way `EvidenceSourceRefusalReasonSchema.options` is
// (`contracts.ts`): zod's `ZodEnum` assigns `.options` once, at construction,
// to the same array reference on every later access, so freezing that array
// here keeps the three-value vocabulary from being widened after the fact.
Object.freeze(RiskClassSchema.options);
export type RiskClass = z.infer<typeof RiskClassSchema>;

export const RISK_REGISTRY_VERSION = 1 as const;

export const BlastRadiusLevelSchema = z.enum(['incident-record', 'service', 'environment']);
export type BlastRadiusLevel = z.infer<typeof BlastRadiusLevelSchema>;

/**
 * A registry entry id: a lowercase, hyphen-separated slug of at most 64
 * characters. Narrower than `SlugSchema` (`scope.ts`, capped at 100 and not
 * exported), and kept as its own definition here rather than exported and
 * re-imported, so this module's only import stays `zod`.
 */
const RegistryEntryIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/);

/**
 * Closure is structural, not a convention: a `kind:'tool'` entry can only
 * ever carry `risk:'read'`, and a `kind:'action'` entry can only ever carry
 * `risk` of `'safe-write'` or `'dangerous'` plus the blast radius its
 * execution needs. So nothing mutating can ever become a routable
 * investigation tool, and nothing read-only can be proposed as an action.
 */
const RiskRegistryEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('tool'),
    id: RegistryEntryIdSchema,
    risk: z.literal('read'),
  }),
  z.strictObject({
    kind: z.literal('action'),
    id: RegistryEntryIdSchema,
    risk: z.enum(['safe-write', 'dangerous']),
    minimumBlastRadius: BlastRadiusLevelSchema,
  }),
]);
export type RiskRegistryEntry = z.infer<typeof RiskRegistryEntrySchema>;

/**
 * A closed, versioned registry: `entries` may never repeat an id across
 * kinds, so `resolveRisk` below has exactly one answer per id. No top-level
 * `.refine` — this schema is never reached from `IncidentStateSchema`, so the
 * checkpoint-serde custom-check restriction (`contracts.ts`, the
 * `ProvenanceAdapterFieldSchema` comment) does not apply here, but
 * `.superRefine` is still the schema-native way to express a whole-array
 * invariant rather than a hand-written second pass over `.entries` after
 * parsing.
 */
export const RiskRegistrySchema = z
  .strictObject({
    version: z.literal(RISK_REGISTRY_VERSION),
    entries: z.array(RiskRegistryEntrySchema),
  })
  .superRefine((registry, ctx) => {
    const seenIds = new Set<string>();
    registry.entries.forEach((entry, index) => {
      if (seenIds.has(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate registry id across kinds: ${entry.id}`,
          path: ['entries', index, 'id'],
        });
      }
      seenIds.add(entry.id);
    });
  });
export type RiskRegistry = z.infer<typeof RiskRegistrySchema>;

/**
 * Freezes a plain object or array, and everything it reaches, recursively.
 * Only ever called on this module's own literal constant below — never on
 * caller-supplied input — so the recursion depth is fixed by the data
 * declared in this file, not by anything a caller controls.
 */
function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    return Object.freeze(value);
  }
  return value;
}

/**
 * The ten-entry registry: the six existing read tools (in their current
 * order, unchanged from `@aic/tools`'s previous private literal), then the
 * v0.3 action types — two safe-write, two dangerous so a dangerous proposal
 * is classified and refused as dangerous rather than as unknown (AIC-21
 * design, section B1). Parsed at module load, so a malformed edit here fails
 * closed at import rather than at first use.
 */
export const RISK_REGISTRY: RiskRegistry = deepFreeze(
  RiskRegistrySchema.parse({
    version: RISK_REGISTRY_VERSION,
    entries: [
      { kind: 'tool', id: 'deployments', risk: 'read' },
      { kind: 'tool', id: 'logs', risk: 'read' },
      { kind: 'tool', id: 'metrics', risk: 'read' },
      { kind: 'tool', id: 'traces', risk: 'read' },
      { kind: 'tool', id: 'git', risk: 'read' },
      { kind: 'tool', id: 'dependencies', risk: 'read' },
      {
        kind: 'action',
        id: 'incident-comment',
        risk: 'safe-write',
        minimumBlastRadius: 'incident-record',
      },
      {
        kind: 'action',
        id: 'create-follow-up-ticket',
        risk: 'safe-write',
        minimumBlastRadius: 'incident-record',
      },
      {
        kind: 'action',
        id: 'restart-service',
        risk: 'dangerous',
        minimumBlastRadius: 'service',
      },
      {
        kind: 'action',
        id: 'rollback-deployment',
        risk: 'dangerous',
        minimumBlastRadius: 'service',
      },
    ],
  }),
);

/**
 * A `Map`, not a plain object: `Map#get` never walks a prototype chain and
 * never coerces its argument, so `resolveRisk('__proto__')` and
 * `resolveRisk({ toString: () => 'incident-comment' })` both simply fail to
 * match any registered key rather than reading `Object.prototype` or a
 * coerced string.
 */
const RISK_BY_ID: ReadonlyMap<string, RiskRegistryEntry> = new Map(
  RISK_REGISTRY.entries.map((entry) => [entry.id, entry]),
);

/**
 * Looks a registry entry up by id. `id` is `unknown` because a caller-facing
 * value (a tool id off an adapter, an action type off a model draft) is
 * untrusted; a non-string is never coerced through `String()` or a custom
 * `toString()` before the lookup — it is simply not a registry id.
 */
export function resolveRisk(id: unknown): RiskRegistryEntry | undefined {
  if (typeof id !== 'string') return undefined;
  return RISK_BY_ID.get(id);
}
