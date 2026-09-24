/**
 * AIC-100, slice c: `redactEvidenceOutput` — the pure, deep, bounded
 * redactor `BoundSourceRegistry` runs over an `ok` outcome's `output` before
 * `store.set` and before an outcome is returned to its caller (see
 * `./bound-source-registry.ts`'s own doc comments and
 * test/bound-source-registry.test.mjs's "the registry redacts BEFORE
 * persistence and BEFORE returning the outcome to its caller" block).
 *
 * Scope, stated exactly: this walks a value built only from JSON-shaped
 * containers — arrays, and plain objects whose prototype is `Object.prototype`
 * or `null` — replacing a credential-shaped SUBSTRING inside a string with
 * `[REDACTED]` in place; a string, number, boolean or `null` leaf is otherwise
 * left alone (a string is scanned; the other three pass through unchanged).
 * Every other value fails CLOSED to the fixed sentinel
 * `'[REDACTED:unsupported]'` rather than being walked as if it were a plain
 * object or passed through unchanged: a `Buffer`, `Map`, `Set`, `Date`,
 * `Error`, or any other class instance (walking one of those as a plain
 * object would either silently expose a `Buffer`'s bytes as numeric-string
 * keys, or silently collapse a `Map`/`Set`/`Date`/`Error` to `{}`, since none
 * of those have their own state on ordinary enumerable properties — see
 * test/bound-source-registry.test.mjs's `for` loop over
 * `UNSUPPORTED_REDACTION_VALUE_ROWS`, review round 1, security +
 * code-reviewer blocker 3), and a `function`, `symbol`, `bigint` or
 * `undefined` value, none of which is a JSON leaf either (see the `for` loop
 * over `UNSUPPORTED_NON_OBJECT_REDACTION_VALUE_ROWS`, review round 2, finding
 * 6). An own key literally named `'__proto__'` (the shape
 * `JSON.parse` produces for that text, as opposed to the object-literal syntax
 * `{ __proto__: x }`, which reassigns the real prototype at construction time
 * instead) is preserved as an ordinary own data property of the walked
 * object: the output object's own keys are written with
 * `Object.defineProperty`, which — unlike an ordinary `output[key] = value`
 * assignment — never invokes `Object.prototype`'s own `__proto__` accessor,
 * so the output's real `[[Prototype]]` stays `Object.prototype` throughout.
 * See test/bound-source-registry.test.mjs › "a __proto__ own key in adapter
 * output is KEPT as an own key in the returned and persisted output, and the
 * output's prototype is never adapter-controlled (review round 1,
 * code-reviewer blocker 4)".
 *
 * This does not touch a `reason` or an `interactionId`-like free-text field
 * outside `output` — those are a different surface's concern, not this
 * module's (see `./bound-source-registry.ts`'s doc comments, which name what
 * is and is not redacted there).
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
 *   - a PEM private-key block: the `-----BEGIN ... PRIVATE KEY-----` header
 *     (optional trailing horizontal whitespace and an optional, optionally
 *     indented RFC 1421 `Proc-Type`/`DEK-Info` header block tolerated before
 *     the body), then either a FOOTER-ANCHORED whole block — an indented or
 *     multi-line base64 body followed by a MANDATORY matching
 *     `-----END ... PRIVATE KEY-----` footer — or, when no such footer
 *     follows, a FOOTER-LESS block of nothing but base64 lines of 16+
 *     characters each; the WHOLE block is replaced, not just the header (see
 *     "the PEM pattern" below); a non-private PEM block such as a certificate
 *     is left alone;
 *   - inline `user:pass` URL credentials for ANY scheme matching
 *     `[A-Za-z][A-Za-z0-9+.-]*://` in either case (not only `http(s)`, and not
 *     only lower-case), where the scheme and host are kept and only the
 *     credential part between `//` and `@` is replaced;
 *   - a Slack bot/user/app/legacy-workspace token shape (`xox[abpr]-...`).
 *
 * What this does NOT catch — stated exactly, because a redactor's own limits
 * are exactly the kind of claim `.claude/rules/invariants.md` requires be
 * either generated or pointed at a test, and none of the following has a test
 * asserting it IS caught:
 *   - any token family outside the six above — a fine-grained GitHub PAT
 *     (`github_pat_...`), an AWS secret access key or session token, a JWT, a
 *     generic API-key-shaped string with no recognisable prefix;
 *   - a lower-case `authorization: bearer <token>` header (the pinned pattern
 *     is the literal `Bearer ` prefix, case-sensitive);
 *   - HTTP Basic-auth credentials carried as a base64 `Authorization: Basic
 *     ...` header value;
 *   - a `password=...` (or similarly named) query-string parameter, or a
 *     credential sitting in a dumped environment-variable listing;
 *   - a credential whose characters are split across more than one string (a
 *     token chunked by an upstream API into separate array elements, or wrapped
 *     mid-token) — this module only scans the SUBSTRINGS of each individual
 *     string value, never joins sibling strings before scanning;
 *   - a credential that is itself base64-wrapped (encoded so it no longer
 *     matches any of the six shapes' own character classes);
 *   - a credential-shaped object KEY — only string VALUES are scanned; a key
 *     name that happens to look like a credential is left as-is (object keys
 *     are never rewritten by this module, only preserved or, for an
 *     unsupported container, replaced in bulk).
 *
 * The URL-credential pattern is anchored, not scanned from every position:
 * `(?<![A-Za-z0-9+.-])` is a negative lookbehind that refuses to even start
 * matching at a position whose preceding character is itself scheme-shaped —
 * which is exactly the position an unanchored `[A-Za-z][A-Za-z0-9+.-]*` would
 * otherwise re-attempt at every offset of a long scheme-like run, the
 * quadratic shape review round 2's finding 1 measured. On a string built
 * entirely from scheme-shaped characters (see
 * `buildSchemeLikeRunWithNoUrlSeparator` in the test file), the lookbehind
 * fails at every position except the very first, so the expensive scan is
 * attempted once rather than once per character — see
 * test/bound-source-registry.test.mjs › "redactEvidenceOutput completes
 * within a bound on a 256 KiB run of scheme-like characters with no \"://\"
 * substring (review round 2, finding 1: ReDoS)" and › "live: registry.execute
 * redacts an 80 KB output built from the same scheme-like run within a bound
 * (review round 2, finding 1: ReDoS)". The scheme itself is matched by two
 * single, non-nested character classes (`[A-Za-z]` then `[A-Za-z0-9+.-]*`),
 * covering either case without an `i` flag, which would also affect every
 * other pattern sharing this same array.
 *
 * The PEM pattern is two alternatives, each a single non-backtracking run,
 * tried footer-anchored first and footer-less second: a literal header, then
 * ONE optional continuation group that only ever engages once an actual
 * newline is reached — optional trailing horizontal whitespace (`[ \t]*`) is
 * tolerated immediately before that newline, but is never consumed on its
 * own when no newline follows it, because the whole group's first mandatory
 * element (`[ \t]*\r?\n`) fails there and the surrounding `(?:...)?`
 * backtracks to zero width rather than leaving a partial match — this is what
 * keeps a header followed by plain trailing prose on the same line (see the
 * near-miss row pinning "key material: <header> follows") left with that
 * prose untouched, and is also what makes trailing whitespace before the
 * header's own newline no longer defeat the whole group (review round 2,
 * finding 3a). Once that gate is passed, zero or more RFC 1421 header lines
 * are consumed — restricted to the literal `Proc-Type:` or `DEK-Info:` labels
 * specifically, each optionally indented and ending in its own newline
 * (`(?:[ \t]*(?:Proc-Type|DEK-Info):[^\r\n]*\r?\n)*`) — an ordinary
 * colon-bearing log line such as `"INFO: service healthy"` never matches this
 * loop, because neither literal label matches its own text (review round 3,
 * finding 4). What follows is ONE of two alternatives:
 *
 *   A) FOOTER-ANCHORED — a single greedy character class,
 *      `[A-Za-z0-9+/=\s]`, that tolerates whitespace (including further
 *      newlines and per-line indentation, so a YAML-block-scalar-indented
 *      body is still consumed in full — review round 3, findings 1 and 2)
 *      but EXCLUDES the literal characters `-` and `:`. Because the class
 *      excludes `-`, it always stops deterministically at the next `-----`
 *      (a real footer or another header) with no backtracking needed to find
 *      that boundary; a MANDATORY matching `-----END ... PRIVATE KEY-----`
 *      footer must follow immediately.
 *   B) FOOTER-LESS fallback, tried only once A fails to find a footer — zero
 *      or more (optionally indented) lines that are NOTHING BUT 16-or-more
 *      base64 characters, each ending in its own newline except optionally
 *      the last:
 *      `(?:[ \t]*[A-Za-z0-9+/=]{16,}[ \t]*(?:\r?\n[ \t]*[A-Za-z0-9+/=]{16,}[ \t]*)*)?`.
 *      A line containing a space, a colon, or fewer than 16 base64
 *      characters — including a short word like `"INFO"` or a colon-bearing
 *      log line — ends the match there instead of being partly consumed
 *      (review round 3, finding 4), which is also what makes the
 *      already-established footer-less row above keep the leading word of
 *      its own first followup line intact.
 *
 * Every quantified region here is either quantified once with nothing nested
 * inside it over the same characters, or — the header-line loop's `[ \t]*`
 * indent and `[^\r\n]*` line-content class — two classes that DO overlap on
 * letters but are separated by a mandatory literal label, so a
 * label-mismatched line costs at most one bounded backtrack over its own
 * indentation before the loop gives up, never nested inside another
 * repetition. Alternative A's body class and B's base64-line class are each a
 * single quantified region with nothing else competing for the same
 * characters: A's class and the footer's literal `-----` are disjoint (the
 * class excludes `-`), and B's base64 class and its own surrounding
 * `[ \t]*` are disjoint alphabets (base64 excludes space and tab), so control
 * passes from one to the other with no backtracking in either case — the
 * same bounded shape `.claude/scripts/lib/secrets.mjs` uses for its own
 * credential patterns (`.claude/rules/invariants.md`, "a guard that fails
 * open must do provably bounded work" — applied here to a redactor rather
 * than a hook, since this module runs on every recorded and returned outcome
 * rather than failing open on error). See test/bound-source-registry.test.mjs
 * › "redacts the WHOLE PEM private-key block, including a multi-line base64
 * body — the body never survives anywhere in the output (review round 1,
 * security blocker 1)", › "redacts the WHOLE PEM block even when the header
 * line carries trailing spaces and a tab before its own newline (review round
 * 2, finding 3a)", › "redacts an ENCRYPTED PEM block whose RFC 1421
 * Proc-Type/DEK-Info headers sit between the BEGIN header and the base64 body
 * — no body line and no footer survive (review round 2, finding 3b)", ›
 * "does not over-redact past a FOOTER-LESS PEM header: plain log lines with
 * spaces survive (review round 2, finding 3c: the body class must not
 * include a literal space)", › "redacts the WHOLE PEM block even when every
 * continuation line is INDENTED, as inside a YAML block scalar — the
 * surrounding document text survives (review round 3, finding 1)", › "redacts
 * the WHOLE PEM block even when a body line carries a single TRAILING space —
 * the following body line and the footer must not survive (review round 3,
 * finding 2)", › "redacts an INDENTED ENCRYPTED PEM block: the base64 body,
 * the footer, and the DEK-Info value all fail to survive when every
 * continuation line is indented (review round 3, finding 3)", and › "does not
 * treat an ordinary colon-bearing log line as an RFC 1421 header line after a
 * FOOTER-LESS PEM header: the lines survive exactly, leading level word
 * included (review round 3, finding 4)". The five PEM timing rows pinning
 * that none of the above reintroduces a quadratic pattern on 1 MiB of
 * adversarial input are, all in test/bound-source-registry.test.mjs and all
 * titled "(review round 3, PEM timing)": › "redactEvidenceOutput stays within
 * a bound on 1 MiB of repeated PEM headers with no footer …", › "…on a
 * footer-less PEM header followed by 1 MiB of base64 …", › "…on a PEM header
 * followed by 1 MiB of whitespace …", › "…on 1 MiB of \"Proc-Type: x\" lines
 * after a PEM header …", and › "…on a PEM header, ~1 MiB of base64 body, and
 * a footer …".
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
const UNSUPPORTED_SENTINEL = '[REDACTED:unsupported]';
const REDACTED = '[REDACTED]';

/**
 * Most patterns here are a literal prefix plus at most one bounded character
 * class, the same shape `.claude/scripts/lib/secrets.mjs` uses for its own
 * credential patterns — bounded because a single quantified class cannot
 * backtrack against itself. The PEM and URL-credential patterns below carry
 * more than one quantified region each, so each of THEM is bounded a
 * different way instead — a leading lookbehind that prunes almost every
 * starting position for the URL pattern, and a mandatory-newline gate plus
 * disjoint, non-overlapping classes for the PEM pattern's two alternatives —
 * spelled out in this file's header comment, next to the timing rows in
 * test/bound-source-registry.test.mjs that measure each one: the URL
 * pattern's ReDoS rows (review round 2, finding 1) and the five PEM timing
 * rows this file's header comment names by test name (review round 3).
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
    // PEM private-key block: header, then ONE optional continuation group
    // that only ever engages once an actual newline is reached (optional
    // trailing horizontal whitespace — [ \t]* — is tolerated before that
    // newline, but is never consumed on its own if no newline follows it,
    // because the whole group backtracks to zero width when the mandatory
    // `\r?\n` fails), then zero or more RFC 1421 header lines (`Proc-Type:`
    // or `DEK-Info:` specifically, each optionally indented and ending in its
    // own newline — never an arbitrary `word:` log line), then ONE of two
    // alternatives, tried in order:
    //   A) FOOTER-ANCHORED — a body class that tolerates whitespace
    //      (including further newlines and indentation) but EXCLUDES '-' and
    //      ':', so it always stops deterministically at the next '-----' or
    //      colon, then a MANDATORY matching footer;
    //   B) FOOTER-LESS fallback — zero or more (optionally indented) base64
    //      lines of 16+ characters each, and nothing else: a line containing
    //      a space, a colon, or fewer than 16 base64 characters ends the
    //      match there rather than being partly consumed.
    // See this file's header comment, "The PEM pattern is two alternatives,
    // each a single non-backtracking run".
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:[ \t]*\r?\n(?:[ \t]*(?:Proc-Type|DEK-Info):[^\r\n]*\r?\n)*(?:[A-Za-z0-9+/=\s]*-----END [A-Z0-9 ]*PRIVATE KEY-----|(?:[ \t]*[A-Za-z0-9+/=]{16,}[ \t]*(?:\r?\n[ \t]*[A-Za-z0-9+/=]{16,}[ \t]*)*)?))?/g,
    replacement: REDACTED,
  },
  {
    // Inline URL credentials, any scheme, either case: `scheme://user:pass@`
    // — only the credential part between `//` and `@` is replaced, keeping
    // the scheme (captured in group 1) and the host that follows `@`. The
    // leading `(?<![A-Za-z0-9+.-])` lookbehind anchors the scheme's start so
    // the engine only ever attempts the `[A-Za-z][A-Za-z0-9+.-]*` scan from a
    // genuine scheme boundary rather than from every position in the
    // string — see this file's header comment, "the any-scheme URL pattern
    // is anchored" and test/bound-source-registry.test.mjs's ReDoS timing
    // rows (review round 2, finding 1). No `i` flag: the character classes
    // spell out both cases explicitly, because the PEM pattern above shares
    // this same `CREDENTIAL_PATTERNS` array and depends on case-sensitive
    // matching of its own literal `BEGIN`/`END`/`PRIVATE KEY` text.
    pattern: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]*@/g,
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

/**
 * A value this module will walk as a container of further values: an array,
 * or a plain object — one whose prototype is exactly `Object.prototype` (an
 * object literal, or the result of `JSON.parse`) or `null` (`Object.create(null)`).
 * Anything else that is still `typeof value === 'object'` — a `Buffer`, `Map`,
 * `Set`, `Date`, `Error`, or any other class instance — is NOT walked; see
 * this file's header comment for why walking one of those would either leak
 * its bytes as numeric keys or silently collapse it to `{}`.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Copies every own enumerable key of `source` onto a fresh, ordinary object —
 * whose real `[[Prototype]]` is `Object.prototype`, exactly like the object
 * literal `{}` this function starts from — using `Object.defineProperty`
 * rather than `output[key] = value`. That distinction is the whole point: an
 * ordinary assignment to the key `'__proto__'` on a normal object invokes
 * `Object.prototype`'s own `__proto__` ACCESSOR and reassigns the object's
 * real prototype; `Object.defineProperty` always creates or overwrites an
 * ordinary OWN DATA property instead, regardless of the key's name, so a
 * `'__proto__'` key from `source` survives as an own key here rather than
 * silently becoming (or shadowing into) the output's actual prototype.
 */
