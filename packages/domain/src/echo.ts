// Internal to @aic/domain: not re-exported from the package index.
/**
 * A caller-supplied value as a refusal may echo it: quoted, escaped and cut to
 * a bound, so a refusal never carries a raw newline or an unbounded string
 * into a log. See durable-execution-contract.test.mjs › "bounds what a refusal
 * echoes of the caller-supplied operation name and statuses".
 */
export function echoed(value: unknown): string {
  let text: string;
  try {
    text = String(value);
  } catch {
    // A value whose own conversion throws must not replace the refusal with
    // its exception; see durable-execution-contract.test.mjs › "bounds what a
    // refusal echoes even when the caller-supplied op's toString() itself throws".
    text = `<unprintable ${typeof value}>`;
  }
  return JSON.stringify(text.length > 64 ? `${text.slice(0, 64)}…` : text);
}
