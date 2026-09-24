import type {
  EvidenceSource,
  EvidenceSourceCheckResult,
  EvidenceSourceOutcome,
  EvidenceSourceProvenance,
  EvidenceSourceRefusalReason,
} from './evidence-source.js';

/**
 * AIC-98, slice b: `github@1`, a formal `EvidenceSource` over a read-only
 * slice of the GitHub REST API — deployments, commits and pull-request
 * metadata. See test/github-evidence-source.test.mjs's header for the full
 * pinned design. Provenance here is a placeholder, exactly like
 * `./lab-source.ts`'s own: `BoundSourceRegistry` is the single writer of
 * provenance and overwrites it (`./bound-source-registry.ts`).
 */

const GITHUB_ADAPTER_ID = 'github';
const GITHUB_ADAPTER_VERSION = '1';
const DEFAULT_API_BASE_URL = 'https://api.github.com';
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_PAGES = 1;

const PLACEHOLDER_PROVENANCE: EvidenceSourceProvenance = Object.freeze({
  sourceBindingId: '',
  adapter: '',
  credentialRefId: null,
  fetchedAt: '',
  requestFingerprint: '',
});

export interface GithubEvidenceSourceOptions {
  readonly owner: string;
  readonly repo: string;
  readonly token: () => string;
  readonly fetch?: typeof fetch;
  readonly apiBaseUrl?: string;
  readonly maxResponseBytes?: number;
  readonly requestTimeoutMs?: number;
}

/* -------------------------------------------------------------------------- */
/* Construction-time validation                                               */
/* -------------------------------------------------------------------------- */

// Non-empty, starts with an alphanumeric (so a leading '.' — and so a bare
// '..' — never matches), no '/' or whitespace anywhere, at most 100 chars
// total.
const OWNER_OR_REPO_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

