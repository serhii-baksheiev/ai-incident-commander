/**
 * AIC-100, slice c: `redactEvidenceOutput` — the pure, deep, bounded
 * redactor `BoundSourceRegistry` runs over an `ok` outcome's `output` before
 * `store.set` and before an outcome is returned to its caller (see
 * `./bound-source-registry.ts`'s own doc comments and
 * test/bound-source-registry.test.mjs's "the registry redacts BEFORE
 * persistence and BEFORE returning the outcome to its caller" block).
 *
 * Scope, stated exactly: this walks a JSON-shaped `value` (arrays, plain
 * objects, strings, and other primitives left alone) and replaces a
 * credential-shaped SUBSTRING inside a string with `[REDACTED]`. It does not
 * touch a `reason` or an `interactionId`-like free-text field outside
 * `output` — those are a different surface's concern, not this module's (see
 * `./bound-source-registry.ts`'s updated doc comments, which name what is and
 * is not redacted).
 *
 * Six credential shapes are recognised, each pinned in
 * test/bound-source-registry.test.mjs with a runtime-assembled example (never
 * a literal, per `.claude/scripts/lib/secrets.mjs`'s vocabulary) and a
 * near-miss that must be left untouched:
 *   - a GitHub personal-access-token shape (`ghp_` + 36 alphanumerics);
 *   - an AWS access-key-id shape (`AKIA` + 16 upper-case alphanumerics);
 *   - a "Bearer <token>" credential (20+ token characters), where the WHOLE
 *     match — including the `Bearer ` prefix — is dropped, not just the
 *     token;
 *   - a PEM private-key header (`-----BEGIN ... PRIVATE KEY-----`), as
 *     opposed to a non-private PEM block such as a certificate;
 *   - inline `user:pass` URL credentials, where the scheme and host are kept
 *     and only the credential part is replaced;
 *   - a Slack bot/user/app/legacy-workspace token shape (`xox[abpr]-...`).
 *
 * Every pattern below is a single literal-prefixed run with at most one
 * bounded quantifier and boundary lookarounds — no quantifier nests inside
 * another, matching this project's own bounded-regex convention in
 * `.claude/scripts/lib/secrets.mjs` (`.claude/rules/invariants.md`, "a guard
 * that fails open must do provably bounded work" — applied here to a
 * redactor rather than a hook, since this module runs on every recorded and
 * returned outcome rather than failing open on error).
 *
 * `MAX_REDACTION_DEPTH` bounds recursion: the depth check happens BEFORE a
 * container's children are visited, so recursion never goes deeper than
 * `MAX_REDACTION_DEPTH + 1` stack frames regardless of how deeply nested the
 * input is — the fixed sentinel `'[REDACTED:depth]'` is returned instead of
 * recursing further. See test/bound-source-registry.test.mjs › "a value
 * nested beyond MAX_REDACTION_DEPTH is replaced with the fixed sentinel
 * [REDACTED:depth], fail closed rather than recursing further" and › "does
 * not stack-overflow on input far past the depth cap (bounded work,
 * invariants.md)".
 */

/**
 * The bounded recursion-depth cap `redactEvidenceOutput` fails closed at.
 * Chosen generously above any realistic evidence-output shape while keeping
 * the worst-case recursion depth small and fixed.
 */
export const MAX_REDACTION_DEPTH = 20;

const DEPTH_SENTINEL = '[REDACTED:depth]';
const REDACTED = '[REDACTED]';

/**
 * Each pattern is a literal prefix plus at most one bounded character class —
 * the same shape `.claude/scripts/lib/secrets.mjs` uses for its own
 * credential patterns, so none of these can backtrack catastrophically.
 */
interface CredentialPattern {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const CREDENTIAL_PATTERNS: readonly CredentialPattern[] = [
  {
    // GitHub personal-access-token: `ghp_` + exactly 36 alphanumerics,
    // bounded by non-alphanumeric characters on both sides so a
    // 35-character near-miss is left alone rather than partially matched.
    pattern: /(?<![A-Za-z0-9_])ghp_[A-Za-z0-9]{36}(?![A-Za-z0-9_])/g,
    replacement: REDACTED,
  },
  {
    // AWS access-key id: `AKIA` + exactly 16 upper-case alphanumerics.
    pattern: /(?<![A-Za-z0-9])AKIA[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    replacement: REDACTED,
  },
  {
    // "Bearer <token>": the whole match, prefix included, is replaced — the
    // token itself is dropped rather than kept alongside a marker.
    pattern: /Bearer [A-Za-z0-9\-_.~+/=]{20,}/g,
    replacement: REDACTED,
  },
  {
    // PEM private-key header: `-----BEGIN ... PRIVATE KEY-----`. A
    // non-private PEM block (e.g. a certificate) never contains the literal
    // "PRIVATE KEY" segment and so is left untouched.
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: REDACTED,
  },
  {
    // Inline URL credentials: `scheme://user:pass@` — only the credential
    // part between `//` and `@` is replaced, keeping the scheme (captured in
    // group 1) and the host that follows `@`.
    pattern: /(https?:\/\/)[^/\s:@]+:[^/\s@]*@/g,
    replacement: `$1${REDACTED}@`,
  },
  {
    // Slack token: `xox` + one of a/b/p/r + `-` + 10 or more token
    // characters.
    pattern: /(?<![A-Za-z0-9-])xox[abpr]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    replacement: REDACTED,
  },
];

function redactString(value: string): string {
  let result = value;
  for (const { pattern, replacement } of CREDENTIAL_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

function redactAtDepth(value: unknown, depth: number): unknown {
  if (depth > MAX_REDACTION_DEPTH) {
    return DEPTH_SENTINEL;
  }
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactAtDepth(item, depth + 1));
  }
  if (value !== null && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[key] = redactAtDepth(entryValue, depth + 1);
    }
    return output;
  }
  return value;
}

/**
 * Pure, deep, bounded redaction over a JSON-shaped value: arrays and plain
 * objects are walked (keys are kept, non-string values are left alone), and
 * a credential-shaped substring inside a string is replaced with
 * `[REDACTED]` in place. See this file's header for the six recognised
 * shapes and the depth-cap fail-closed behaviour.
 */
export function redactEvidenceOutput(value: unknown): unknown {
  return redactAtDepth(value, 0);
}
