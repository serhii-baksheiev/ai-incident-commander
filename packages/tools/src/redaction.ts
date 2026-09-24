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
 *   - a PEM private-key block: found by a plain forward STRING SEARCH, not a
 *     regex (see "The PEM pattern" below for why and the owner ruling that
 *     replaced the regex) — a `-----BEGIN ` + up to 64 `[A-Z0-9 ]` characters
 *     + `PRIVATE KEY-----` header, then EVERYTHING up to and including the
 *     next matching `-----END ` + up to 64 `[A-Z0-9 ]` characters +
 *     `PRIVATE KEY-----` footer is replaced with the single marker
 *     `[REDACTED]`, whatever lies between the two; with no such footer
 *     anywhere after the header, everything from the header to the END OF
 *     THE STRING is redacted instead, fail closed rather than guessing where
 *     the block ends. A non-private PEM block such as a certificate or
 *     public key is left alone;
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
 * The PEM pattern is a plain forward STRING SEARCH (`redactPemBlocks`,
 * defined below, run once at the start of `redactString` before
 * `CREDENTIAL_PATTERNS`), not a regex over the whole block — the owner's
 * 2026-09-25 SUBTRACTION ruling that replaced it. Four review rounds each
 * patched one gap in a header/footer regex (an RFC-1421-header-line loop, a
 * body character class excluding `-`/`:`/space) and each fix opened a new
 * leak the next round found — most recently a footer-less ENCRYPTED key whose
 * RFC 1421 blank line defeated the base64-only fallback line class. Rather
 * than write a fifth patch, the rule is now: whatever lies between a header
 * and its footer is OPAQUE. It is never parsed, so it cannot be
 * mis-parsed.
 *
 * What is redacted: from a `-----BEGIN ` + up to 64 `[A-Z0-9 ]` characters +
 * `PRIVATE KEY-----` header, EVERYTHING through the next matching
 * `-----END ` + up to 64 `[A-Z0-9 ]` characters + `PRIVATE KEY-----` footer —
 * indentation, blank lines, `Proc-Type`/`DEK-Info`/any other header-shaped
 * line, per-line log prefixes, base64url characters, literal `-` or `:`
 * inside the span, none of it inspected — see
 * test/bound-source-registry.test.mjs › "redacts the WHOLE PEM private-key
 * block, including a multi-line base64 body — the body never survives
 * anywhere in the output (review round 1, security blocker 1)", ›
 * "redacts the WHOLE PEM block even when the header line carries trailing
 * spaces and a tab before its own newline (review round 2, finding 3a)", ›
 * "redacts an ENCRYPTED PEM block whose RFC 1421 Proc-Type/DEK-Info headers
 * sit between the BEGIN header and the base64 body — no body line and no
 * footer survive (review round 2, finding 3b)", › "redacts the WHOLE PEM
 * block even when every continuation line is INDENTED, as inside a YAML
 * block scalar — the surrounding document text survives (review round 3,
 * finding 1)", › "redacts the WHOLE PEM block even when a body line carries a
 * single TRAILING space — the following body line and the footer must not
 * survive (review round 3, finding 2)", › "redacts an INDENTED ENCRYPTED PEM
 * block: the base64 body, the footer, and the DEK-Info value all fail to
 * survive when every continuation line is indented (review round 3, finding
 * 3)", › "redactEvidenceOutput treats the whole header-to-footer span as
 * opaque regardless of what lies between: a Content-Domain header line
 * before the body no longer defeats redaction, and text after the footer
 * survives (review round 4, owner fail-closed ruling, 2026-09-25)", › "…every
 * line — including the header and footer lines themselves — carries a
 * per-line ISO-timestamp log prefix …", › "…whose newlines are the
 * two-character escaped sequence backslash-n … as found inside an
 * escaped-JSON string …", and › "…whose body uses the base64url alphabet
 * ('-' and '_' in place of '+' and '/') …" (all four review round 4, owner
 * fail-closed ruling, 2026-09-25).
 *
 * With no matching footer anywhere after the header, EVERYTHING from the
 * header to the END OF THE STRING is redacted instead — fail closed, because
 * there is no footer to bound the span, rather than guessing at a body shape
 * that (per the four rounds above) always turns out to have a counter-example
 * — see test/bound-source-registry.test.mjs › "redacts a footer-less PEM
 * header through the end of the string, fail closed: \"key material: \"
 * survives, \" follows\" does not (owner fail-closed ruling, 2026-09-25 —
 * supersedes the original same-line near-miss this row pinned)", › "…even
 * when what follows is plain log text (… supersedes review round 2, finding
 * 3c)", › "…even when what follows is ordinary colon-bearing log text (…
 * supersedes review round 3, finding 4)", and › "record: a footer-less
 * ENCRYPTED PEM key (Proc-Type/DEK-Info headers, the RFC 1421 blank line,
 * then a base64 body, no footer) is fully redacted before it ever reaches
 * the recordings file or the returned outcome (review round 4 — the
 * footer-less-encrypted leak the owner's 2026-09-25 fail-closed ruling
 * fixes)".
 *
 * What survives: the text before the header, and the text after the footer
 * (when one was found) — see every "… and text after/before … survives" row
 * cited above, plus › "redacts two PEM blocks independently when placed back
 * to back with prose between them: both blocks are redacted separately, and
 * the prose between and after them survives (review round 4, owner
 * fail-closed ruling, 2026-09-25)" for two independent blocks in the same
 * string. A non-private PEM block — a certificate, a public key — never
 * matches the header check at all and is left untouched: see › "leaves a
 * non-private-key PEM header (a certificate) alone (near miss)".
 *
 * The accepted over-redaction: a footer-less block consumes everything after
 * it, including unrelated text that happens to follow in the same string —
 * this is the fail-closed trade the owner's ruling explicitly accepts rather
 * than parsing the span to tell a real body line from something else, which
 * is exactly the parsing that kept being wrong. There is no test asserting a
 * footer-less block stops short of the end of the string; the rows above
 * assert the opposite.
 *
 * Bounded work: `redactPemBlocks` never backtracks. It walks the string once,
 * forward only — `String.prototype.indexOf` to find each `-----BEGIN `/
 * `-----END ` literal, then a STICKY, length-bounded regex
 * (`/-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----/y` and the `-----END `
 * equivalent) tested at that exact index to confirm it is a private-key
 * header/footer rather than some other PEM label. A non-matching hit (a
 * certificate header, a footer whose label is not `PRIVATE KEY`) advances the
 * search by exactly one character and never revisits earlier ground; a
 * matching header's footer search resumes the OUTER scan from the footer's
 * own end (or the string's end, when none was found), so no byte of the
 * input is scanned by more than a bounded, forward-only pass — the same
 * "bounded, forward-only, no rescanning" shape
 * `.claude/rules/invariants.md`'s "a guard that fails open must do provably
 * bounded work" asks for, applied here to a redactor rather than a hook. The
 * output is assembled as an array of slices joined once, never repeated
 * string concatenation in a loop. See test/bound-source-registry.test.mjs ›
 * "redactEvidenceOutput stays within a bound on 1 MiB of repeated PEM headers
 * with no footer (review round 3, PEM timing)", › "…on a footer-less PEM
 * header followed by 1 MiB of base64 …", › "…on a PEM header followed by 1
 * MiB of whitespace …", › "…on 1 MiB of \"Proc-Type: x\" lines after a PEM
 * header …", › "…on a PEM header, ~1 MiB of base64 body, and a footer …" (all
 * five "review round 3, PEM timing"), and › "redactEvidenceOutput stays
 * within a bound on 1 MiB of alternating PEM header/footer pairs, each
 * independently redacted (review round 4, PEM timing)".
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
 * backtrack against itself. The URL-credential pattern below carries more
 * than one quantified region, so it is bounded a different way instead — a
 * leading lookbehind that prunes almost every starting position — spelled out
 * in this file's header comment, next to the timing rows in
 * test/bound-source-registry.test.mjs that measure it (review round 2,
 * finding 1). The PEM private-key block is no longer one of these regex
 * entries at all: `redactPemBlocks`, below, is a plain string search run
 * before this array, for the reasons this file's header comment states under
 * "The PEM pattern is a plain forward STRING SEARCH".
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
    // Inline URL credentials, any scheme, either case: `scheme://user:pass@`
    // — only the credential part between `//` and `@` is replaced, keeping
    // the scheme (captured in group 1) and the host that follows `@`. The
    // leading `(?<![A-Za-z0-9+.-])` lookbehind anchors the scheme's start so
    // the engine only ever attempts the `[A-Za-z][A-Za-z0-9+.-]*` scan from a
    // genuine scheme boundary rather than from every position in the
    // string — see this file's header comment, "the any-scheme URL pattern
    // is anchored" and test/bound-source-registry.test.mjs's ReDoS timing
    // rows (review round 2, finding 1). No `i` flag: the character classes
    // spell out both cases explicitly, for symmetry with this array's other
    // case-sensitive entries.
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

