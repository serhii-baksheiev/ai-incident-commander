/**
 * AIC-96 slice 2: a fixed `primaryScope` for tests that build an
 * `IncidentState`, and the incident-shaping helper that carries it.
 *
 * The two ids are frozen and fixed rather than generated per call, so two
 * fixtures built in the same test compare equal by `deepEqual` unless a test
 * deliberately diverges them — the same reason `TEST_PRIMARY_SCOPE` is a
 * single frozen object rather than a factory.
 */

export const TEST_PRIMARY_SCOPE = Object.freeze({
  serviceId: '11111111-1111-4111-8111-111111111111',
  environmentId: '22222222-2222-4222-8222-222222222222',
});

/**
 * Builds the smallest incident this suite's fixtures need: an id, the fixed
 * `primaryScope` above, and whatever else a caller supplies. `extra` is
 * spread last so a caller can still override `primaryScope` for a row that
 * is deliberately testing a different or missing scope.
 */
export function scopedIncident(id, extra = {}) {
  return { id, primaryScope: TEST_PRIMARY_SCOPE, ...extra };
}