function validateOwnerOrRepo(value: string, label: 'owner' | 'repo'): string {
  if (typeof value !== 'string' || !OWNER_OR_REPO_PATTERN.test(value)) {
    throw new Error(`createGithubEvidenceSource: ${label} must be a valid GitHub ${label} name, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * Validated in an order that never echoes a credential: the scheme is
 * checked first, against the scheme alone, before anything about `raw` (or
 * the URL derived from it) is put into a thrown message — a bad scheme on a
 * userinfo-carrying URL (e.g. `http://user:pw@...`) must never echo the
 * whole URL, and once that check passes, userinfo is refused with a fixed
 * message carrying no part of `raw` at all.
 */
function validateApiBaseUrl(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:') {
    throw new Error(`createGithubEvidenceSource: apiBaseUrl must use https, got scheme ${JSON.stringify(url.protocol.replace(/:$/, ''))}`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('createGithubEvidenceSource: apiBaseUrl must not carry userinfo');
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    throw new Error(`createGithubEvidenceSource: apiBaseUrl must be root-only (no path, query or fragment), got pathname ${JSON.stringify(url.pathname)}`);
  }
  return url;
}

/* -------------------------------------------------------------------------- */
/* Per-operation input validation — runs BEFORE any fetch                     */
/* -------------------------------------------------------------------------- */

const SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const ENVIRONMENT_PATTERN = /^[A-Za-z0-9._-]{1,255}$/;
const REF_PATTERN = /^[A-Za-z0-9._/-]{1,255}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

function isSha(value: unknown): boolean {
  return typeof value === 'string' && SHA_PATTERN.test(value);
}

function isEnvironment(value: unknown): boolean {
  return typeof value === 'string' && ENVIRONMENT_PATTERN.test(value);
}

function isRef(value: unknown): boolean {
  return typeof value === 'string' && REF_PATTERN.test(value);
}

function isTimestamp(value: unknown): boolean {
  return typeof value === 'string' && TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function isPositiveSafeInteger(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

interface OperationField {
  readonly required: boolean;
  readonly validate: (value: unknown) => boolean;
  /** Whether this field is embedded in the URL path rather than a query param. */
  readonly inPath: boolean;
}

interface OperationSpec {
  readonly paginated: boolean;
  readonly fields: Readonly<Record<string, OperationField>>;
  readonly buildPathname: (owner: string, repo: string, fields: Readonly<Record<string, unknown>>) => string;
}

/**
 * The six read-only operations this adapter supports, in the fixed order the
 * ticket names them — `describe()` reports `Object.keys(OPERATIONS)`
 * unchanged, so this declaration order IS the pinned order. See
 * test/github-evidence-source.test.mjs › "describe() reports adapterId
 * \"github\", version \"1\" and exactly the six read-only operation ids, in
 * the pinned order, without ever calling fetch".
 */
const OPERATIONS: Readonly<Record<string, OperationSpec>> = {
  list_deployments: {
    paginated: true,
    fields: {
      sha: { required: false, validate: isSha, inPath: false },
      ref: { required: false, validate: isRef, inPath: false },
      environment: { required: false, validate: isEnvironment, inPath: false },
    },
    buildPathname: (owner, repo) => `/repos/${owner}/${repo}/deployments`,
  },
  list_deployment_statuses: {
    paginated: true,
    fields: {
      deployment_id: { required: true, validate: isPositiveSafeInteger, inPath: true },
    },
    buildPathname: (owner, repo, fields) => `/repos/${owner}/${repo}/deployments/${fields.deployment_id}/statuses`,
  },
  get_commit: {
    paginated: false,
    fields: {
      sha: { required: true, validate: isSha, inPath: true },
    },
    buildPathname: (owner, repo, fields) => `/repos/${owner}/${repo}/commits/${fields.sha}`,
  },
  list_commits: {
    paginated: true,
    fields: {
      since: { required: false, validate: isTimestamp, inPath: false },
      until: { required: false, validate: isTimestamp, inPath: false },
    },
    buildPathname: (owner, repo) => `/repos/${owner}/${repo}/commits`,
  },
  list_commit_pull_requests: {
    paginated: true,
    fields: {
      sha: { required: true, validate: isSha, inPath: true },
    },
    buildPathname: (owner, repo, fields) => `/repos/${owner}/${repo}/commits/${fields.sha}/pulls`,
  },
  get_pull_request: {
    paginated: false,
    fields: {
      number: { required: true, validate: isPositiveSafeInteger, inPath: true },
    },
    buildPathname: (owner, repo, fields) => `/repos/${owner}/${repo}/pulls/${fields.number}`,
  },
};

type ValidatedInput =
  | { readonly ok: true; readonly fields: Readonly<Record<string, unknown>> }
  | { readonly ok: false };

function validateInput(spec: OperationSpec, input: unknown): ValidatedInput {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false };
  }
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!Object.prototype.hasOwnProperty.call(spec.fields, key)) {
      return { ok: false };
    }
  }
  for (const key of Object.keys(spec.fields)) {
    const field = spec.fields[key];
    const has = Object.prototype.hasOwnProperty.call(record, key);
    if (field.required && !has) {
      return { ok: false };
    }
    if (has && !field.validate(record[key])) {
      return { ok: false };
    }
  }
  return { ok: true, fields: record };
}

/* -------------------------------------------------------------------------- */
/* Response status mapping                                                    */
/* -------------------------------------------------------------------------- */

function isSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * The status -> refusal-reason mapping the ticket pins: 401 denied; 403 with
 * `x-ratelimit-remaining: 0`, or 429, rate_limited; any other 403 denied; 404
 * unavailable; 400/422 adapter_error; 5xx unavailable.
 */
function reasonForStatus(status: number, headers: Headers): EvidenceSourceRefusalReason {
  if (status === 401) return 'denied';
  if (status === 403) {
    return headers.get('x-ratelimit-remaining') === '0' ? 'rate_limited' : 'denied';
  }
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'unavailable';
  if (status === 400 || status === 422) return 'adapter_error';
  return 'unavailable';
}

/* -------------------------------------------------------------------------- */
/* Byte-capped streamed body read                                             */
/* -------------------------------------------------------------------------- */

type CappedBodyResult = { readonly ok: true; readonly text: string } | { readonly ok: false };

/**
 * One in-flight GET, returned by `performRequest`. Its `AbortController` and
 * deadline timer stay armed past the headers resolving — through the body
 * read, if any — so `armReader` lets a body-reading caller register the
 * reader the deadline should cancel, `deadlineExceeded` reports whether that
 * already happened, and `release` clears the timer on every exit path,
 * whether or not a body was ever read. See test/github-evidence-source.test.mjs
 * › "a response whose headers arrive but whose body never closes is bounded
 * by a deadline, and its reader is released via cancel() (a real-timer race
 * bounds the row itself: it rejects rather than hangs when the adapter never
 * settles)".
 */
interface PerformedRequest {
  readonly response: Response;
  armReader(reader: ReadableStreamDefaultReader<Uint8Array>): void;
  deadlineExceeded(): boolean;
  release(): void;
}

/**
 * Releases a response body that is never going to be read, without ever
 * awaiting a rejection into the caller: a `cancel()` that itself throws must
 * still let the caller return its refusal outcome. See
 * test/github-evidence-source.test.mjs › "a non-2xx response body is never
 * parsed: a poisoned, throwing body still refuses cleanly".
 */
async function releaseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A rejecting cancel must never turn a refusal into a throw.
  }
}

