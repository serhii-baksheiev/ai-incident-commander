import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { SecretNameSchema } from '@aic/domain';

/**
 * AIC-99 slice e: the secret resolver port
 * `createDirectorySecretResolver({ directory })` — a pure filesystem read
 * over a directory of one-file-per-secret entries (the CLI wires
 * `AIC_SECRETS_DIR`, default `/run/secrets`; that default is the CLI's own
 * concern, never this factory's). See test/secret-resolver.test.mjs for the
 * full pinned contract.
 */

/** At most this many bytes are ever read for one secret; anything larger is `unreadable`. */
const MAX_SECRET_BYTES = 64 * 1024;

export type ResolveSecretResult =
  | { readonly status: 'found'; readonly value: string }
  | { readonly status: 'absent' }
  | { readonly status: 'unreadable' };

export interface SecretResolver {
  resolve(secretName: string): Promise<ResolveSecretResult>;
}

export interface DirectorySecretResolverOptions {
  readonly directory: string;
}

/**
 * Thrown by `resolve` when `secretName` fails `@aic/domain`'s
 * `SecretNameSchema` — a caller error (and, on a traversal attempt, a
 * would-be security-boundary crossing), never conflated with an ordinary
 * missing secret. Checked by `instanceof` and `.name`, never by message
 * text; its message never echoes the refused name.
 */
export class SecretNameError extends Error {
  constructor(message = 'secretName failed SecretNameSchema validation') {
    super(message);
    this.name = 'SecretNameError';
  }
}

/**
 * Reads `stats.size` bytes at most from the SAME open handle `stat()` was
 * just called on — never a fresh open/stat — so there is no race between
 * checking a size and reading past it (mirrors
 * `apps/cli/src/commands/investigate.ts`'s `readReplayFile`).
 */
async function readWholeFile(handle: import('node:fs/promises').FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let total = 0;
  while (total < size) {
    const { bytesRead } = await handle.read(buffer, total, size - total, null);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  return buffer.subarray(0, total);
}

export function createDirectorySecretResolver(options: DirectorySecretResolverOptions): SecretResolver {
  const { directory } = options;

  return {
    async resolve(secretName: string): Promise<ResolveSecretResult> {
      // Re-validated BEFORE any path join or filesystem call: a name that
      // fails the schema is a caller error, never a status.
      if (!SecretNameSchema.safeParse(secretName).success) {
        throw new SecretNameError();
      }

      const path = join(directory, secretName);
      let handle;
      try {
        handle = await open(path, 'r');
      } catch (error: unknown) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') {
          return { status: 'absent' };
        }
        return { status: 'unreadable' };
      }

      try {
        const stats = await handle.stat();
        if (!stats.isFile()) {
          return { status: 'unreadable' };
        }
        if (stats.size > MAX_SECRET_BYTES) {
          return { status: 'unreadable' };
        }
        const buffer = await readWholeFile(handle, stats.size);
        let value = buffer.toString('utf8');
        if (value.endsWith('\n')) {
          value = value.slice(0, -1);
        }
        return { status: 'found', value };
      } catch {
        return { status: 'unreadable' };
      } finally {
        await handle.close();
      }
    },
  };
}