/** The literal a PEM private-key header starts with — searched with `indexOf`, never a regex scan. */
const PEM_HEADER_LITERAL = '-----BEGIN ';
/** The literal a PEM private-key footer starts with — searched with `indexOf`, never a regex scan. */
const PEM_FOOTER_LITERAL = '-----END ';
/**
 * Confirms, at an EXACT index found by `indexOf(PEM_HEADER_LITERAL, …)`, that
 * what follows is a private-key header rather than some other PEM label (a
 * certificate, a public key) — sticky (`y`), so it only ever tests the one
 * position it is pointed at, and length-bounded (`{0,64}`), so a match
 * attempt is O(1) regardless of input size.
 */
const PEM_HEADER_STICKY = /-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----/y;
/** The footer equivalent of `PEM_HEADER_STICKY`, same shape and same bound. */
const PEM_FOOTER_STICKY = /-----END [A-Z0-9 ]{0,64}PRIVATE KEY-----/y;

/**
 * Replaces every PEM private-key block in `value` with the single marker
 * `[REDACTED]` — a plain forward string search, never a regex over the whole
 * block. See this file's header comment, "The PEM pattern is a plain forward
 * STRING SEARCH", for what is redacted, what survives, the accepted
 * over-redaction and why this replaced a regex, each pointing at the test
 * that pins it.
 *
 * The whole function is one forward pass: `cursor` is the start of the
 * next-unwritten slice of `value`, and `searchFrom` is the next position to
 * look for a header. A header hit whose sticky check fails advances
 * `searchFrom` by exactly one character and is never revisited. A header
 * whose sticky check succeeds starts its own, separate forward-only footer
 * search from the header's own end; that footer search either finds a
 * matching footer (and the outer scan resumes just past it) or exhausts the
 * rest of the string (and the whole remainder is redacted, fail closed, with
 * nothing left for the outer scan to do). Either way, no byte of `value` is
 * ever re-scanned by a later iteration — the output is built as an array of
 * slices joined once at the end, never repeated string concatenation.
 */