/**
 * Reads `response.body` chunk by chunk, never buffering the whole body
 * before checking size: as soon as the running total exceeds `maxBytes` the
 * reader is cancelled and `{ ok: false }` is returned without ever
 * concatenating or decoding what was read. See
 * test/github-evidence-source.test.mjs › "a response body exceeding
 * maxResponseBytes aborts the read (never buffers the whole body first) and
 * refuses budget_exceeded".
 *
 * `request` is armed with the reader so the request's own deadline (still
 * live across this read — see `performRequest`) can cancel it if the body
 * never closes; when that happens this rejects rather than returning a
 * silent `done`, mirroring test/github-evidence-source.test.mjs › "a
 * response whose headers arrive but whose body never closes is bounded by a
 * deadline, and its reader is released via cancel() (a real-timer race
 * bounds the row itself: it rejects rather than hangs when the adapter never
 * settles)".
 */
async function readCappedBody(response: Response, maxBytes: number, request: PerformedRequest): Promise<CappedBodyResult> {
  const body = response.body;
  if (!body) {
    return { ok: true, text: '' };
  }
  const reader = body.getReader();
  request.armReader(reader);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      if (request.deadlineExceeded()) {
        throw new Error('GITHUB_BODY_READ_DEADLINE_EXCEEDED: the response body did not close within requestTimeoutMs');
      }
      break;
    }
    const chunk = value as Uint8Array;
    total += chunk.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(chunk);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(combined) };
}

/* -------------------------------------------------------------------------- */
/* Link header pagination — bounded work: split, never a nested-quantifier    */
/* regex over the whole header                                                */
/* -------------------------------------------------------------------------- */

function extractRelValue(segment: string): string | null {
  const trimmed = segment.trim();
  const prefix = 'rel="';
  if (!trimmed.startsWith(prefix) || !trimmed.endsWith('"')) {
    return null;
  }
  return trimmed.slice(prefix.length, -1);
}

