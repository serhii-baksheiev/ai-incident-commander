/**
 * AIC-99 slice e: "adapter factory" — pins the new `@aic/tools` export
 * `createEvidenceSourceForBinding(binding, { credentialRef, resolveSecret,
 * fetch? })` (`packages/tools/src/adapter-catalog.ts`, per
 * `.claude/runs/20260929-aic99e/design.md`). It composes exactly the two
 * existing adapters (`./lab-source.ts`'s `createLabEvidenceSource`,
 * `./github-source.ts`'s `createGithubEvidenceSource`) from a `SourceBinding`
 * + its resolved read `CredentialRef`, and is the one place the trust
 * boundary `docs/decisions/integration-boundary.md` states — "a write
 * CredentialRef is never a read binding's credential" — is enforced before
 * an adapter is ever built.
 *
 * ## Design this file pins
 *
 *   - Returns `Promise<{ status: 'ready', source } | { status: 'refused',
 *     reason }>` where `reason` is one of exactly six closed values:
 *     `unsupported-adapter`, `invalid-config`, `missing-credential`,
 *     `credential-not-read`, `secret-absent`, `secret-unreadable`.
 *   - `lab@1` takes exactly `{ baseUrl }` and no credential;
 *     `credentialRef` is ignored for it (a null credential is the only
 *     binding shape this catalog ever sees for `lab@1`, per
 *     `SourceBindingSchema`'s own credential rules, but the factory itself
 *     is the layer this file pins, not the schema).
 *   - `github@1` takes exactly `{ owner, repo }` and REQUIRES a read
 *     credential; `resolveSecret` is called with the credential's
 *     `secretName` and its `found` value becomes the adapter's `token()`
 *     resolver — never copied into `config` or `describe()`.
 *   - Every refusal that does not need the filesystem (unsupported adapter,
 *     invalid config, missing/wrong-access credential) is decided BEFORE
 *     `resolveSecret` is ever called — asserted on every such row by a
 *     resolver that fails the test if invoked.
 *   - `describe()` on a built source equals the binding's own
 *     `adapterId@adapterVersion`.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import * as tools from '@aic/tools';

const OWNER = 'octo-owner';
const REPO = 'octo-repo';

/** Mirrors test/cli-registry-commands.test.mjs's own runtime-assembled secretName helper. */
const secretName = (...parts) => parts.join('_');

// All-letters, mirroring test/github-evidence-source.test.mjs's own
// `fixtureTokenValue`: a value `guard-secret-file`'s `assigned-secret` arm
// cannot flag, since it rejects an all-letters captured value.
const resolvedSecretValue = 'resolvedreadonlysecretvaluemarker';

function adapterCatalogFactory() {
  assert.equal(
    typeof tools.createEvidenceSourceForBinding,
    'function',
    '@aic/tools must export createEvidenceSourceForBinding(binding, { credentialRef, resolveSecret, fetch? }) (AIC-99 slice e)',
  );
  return tools.createEvidenceSourceForBinding;
}

function makeBinding(overrides = {}) {
  return {
    id: randomUUID(),
    environmentId: randomUUID(),
    adapterId: 'lab',
    adapterVersion: '1',
    name: 'lab-primary',
    config: { baseUrl: 'https://lab.example.test' },
    credentialRefId: null,
    ...overrides,
  };
}

function makeReadCredentialRef(overrides = {}) {
  return {
    id: randomUUID(),
    environmentId: randomUUID(),
    access: 'read',
    name: 'github-read',
    secretName: secretName('GITHUB', 'READ', 'TOKEN'),
    ...overrides,
  };
}

/** Rejects if ever called — proves a refusal short-circuits before resolving a secret. */
function unreachableResolver() {
  return {
    calls: [],
    resolve() {
      throw new Error('ADAPTER_CATALOG_MUST_NOT_RESOLVE_A_SECRET_FOR_THIS_ROW');
    },
  };
}

function fixedResolver(result) {
  const calls = [];
  return {
    calls,
    async resolve(name) {
      calls.push(name);
      return result;
    },
  };
}

function describeString(source) {
  const descriptor = source.describe();
  return `${descriptor.adapterId}@${descriptor.version}`;
}

/* -------------------------------------------------------------------------- */
/* lab@1                                                                      */
/* -------------------------------------------------------------------------- */

test('builds a ready lab@1 source from an exact { baseUrl } config and no credential, and never touches the secret resolver', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const binding = makeBinding();
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef: null,
    resolveSecret: resolver.resolve,
  });

  assert.equal(result.status, 'ready');
  assert.equal(describeString(result.source), 'lab@1');
});

test('refuses invalid-config when lab@1’s config is missing baseUrl, before ever resolving a secret', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const binding = makeBinding({ config: {} });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef: null,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'invalid-config' });
});

test('refuses invalid-config when lab@1’s config carries an extra key beside baseUrl', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const binding = makeBinding({ config: { baseUrl: 'https://lab.example.test', extra: 'not-allowed' } });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef: null,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'invalid-config' });
});

/* -------------------------------------------------------------------------- */
/* unknown adapters                                                           */
/* -------------------------------------------------------------------------- */

test('refuses unsupported-adapter for an adapterId this catalog does not know, before ever resolving a secret', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const binding = makeBinding({ adapterId: 'not-a-known-adapter', config: {} });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef: null,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'unsupported-adapter' });
});

test('refuses unsupported-adapter for a known adapterId at a version this catalog does not know', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const binding = makeBinding({ adapterVersion: '2', config: { baseUrl: 'https://lab.example.test' } });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef: null,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'unsupported-adapter' });
});

