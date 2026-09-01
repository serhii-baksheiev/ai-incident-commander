/**
 * Preload: remove the tracer's enablement flags before any test module loads.
 *
 * The suite invokes the investigation graph in-process, and
 * `@langchain/core`'s `isTracingEnabled()` reads this process's own
 * `process.env` — not anything a test passes. So a developer whose shell
 * exports tracing writes real runs into a real LangSmith workspace, with a real
 * key, on every `npm test`. Measured before this preload against a local
 * counting sink: 23 `POST /runs/multipart` and 3 `GET /info` per suite run.
 *
 * Only the four enablement flags are cleared. The api key, project and endpoint
 * are left alone: they decide *where* a trace would go, and clearing them would
 * mask a misconfiguration rather than prevent a request. Tests that need
 * tracing supply it explicitly to a child through `test/fixtures/child-env.mjs`.
 *
 * The list is the tracer's own, from
 * `@langchain/core/dist/utils/callbacks.js` `isTracingEnabled`.
 */
for (const flag of [
  'LANGSMITH_TRACING_V2',
  'LANGCHAIN_TRACING_V2',
  'LANGSMITH_TRACING',
  'LANGCHAIN_TRACING',
]) {
  delete process.env[flag];
}