function buildRedactedObject(source: Record<string, unknown>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    Object.defineProperty(output, key, {
      value: redactAtDepth(source[key], depth + 1),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return output;
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
  if (isPlainObject(value)) {
    return buildRedactedObject(value, depth);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  // Everything else fails CLOSED to a fixed sentinel rather than passing
  // through unchanged or being walked as a plain object: a Buffer, Map, Set,
  // Date, Error or any other class instance (review round 1, security +
  // code-reviewer blocker 3), and a function, symbol, bigint or `undefined`
  // (review round 2, finding 6) — none of these is a JSON-shaped container or
  // a JSON leaf, so none of them is safe to pass through or walk as-is. See
  // this file's header comment.
  return UNSUPPORTED_SENTINEL;
}

/**
 * Pure, deep, bounded redaction over a value built only from JSON-shaped
 * containers: arrays and plain objects are walked (keys are kept, non-string
 * leaves are left alone), and a credential-shaped substring inside a string
 * is replaced with `[REDACTED]` in place. Anything else, anywhere in the
 * walk — a `Buffer`, `Map`, `Set`, `Date`, `Error` or other class instance, or
 * a `function`, `symbol`, `bigint` or `undefined` value — fails closed to
 * `[REDACTED:unsupported]`. See this file's header for the six recognised
 * credential shapes, what this module does NOT catch, and the depth-cap
 * fail-closed behaviour.
 */
export function redactEvidenceOutput(value: unknown): unknown {
  return redactAtDepth(value, 0);
}