/* -------------------------------------------------------------------------- */
/* github@1                                                                   */
/* -------------------------------------------------------------------------- */

/** Enough of a fake fetch for check() to answer `ready` (mirrors github-source.ts's own three-probe check()). */
function readyGithubFetch() {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: url.toString(), init });
    const pathname = url.pathname;
    if (pathname === `/repos/${OWNER}/${REPO}`) {
      return new Response('{}', {
        status: 200,
        headers: { 'github-authentication-token-expiration': '2099-01-01T00:00:00Z' },
      });
    }
    return new Response('', { status: 404 });
  };
  fetchFn.calls = calls;
  return fetchFn;
}

test('builds a ready github@1 source from an exact { owner, repo } config and a read credential whose secret resolves, and the resolved value reaches the adapter only through its token() resolver', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const credentialRef = makeReadCredentialRef();
  const binding = makeBinding({
    adapterId: 'github',
    adapterVersion: '1',
    name: 'github-primary',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: credentialRef.id,
  });
  const resolver = fixedResolver({ status: 'found', value: resolvedSecretValue });
  const fetchFn = readyGithubFetch();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef,
    resolveSecret: resolver.resolve,
    fetch: fetchFn,
  });

  assert.equal(result.status, 'ready');
  assert.equal(describeString(result.source), 'github@1');
  assert.deepEqual(resolver.calls, [credentialRef.secretName]);

  const checkResult = await result.source.check();
  assert.deepEqual(checkResult, { status: 'ready' });
  assert.ok(fetchFn.calls.length > 0, 'check() must have issued at least one request');
  for (const call of fetchFn.calls) {
    assert.equal(call.init.headers.Authorization, `Bearer ${resolvedSecretValue}`);
  }
  assert.doesNotMatch(JSON.stringify(result.source.describe()), new RegExp(resolvedSecretValue));
});

test('refuses invalid-config when github@1’s config is missing repo, before ever resolving a secret', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const credentialRef = makeReadCredentialRef();
  const binding = makeBinding({
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: OWNER },
    credentialRefId: credentialRef.id,
  });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'invalid-config' });
});

test('refuses invalid-config when github@1’s config carries an extra key beside owner and repo', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const credentialRef = makeReadCredentialRef();
  const binding = makeBinding({
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: OWNER, repo: REPO, extra: 'not-allowed' },
    credentialRefId: credentialRef.id,
  });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'invalid-config' });
});

test('refuses missing-credential when github@1 has no credential at all, before ever resolving a secret', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const binding = makeBinding({
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: null,
  });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef: null,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'missing-credential' });
});

test('refuses credential-not-read when the binding’s credential has write access (trust boundary: a write CredentialRef is never a read binding’s credential), before ever resolving a secret', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const writeCredentialRef = makeReadCredentialRef({ access: 'write', name: 'github-write' });
  const binding = makeBinding({
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: writeCredentialRef.id,
  });
  const resolver = unreachableResolver();

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef: writeCredentialRef,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'credential-not-read' });
});

test('refuses secret-absent when the credential’s secret file is absent', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const credentialRef = makeReadCredentialRef();
  const binding = makeBinding({
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: credentialRef.id,
  });
  const resolver = fixedResolver({ status: 'absent' });

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'secret-absent' });
});

test('refuses secret-unreadable when the credential’s secret file is unreadable', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const credentialRef = makeReadCredentialRef();
  const binding = makeBinding({
    adapterId: 'github',
    adapterVersion: '1',
    config: { owner: OWNER, repo: REPO },
    credentialRefId: credentialRef.id,
  });
  const resolver = fixedResolver({ status: 'unreadable' });

  const result = await createEvidenceSourceForBinding(binding, {
    credentialRef,
    resolveSecret: resolver.resolve,
  });

  assert.deepEqual(result, { status: 'refused', reason: 'secret-unreadable' });
});

/* -------------------------------------------------------------------------- */
/* A present but malformed config value is refused, never thrown or echoed    */
/* -------------------------------------------------------------------------- */

test('refuses invalid-config for a github@1 owner or repo that is present but not a valid name, without throwing or reproducing the value, before ever resolving a secret', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  const opaque = ['abc+def', 'ghi=jkl', 'x'.repeat(40)].join('/');
  for (const config of [
    { owner: opaque, repo: REPO },
    { owner: OWNER, repo: opaque },
  ]) {
    const credentialRef = makeReadCredentialRef();
    const binding = makeBinding({ adapterId: 'github', adapterVersion: '1', config, credentialRefId: credentialRef.id });
    const result = await createEvidenceSourceForBinding(binding, {
      credentialRef,
      resolveSecret: unreachableResolver().resolve,
    });
    assert.deepEqual(result, { status: 'refused', reason: 'invalid-config' });
    assert.ok(!JSON.stringify(result).includes(opaque));
  }
});

test('refuses invalid-config for a lab@1 baseUrl that is not an http or https URL', async () => {
  const createEvidenceSourceForBinding = adapterCatalogFactory();
  for (const baseUrl of ['not a url', 'ftp://lab.example.test', 'file:///etc/passwd']) {
    const result = await createEvidenceSourceForBinding(makeBinding({ config: { baseUrl } }), {
      credentialRef: null,
      resolveSecret: unreachableResolver().resolve,
    });
    assert.deepEqual(result, { status: 'refused', reason: 'invalid-config' }, `baseUrl ${JSON.stringify(baseUrl)}`);
  }
});
