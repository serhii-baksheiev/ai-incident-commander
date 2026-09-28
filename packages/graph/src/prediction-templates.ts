import type { PredictionTemplate, PredictionTemplateSet } from '@aic/domain';

/**
 * AIC-124 slice b: `PREDICTION_TEMPLATES`, the mechanism -> template table
 * `createDerivePredictions` (`./nodes/derive-predictions.ts`) defaults to.
 * `derivePredictions` (`@aic/domain`, slice a) takes the table as a
 * caller-supplied parameter; this is the one production table this package
 * registers.
 *
 * `@aic/graph` cannot import `@aic/evals` — `@aic/evals` depends on
 * `@aic/graph` — so nothing here can check this table's keys against
 * `ROOT_CAUSE_MECHANISMS` at build time. `prediction-nodes.test.mjs` can
 * import both and is the independent check that the two vocabularies name
 * exactly the same mechanisms, in both directions — see
 * prediction-nodes.test.mjs › "PREDICTION_TEMPLATES.byMechanism carries
 * exactly one key per ROOT_CAUSE_MECHANISMS entry, in both directions".
 *
 * Each template's `statement` is that mechanism's own one-line definition
 * (`packages/evals/src/structural-ground-truth.ts`'s `ROOT_CAUSE_MECHANISMS`
 * doc comment), reused for every template registered under that mechanism —
 * a template's statement is derived from the mechanism's definition, never
 * from a corpus scenario:
 *
 * - `deployment-regression` — a change shipped by a deployment broke the
 *   service; one template on whether a deployment landed in the pre-onset
 *   window, one on whether the error rate rose during the incident.
 * - `connection-pool-exhaustion` — every connection in a pool stayed
 *   occupied; one template on whether the pool signal read at-limit.
 * - `cache-stampede` — a burst of cache refills exhausted request workers;
 *   one template on whether workers read at-limit, one on whether refill
 *   activity was logged during the incident.
 *
 * A template commits to the mechanism only — never a corpus evidence id,
 * replay scenario id, or `OBSERVATION_ANNOTATIONS` subject — because
 * `derivePredictions` fills the subject in per hypothesis, from
 * `hypothesis.cause.component`. See prediction-nodes.test.mjs › "never names
 * a corpus evidence id, replay scenario id, or OBSERVATION_ANNOTATIONS
 * subject: a template commits to the mechanism only, and derivePredictions
 * fills the subject in from the hypothesis".
 *
 * Deeply frozen so no caller can mutate a shared default out from under
 * another — see prediction-nodes.test.mjs › "PREDICTION_TEMPLATES is deeply
 * frozen".
 */

function template(value: PredictionTemplate): PredictionTemplate {
  return Object.freeze({
    ...value,
    expectedIfTrue: Object.freeze(
      value.expectedIfTrue.map((observation) => Object.freeze({ ...observation })),
    ),
    expectedIfFalse: Object.freeze(
      value.expectedIfFalse.map((observation) => Object.freeze({ ...observation })),
    ),
  });
}

export const PREDICTION_TEMPLATES: PredictionTemplateSet = Object.freeze({
  version: 'prediction-templates-v1',
  byMechanism: Object.freeze({
    'deployment-regression': Object.freeze([
      template({
        key: 'deployment-before-onset',
        statement: 'a change shipped by a deployment broke the service',
        expectedIfTrue: [{ form: 'deployment-in-window', window: 'pre-onset', presence: 'present' }],
        expectedIfFalse: [{ form: 'deployment-in-window', window: 'pre-onset', presence: 'absent' }],
      }),
      template({
        key: 'error-rate-elevated',
        statement: 'a change shipped by a deployment broke the service',
        expectedIfTrue: [
          { form: 'signal-state', window: 'incident', signal: 'error-rate', state: 'elevated' },
        ],
        expectedIfFalse: [
          { form: 'signal-state', window: 'incident', signal: 'error-rate', state: 'normal' },
        ],
      }),
    ]),
    'connection-pool-exhaustion': Object.freeze([
      template({
        key: 'pool-at-limit',
        statement: 'every connection in a pool stayed occupied',
        expectedIfTrue: [
          { form: 'signal-state', window: 'incident', signal: 'connection-pool', state: 'at-limit' },
        ],
        expectedIfFalse: [
          { form: 'signal-state', window: 'incident', signal: 'connection-pool', state: 'normal' },
        ],
      }),
    ]),
    'cache-stampede': Object.freeze([
      template({
        key: 'workers-at-limit',
        statement: 'a burst of cache refills exhausted request workers',
        expectedIfTrue: [
          { form: 'signal-state', window: 'incident', signal: 'worker-saturation', state: 'at-limit' },
        ],
        expectedIfFalse: [
          { form: 'signal-state', window: 'incident', signal: 'worker-saturation', state: 'normal' },
        ],
      }),
      template({
        key: 'refill-activity',
        statement: 'a burst of cache refills exhausted request workers',
        expectedIfTrue: [
          { form: 'log-class-in-window', window: 'incident', logClass: 'activity', presence: 'present' },
        ],
        expectedIfFalse: [
          { form: 'log-class-in-window', window: 'incident', logClass: 'activity', presence: 'absent' },
        ],
      }),
    ]),
  }),
});