function redactPemBlocks(value: string): string {
  const parts: string[] = [];
  let cursor = 0;
  let searchFrom = 0;

  for (;;) {
    const headerHit = value.indexOf(PEM_HEADER_LITERAL, searchFrom);
    if (headerHit === -1) {
      break;
    }
    PEM_HEADER_STICKY.lastIndex = headerHit;
    const headerMatch = PEM_HEADER_STICKY.exec(value);
    if (!headerMatch) {
      searchFrom = headerHit + 1;
      continue;
    }
    const headerEnd = headerHit + headerMatch[0].length;

    let footerSearchFrom = headerEnd;
    let footerEnd = -1;
    for (;;) {
      const footerHit = value.indexOf(PEM_FOOTER_LITERAL, footerSearchFrom);
      if (footerHit === -1) {
        break;
      }
      PEM_FOOTER_STICKY.lastIndex = footerHit;
      const footerMatch = PEM_FOOTER_STICKY.exec(value);
      if (footerMatch) {
        footerEnd = footerHit + footerMatch[0].length;
        break;
      }
      footerSearchFrom = footerHit + 1;
    }

    parts.push(value.slice(cursor, headerHit), REDACTED);

    if (footerEnd === -1) {
      // Fail closed: no matching footer anywhere after this header — redact
      // through the end of the string rather than guessing where the block
      // ends.
      cursor = value.length;
      break;
    }
    cursor = footerEnd;
    searchFrom = footerEnd;
  }

  parts.push(value.slice(cursor));
  return parts.join('');
}

function redactString(value: string): string {
  let result = redactPemBlocks(value);
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
