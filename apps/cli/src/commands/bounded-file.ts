import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from 'node:fs';

/**
 * Reads one operator-named file as UTF-8 text under a byte bound — the one
 * implementation `aic investigate --replay` and `aic apply -f` share. Every
 * refusal names the operator's own flag and path, never file content.
 *
 * `statSync(path).size` is 0 for a FIFO, a character device or a pipe, so a
 * stat-then-read pair never bounds the read that follows, and a symlink
 * swapped between the stat and the read is a TOCTOU. This opens the path
 * exactly once, inspects the SAME descriptor with `fstatSync`, refuses
 * anything that is not a regular file, and then reads no more than the size
 * bound + 1 byte from that one descriptor.
 *
 * `O_NONBLOCK` on the open is load-bearing for the FIFO case specifically: a
 * blocking open of a FIFO for reading waits for a writer that this command
 * never has, which would hang before `fstatSync` ever runs. With
 * `O_NONBLOCK` the open returns immediately regardless of a writer, `fstat`
 * still reports the true file type, and the `!isFile()` refusal below fires
 * before any read is attempted — for a regular file `O_NONBLOCK` changes
 * nothing about how it is opened or read.
 * see cli-investigate.test.mjs › "a --replay path that is a FIFO (named
 * pipe), not a regular file, is refused by name before any read, and never
 * hangs waiting for a writer" and › "a --replay path that is a symlink to
 * /dev/zero, not a regular file, is refused by name before any read, and
 * never hangs reading an infinite device"
 */
export function readBoundedRegularFile(path: string, options: { readonly flag: string; readonly maxBytes: number }): string {
  const { flag, maxBytes } = options;
  const maxMiB = maxBytes / (1024 * 1024);
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${flag} file could not be read at ${path}: ${message}`);
  }
  try {
    let stats: ReturnType<typeof fstatSync>;
    try {
      stats = fstatSync(fd);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${flag} file could not be read at ${path}: ${message}`);
    }
    if (!stats.isFile()) {
      throw new Error(`${flag} path is not a regular file: ${path}`);
    }
    if (stats.size > maxBytes) {
      throw new Error(
        `${flag} file at ${path} is ${stats.size} bytes, over the ${maxMiB} MiB size bound this command accepts`,
      );
    }

    const readLimit = maxBytes + 1;
    const buffer = Buffer.alloc(readLimit);
    let total = 0;
    for (;;) {
      const bytesRead = readSync(fd, buffer, total, readLimit - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total >= readLimit) {
        throw new Error(`${flag} file at ${path} is over the ${maxMiB} MiB size bound this command accepts`);
      }
    }
    return buffer.toString('utf8', 0, total);
  } finally {
    try {
      closeSync(fd);
    } catch {
      // nothing to recover: the descriptor was only ever read
    }
  }
}
