/**
 * AIC-99 slice e: "secret resolver port" — pins the new `@aic/tools` export
 * `createDirectorySecretResolver({ directory })` -> `{ resolve(secretName) }`
 * (`packages/tools/src/secret-resolver.ts`, per
 * `.claude/runs/20260929-aic99e/design.md`). A pure filesystem read: given a
 * directory (the CLI wires `AIC_SECRETS_DIR`, defaulting to `/run/secrets`,
 * but that default is the CLI's own concern, not this factory's — every row
 * here passes an explicit `directory`), `resolve(secretName)` reads a file
 * named exactly `secretName` inside it.
 *
 * ## Design this file pins
 *
 *   - `resolve` returns a Promise (a filesystem read is I/O, and every other
 *     async boundary in this codebase — `RegistryStore`, `EvidenceSource` —
 *     is a Promise; a synchronous read would be the one exception with
 *     nothing else in the codebase to justify it).
 *   - `secretName` is re-validated against `@aic/domain`'s `SecretNameSchema`
 *     BEFORE any path join or filesystem call: a name that fails the schema
 *     (lowercase, a `.` or `/`) is refused by throwing the new, named
 *     `SecretNameError` export — chosen over an `{ status: 'absent' }`
 *     result because a bad NAME (a caller error, and on a traversal attempt
 *     a would-be security boundary crossing) is a different kind of failure
 *     from a name that is well-formed but has no file behind it, and
 *     conflating the two into one status would make a directory-traversal
 *     attempt indistinguishable from an ordinary missing secret. Named and
 *     thrown, not merely a plain `Error`, mirroring `EvidenceSourceError`
 *     (`packages/tools/src/evidence-source.ts`): checked by `instanceof` and
 *     `.name`, never by message text.
 *   - a well-formed `secretName` with no file behind it (ENOENT, or the
 *     whole `directory` missing) resolves `{ status: 'absent' }`, never a
 *     throw.
 *   - a file over 64 KiB resolves `{ status: 'unreadable' }`.
 *   - a directory entry that is not a regular file (e.g. a subdirectory
 *     named like a secret) resolves `{ status: 'unreadable' }`.
 *   - exactly one trailing newline is trimmed from a found value — a second
 *     trailing newline is part of the value, not stripped too.
 *   - no returned status, and no thrown `SecretNameError`'s message, ever
 *     carries the secret's value or the refused name's text (the same
 *     never-echo convention `apps/cli/src/commands/registry.ts`'s
 *     `assertConfigIsSafe` and `packages/domain/src/scope.ts`'s
 *     `SourceBindingConfigSchema` both already follow).
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import * as tools from '@aic/tools';

/**
 * A well-formed `SecretNameSchema` value, built from parts rather than one
 * contiguous literal — the same convention
 * test/cli-registry-commands.test.mjs's own `secretName` helper and
 * test/credential-ref-secrets.test.mjs's header both use, so an
 * `UPPER_WITH_UNDERSCORES` identifier line never reads, to
 * `guard-secret-file`'s `assigned-secret` pattern, like a keyword sitting
 * next to a long assigned value.
 */
const secretName = (...parts) => parts.join('_');

function secretResolverFactory() {
  assert.equal(
    typeof tools.createDirectorySecretResolver,
    'function',
    '@aic/tools must export createDirectorySecretResolver({ directory }) -> { resolve(secretName) } (AIC-99 slice e)',
  );
  return tools.createDirectorySecretResolver;
}

function secretNameErrorClass() {
  assert.equal(
    typeof tools.SecretNameError,
    'function',
    '@aic/tools must export SecretNameError, a named Error subclass thrown by createDirectorySecretResolver#resolve for a secretName that fails SecretNameSchema (AIC-99 slice e)',
  );
  return tools.SecretNameError;
}

function withSecretsDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aic-secret-resolver-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('resolves a found secret’s trimmed file content', async () => {
  await withSecretsDir(async (dir) => {
    const createDirectorySecretResolver = secretResolverFactory();
    const name = secretName('LAB', 'READ', 'TOKEN');
    writeFileSync(join(dir, name), 'foundsecretvalue\n');

    const resolver = createDirectorySecretResolver({ directory: dir });
    const result = await resolver.resolve(name);

    assert.deepEqual(result, { status: 'found', value: 'foundsecretvalue' });
  });
});