/** Parses a `Link` header into a `rel -> url` map, by `split(',')`/`split(';')` alone. */
function parseLinkHeader(headerValue: string | null): Map<string, string> {
  const result = new Map<string, string>();
  if (!headerValue) {
    return result;
  }
  for (const entry of headerValue.split(',')) {
    const segments = entry.split(';');
    const urlSegment = (segments[0] ?? '').trim();
    if (!urlSegment.startsWith('<') || !urlSegment.endsWith('>')) {
      continue;
    }
    const url = urlSegment.slice(1, -1);
    for (let index = 1; index < segments.length; index += 1) {
      const rel = extractRelValue(segments[index] ?? '');
      if (rel) {
        result.set(rel, url);
      }
    }
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Factory                                                                    */
/* -------------------------------------------------------------------------- */

export function createGithubEvidenceSource(options: GithubEvidenceSourceOptions): EvidenceSource {
  const owner = validateOwnerOrRepo(options.owner, 'owner');
  const repo = validateOwnerOrRepo(options.repo, 'repo');
  const apiBaseUrl = validateApiBaseUrl(options.apiBaseUrl ?? DEFAULT_API_BASE_URL);
  const token = options.token;
  const fetchFn = options.fetch ?? (globalThis.fetch as typeof fetch);
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const operations = Object.keys(OPERATIONS);

  // A plain `setTimeout`/`AbortController` pair, not `AbortSignal.timeout`:
  // that helper's internal timer is deliberately unref'd, so it never fires
  // once every other ref'd handle has drained — exactly the case a fake
  // fetch that only resolves on abort exercises. See
  // test/github-evidence-source.test.mjs › "a slow response is aborted
  // through the AbortSignal at requestTimeoutMs, and the adapter propagates
  // the resulting rejection as a throw rather than classifying it".
  //
  // The timer stays armed after `fetchFn` resolves on headers: the caller
  // calls `release()` only once it is done with the response, whether that
  // is immediately (a probe whose body is never read) or after a body read
  // it registered via `armReader`. On the deadline, the controller aborts
  // and, if a reader was armed, that reader is cancelled too — see
  // `readCappedBody`.
  async function performRequest(url: URL): Promise<PerformedRequest> {
    const controller = new AbortController();
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      controller.abort();
      activeReader?.cancel().catch(() => {});
    }, requestTimeoutMs);
    function release(): void {
      clearTimeout(timer);
    }
    let response: Response;
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token()}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      release();
      throw error;
    }
    return {
      response,
      armReader(reader) {
        activeReader = reader;
      },
      deadlineExceeded: () => fired,
      release,
    };
  }

  return {
    describe() {
      return { adapterId: GITHUB_ADAPTER_ID, version: GITHUB_ADAPTER_VERSION, operations };
    },

    /**
     * `GET /repos/{o}/{r}` for reachability, then two least-privilege
     * probes: an expiring-token response header, and both `.../hooks` and
     * `.../actions/secrets` answering 403 or 404 (a 2xx there means the
     * token can read beyond its declared scope). See
     * test/github-evidence-source.test.mjs's `check()` section.
     */
    async check(): Promise<EvidenceSourceCheckResult> {
      const repoUrl = new URL(`/repos/${owner}/${repo}`, apiBaseUrl);
      const repoRequest = await performRequest(repoUrl);
      const repoResponse = repoRequest.response;
      if (!isSuccessStatus(repoResponse.status)) {
        const reason = reasonForStatus(repoResponse.status, repoResponse.headers);
        await releaseBody(repoResponse);
        repoRequest.release();
        return { status: 'refused', reason };
      }

      const tokenExpiration = repoResponse.headers.get('github-authentication-token-expiration');
      await releaseBody(repoResponse);
      repoRequest.release();

      const hooksUrl = new URL(`/repos/${owner}/${repo}/hooks`, apiBaseUrl);
      const secretsUrl = new URL(`/repos/${owner}/${repo}/actions/secrets`, apiBaseUrl);
      const [hooksRequest, secretsRequest] = await Promise.all([
        performRequest(hooksUrl),
        performRequest(secretsUrl),
      ]);
      const hooksResponse = hooksRequest.response;
      const secretsResponse = secretsRequest.response;

      // Reuses reasonForStatus's own rate-limit test rather than a second
      // x-ratelimit-remaining check: a 403 hooks/secrets probe answered under
      // rate limiting is not evidence of least privilege either way. See
      // test/github-evidence-source.test.mjs › "check() refuses rate_limited,
      // not ready, when the hooks probe answers 403 with
      // x-ratelimit-remaining: 0 (a rate-limited probe is not proof of least
      // privilege)" and › "check() refuses rate_limited, not ready, when the
      // actions/secrets probe answers 403 with x-ratelimit-remaining: 0 (a
      // rate-limited probe is not proof of least privilege)".
      const hooksReason = reasonForStatus(hooksResponse.status, hooksResponse.headers);
      const secretsReason = reasonForStatus(secretsResponse.status, secretsResponse.headers);
      const hooksOk = hooksResponse.status === 403 || hooksResponse.status === 404;
      const secretsOk = secretsResponse.status === 403 || secretsResponse.status === 404;

      await releaseBody(hooksResponse);
      await releaseBody(secretsResponse);
      hooksRequest.release();
      secretsRequest.release();

      if (hooksReason === 'rate_limited' || secretsReason === 'rate_limited') {
        return { status: 'refused', reason: 'rate_limited' };
      }
      if (!tokenExpiration || !hooksOk || !secretsOk) {
        return { status: 'refused', reason: 'denied' };
      }
      return { status: 'ready' };
    },

    async execute(operation, input, budgetHints): Promise<EvidenceSourceOutcome<unknown>> {
      const spec = OPERATIONS[operation];
      if (!spec) {
        return { status: 'refused', reason: 'adapter_error', provenance: PLACEHOLDER_PROVENANCE };
      }

      const validated = validateInput(spec, input);
      if (!validated.ok) {
        return { status: 'refused', reason: 'adapter_error', provenance: PLACEHOLDER_PROVENANCE };
      }

      const pathname = spec.buildPathname(owner, repo, validated.fields);
      const url = new URL(pathname, apiBaseUrl);
      if (spec.paginated) {
        url.searchParams.set('per_page', '100');
      }
      for (const key of Object.keys(spec.fields)) {
        const field = spec.fields[key];
        if (field.inPath || !Object.prototype.hasOwnProperty.call(validated.fields, key)) {
          continue;
        }
        url.searchParams.set(key, String(validated.fields[key]));
      }

      const maxPages = budgetHints?.maxPages ?? DEFAULT_MAX_PAGES;
      let currentUrl = url;
      let combined: unknown[] = [];
      let pageCount = 0;

      for (;;) {
        const request = await performRequest(currentUrl);
        const response = request.response;
        if (!isSuccessStatus(response.status)) {
          const reason = reasonForStatus(response.status, response.headers);
          await releaseBody(response);
          request.release();
          return { status: 'refused', reason, provenance: PLACEHOLDER_PROVENANCE };
        }

        let bodyResult: CappedBodyResult;
        try {
          bodyResult = await readCappedBody(response, maxResponseBytes, request);
        } finally {
          request.release();
        }
        if (!bodyResult.ok) {
          return { status: 'refused', reason: 'budget_exceeded', provenance: PLACEHOLDER_PROVENANCE };
        }

        // A 2xx body that fails to parse is refused rather than thrown, and
        // the raw text never reaches the outcome — see
        // test/github-evidence-source.test.mjs › "execute() refuses
        // adapter_error, rather than throwing, when a 2xx body is not valid
        // JSON, and the raw body text never reaches the serialized outcome".
        let parsed: unknown;
        try {
          parsed = JSON.parse(bodyResult.text);
        } catch {
          return { status: 'refused', reason: 'adapter_error', provenance: PLACEHOLDER_PROVENANCE };
        }
        pageCount += 1;

        if (!spec.paginated) {
          return { status: 'ok', output: parsed, provenance: PLACEHOLDER_PROVENANCE };
        }
        combined = combined.concat(parsed as unknown[]);

        if (pageCount >= maxPages) {
          return { status: 'ok', output: combined, provenance: PLACEHOLDER_PROVENANCE };
        }

        const next = parseLinkHeader(response.headers.get('link')).get('next');
        if (!next) {
          return { status: 'ok', output: combined, provenance: PLACEHOLDER_PROVENANCE };
        }

        let nextUrl: URL;
        try {
          nextUrl = new URL(next);
        } catch {
          return { status: 'refused', reason: 'adapter_error', provenance: PLACEHOLDER_PROVENANCE };
        }
        if (nextUrl.origin !== apiBaseUrl.origin) {
          return { status: 'refused', reason: 'adapter_error', provenance: PLACEHOLDER_PROVENANCE };
        }
        currentUrl = nextUrl;
      }
    },
  };
}
