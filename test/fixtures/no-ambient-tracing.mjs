/**
 * The suite's preload. It calls the one implementation, which lives under
 * `scripts/` so the lane commands can preload it too without loading a file
 * under `test/` (AIC-137). It calls the function rather than relying on the
 * import's side effect, because a module body runs once per process and a
 * re-import of this fixture must clear the flags again.
 */
import { clearAmbientTracing } from '../../scripts/lib/no-ambient-tracing.mjs';

clearAmbientTracing();