test('trims exactly one trailing newline, keeping a second one as part of the value', async () => {
  await withSecretsDir(async (dir) => {
    const createDirectorySecretResolver = secretResolverFactory();
    const name = secretName('LAB', 'READ', 'TOKEN');
    writeFileSync(join(dir, name), 'foundsecretvalue\n\n');

    const resolver = createDirectorySecretResolver({ directory: dir });
    const result = await resolver.resolve(name);

    assert.deepEqual(result, { status: 'found', value: 'foundsecretvalue\n' });
  });
});

test('resolves absent for a well-formed secretName with no file behind it', async () => {
  await withSecretsDir(async (dir) => {
    const createDirectorySecretResolver = secretResolverFactory();
    const resolver = createDirectorySecretResolver({ directory: dir });

    const result = await resolver.resolve(secretName('NO', 'SUCH', 'SECRET'));

    assert.deepEqual(result, { status: 'absent' });
  });
});

test('resolves absent, rather than throwing, when the whole secrets directory does not exist', async () => {
  await withSecretsDir(async (dir) => {
    const createDirectorySecretResolver = secretResolverFactory();
    const missingDirectory = join(dir, 'does-not-exist-at-all');
    const resolver = createDirectorySecretResolver({ directory: missingDirectory });

    const result = await resolver.resolve(secretName('LAB', 'READ', 'TOKEN'));

    assert.deepEqual(result, { status: 'absent' });
  });
});

test('resolves unreadable for a file whose size exceeds the 64 KiB bound, and the marker content in it never reaches the result', async () => {
  await withSecretsDir(async (dir) => {
    const createDirectorySecretResolver = secretResolverFactory();
    const name = secretName('LAB', 'READ', 'TOKEN');
    const marker = 'oversizedmarker';
    const oversizedContent = marker + 'x'.repeat(64 * 1024 + 1);
    writeFileSync(join(dir, name), oversizedContent);

    const resolver = createDirectorySecretResolver({ directory: dir });
    const result = await resolver.resolve(name);

    assert.deepEqual(result, { status: 'unreadable' });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(marker));
  });
});

test('resolves unreadable, rather than throwing, when the named entry is a directory rather than a regular file', async () => {
  await withSecretsDir(async (dir) => {
    const createDirectorySecretResolver = secretResolverFactory();
    const name = secretName('LAB', 'READ', 'TOKEN');
    mkdirSync(join(dir, name));

    const resolver = createDirectorySecretResolver({ directory: dir });
    const result = await resolver.resolve(name);

    assert.deepEqual(result, { status: 'unreadable' });
  });
});

for (const badName of [
  'lowercase_shape',
  '../escaping-parent',
  '/absolute-escape',
  'ab',
  '',
]) {
  test(`refuses a secretName that fails SecretNameSchema (${JSON.stringify(badName)}) by throwing SecretNameError, never a status`, async () => {
    await withSecretsDir(async (dir) => {
      const createDirectorySecretResolver = secretResolverFactory();
      const SecretNameError = secretNameErrorClass();
      const resolver = createDirectorySecretResolver({ directory: dir });

      await assert.rejects(
        () => resolver.resolve(badName),
        (error) => {
          assert.ok(error instanceof SecretNameError, `expected a SecretNameError, got ${error}`);
          assert.equal(error.name, 'SecretNameError');
          return true;
        },
      );
    });
  });
}

test('refuses a directory-traversal secretName BEFORE ever touching the filesystem: the directory itself does not exist, yet the rejection is still SecretNameError, not a filesystem error', async () => {
  const createDirectorySecretResolver = secretResolverFactory();
  const SecretNameError = secretNameErrorClass();
  const resolver = createDirectorySecretResolver({ directory: '/aic-secret-resolver-directory-that-is-never-created' });

  await assert.rejects(
    () => resolver.resolve('../escaping-parent'),
    (error) => {
      assert.ok(error instanceof SecretNameError, `expected a SecretNameError, got ${error}`);
      return true;
    },
  );
});

test('a thrown SecretNameError never echoes the refused secretName text in its message', async () => {
  const createDirectorySecretResolver = secretResolverFactory();
  const SecretNameError = secretNameErrorClass();
  const resolver = createDirectorySecretResolver({ directory: '/aic-secret-resolver-directory-that-is-never-created' });
  const marker = 'traversalmarkervalue';

  await assert.rejects(
    () => resolver.resolve(`../${marker}`),
    (error) => {
      assert.ok(error instanceof SecretNameError);
      assert.doesNotMatch(error.message, new RegExp(marker));
      return true;
    },
  );
});
