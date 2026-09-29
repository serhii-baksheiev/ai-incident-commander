import { createGithubEvidenceSource } from './github-source.js';
import { createLabEvidenceSource } from './lab-source.js';
import type { EvidenceSource } from './evidence-source.js';
import type { ResolveSecretResult } from './secret-resolver.js';

/**
 * AIC-99 slice e: `createEvidenceSourceForBinding(binding, { credentialRef,
 * resolveSecret, fetch? })` — the one place the trust boundary
 * `docs/decisions/integration-boundary.md` states ("a write CredentialRef is
 * never a read binding's credential") is enforced before an adapter is ever
 * built. Composes exactly the two existing adapters (`./lab-source.ts`,
 * `./github-source.ts`) from a `SourceBinding` + its resolved read
 * `CredentialRef`. See test/adapter-catalog.test.mjs for the full pinned
 * contract.
 */

/** The shape this factory needs from a `SourceBinding` (`@aic/domain`). */
export interface AdapterCatalogSourceBinding {
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly config: Record<string, string>;
  readonly credentialRefId: string | null;
}

/** The shape this factory needs from a `CredentialRef` (`@aic/domain`). */
export interface AdapterCatalogCredentialRef {
  readonly access: 'read' | 'write';
  readonly secretName: string;
}

export type AdapterCatalogRefusalReason =
  | 'unsupported-adapter'
  | 'invalid-config'
  | 'missing-credential'
  | 'credential-not-read'
  | 'secret-absent'
  | 'secret-unreadable';

export type AdapterCatalogResult =
  | { readonly status: 'ready'; readonly source: EvidenceSource }
  | { readonly status: 'refused'; readonly reason: AdapterCatalogRefusalReason };

export interface AdapterCatalogDeps {
  readonly credentialRef: AdapterCatalogCredentialRef | null;
  readonly resolveSecret: (secretName: string) => Promise<ResolveSecretResult>;
  readonly fetch?: typeof fetch;
}

function refused(reason: AdapterCatalogRefusalReason): AdapterCatalogResult {
  return { status: 'refused', reason };
}

/** `{ baseUrl }` exactly — no extra key, no missing key. */
function isValidLabConfig(config: Record<string, string>): config is { baseUrl: string } {
  const keys = Object.keys(config);
  return keys.length === 1 && typeof config.baseUrl === 'string';
}

/** `{ owner, repo }` exactly — no extra key, no missing key. */
/** A lab base URL must parse and use http or https; anything else is `invalid-config`. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidGithubConfig(config: Record<string, string>): config is { owner: string; repo: string } {
  const keys = Object.keys(config);
  return keys.length === 2 && typeof config.owner === 'string' && typeof config.repo === 'string';
}

export async function createEvidenceSourceForBinding(
  binding: AdapterCatalogSourceBinding,
  deps: AdapterCatalogDeps,
): Promise<AdapterCatalogResult> {
  const { adapterId, adapterVersion, config } = binding;

  if (adapterId === 'lab' && adapterVersion === '1') {
    if (!isValidLabConfig(config) || !isHttpUrl(config.baseUrl)) {
      return refused('invalid-config');
    }
    try {
      return {
        status: 'ready',
        source: createLabEvidenceSource({ baseUrl: config.baseUrl, fetch: deps.fetch as never }),
      };
    } catch {
      return refused('invalid-config');
    }
  }

  if (adapterId === 'github' && adapterVersion === '1') {
    if (!isValidGithubConfig(config)) {
      return refused('invalid-config');
    }
    // The adapter validates owner and repo at construction and names the
    // refused value in its error, so it is built before any secret is read
    // and a throw becomes the closed `invalid-config` refusal, never an
    // echoed value. Its token getter reads the secret resolved below.
    let token: string | undefined;
    let source: EvidenceSource;
    try {
      source = createGithubEvidenceSource({
        owner: config.owner,
        repo: config.repo,
        token: () => {
          if (token === undefined) throw new Error('the github@1 token was read before it was resolved');
          return token;
        },
        fetch: deps.fetch,
      });
    } catch {
      return refused('invalid-config');
    }
    const { credentialRef } = deps;
    if (credentialRef === null) {
      return refused('missing-credential');
    }
    if (credentialRef.access !== 'read') {
      return refused('credential-not-read');
    }
    const secretResult = await deps.resolveSecret(credentialRef.secretName);
    if (secretResult.status === 'absent') {
      return refused('secret-absent');
    }
    if (secretResult.status === 'unreadable') {
      return refused('secret-unreadable');
    }
    token = secretResult.value;
    return { status: 'ready', source };
  }

  return refused('unsupported-adapter');
}
