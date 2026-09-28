import { createHash } from 'node:crypto';

import {
  EXPECTED_OBSERVATION_VERSION,
  SubjectSchema,
  type ExpectedObservation,
  type Hypothesis,
  type Prediction,
} from './contracts.js';
import { canonicalJson } from './execution.js';

/**
 * AIC-124 slice a: `derivePredictions`, the pure half of "a structured cause
 * becomes new Predictions". The mechanism -> template TABLE and the graph
 * node that calls this with it belong to slice b (`packages/graph`); here the
 * table is a parameter the caller supplies, never looked up by this module.
 *
 * Decides, for every hypothesis in `hypotheses`, whether it is eligible for
 * derivation and — if so — emits one `Prediction` per template registered
 * for its `cause.mechanism`, in the rule order below.
 *
 * Rules, in application order:
 * 1. A hypothesis with no `cause` gets no predictions — see
 *    prediction-path-domain.test.mjs › "derivePredictions produces nothing
 *    for a hypothesis carrying no cause".
 * 2. A hypothesis that already has at least one prediction (by
 *    `hypothesisId`, any status) is skipped, never re-derived and never
 *    reset — see prediction-path-domain.test.mjs › "derivePredictions
 *    produces nothing for a hypothesis that already has a prediction, and
 *    does not reset it".
 * 3. `cause.component` must parse under `SubjectSchema` (non-empty, at most
 *    200 characters) — the same bound `ExpectedObservation.subject` carries,
 *    since the component becomes that subject — see
 *    prediction-path-domain.test.mjs › "derivePredictions produces nothing
 *    for an empty cause.component", › "derivePredictions produces nothing
 *    for a cause.component of 201 characters, one past the bound" and ›
 *    "derivePredictions accepts a cause.component of exactly 200 characters,
 *    the bound".
 * 4. `cause.mechanism` must be an OWN property of `templates.byMechanism`
 *    (`Object.hasOwn`, never a plain index read) — a mechanism name reachable
 *    only through the prototype chain (`toString`, `constructor`,
 *    `__proto__`) is never treated as registered, however the caller built
 *    the table — see prediction-path-domain.test.mjs › "derivePredictions
 *    produces nothing for a mechanism name that only Object.prototype
 *    supplies (toString), even when the prototype carries a matching
 *    template array", › "derivePredictions produces nothing for the
 *    inherited mechanism name constructor" and › "derivePredictions produces
 *    nothing for the inherited mechanism name __proto__".
 *
 * For each eligible hypothesis, one `Prediction` is emitted per template
 * registered for its mechanism, in template order, hypotheses kept in
 * `hypotheses` input order — see prediction-path-domain.test.mjs ›
 * "derivePredictions emits one prediction per template, in template order,
 * for an eligible hypothesis" and › "derivePredictions keeps hypotheses in
 * input order across multiple eligible hypotheses". Every
 * `TemplateObservation` in the template becomes an `ExpectedObservation` by
 * adding `subject: hypothesis.cause.component` — see
 * prediction-path-domain.test.mjs › "derivePredictions sets every
 * observation subject to the hypothesis cause component, and never resets an
 * existing decided prediction of a sibling hypothesis". The id is
 * deterministic: `'prediction-' + sha256 hex of
 * JSON.stringify(canonicalJson([hypothesisId, template.key,
 * templates.version]))`, so the same inputs always produce the same id and a
 * different hypothesisId, template key or templates version always changes
 * it — see prediction-path-domain.test.mjs › "derivePredictions builds a
 * deterministic id from hypothesisId, template key and templates version",
 * › "derivePredictions gives the same id on a second call with identical
 * inputs" and › "derivePredictions gives a different id when the
 * hypothesisId differs, the template key differs, or the templates version
 * differs". Every emitted prediction carries `observationVersion:
 * EXPECTED_OBSERVATION_VERSION` and `status: 'untested'`, and parses under
 * `PredictionSchema` — see prediction-path-domain.test.mjs ›
 * "derivePredictions gives each new prediction observationVersion, status
 * untested, and a shape that parses under PredictionSchema".
 *
 * Pure: no clock, env or I/O, and none of `hypotheses`, `predictions` or
 * `templates` is mutated — see prediction-path-domain.test.mjs ›
 * "derivePredictions does not mutate its hypotheses, predictions or
 * templates inputs".
 *
 * Limit: decided predictions are final and monotone from this module's own
 * point of view too — rule 2 above never looks at a prediction's `status`,
 * only at whether one exists for the hypothesis, so a hypothesis that has
 * ever received a prediction never gets a second derivation pass.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/**
 * An `ExpectedObservation` without `subject` — what a template registers,
 * before `derivePredictions` fills `subject` in from the hypothesis's
 * `cause.component`. A plain `Omit` would collapse `ExpectedObservation`'s
 * discriminated union to its common keys only; this stays distributive over
 * the union's three forms.
 */
export type TemplateObservation = DistributiveOmit<ExpectedObservation, 'subject'>;

export interface PredictionTemplate {
  readonly key: string;
  readonly statement: string;
  readonly expectedIfTrue: readonly TemplateObservation[];
  readonly expectedIfFalse: readonly TemplateObservation[];
}

/**
 * The mechanism -> template table `derivePredictions` reads. `version` feeds
 * the id recipe alongside the hypothesis id and the template key, so bumping
 * it changes every id it would otherwise have produced identically.
 */
export interface PredictionTemplateSet {
  readonly version: string;
  readonly byMechanism: Readonly<Record<string, readonly PredictionTemplate[]>>;
}

export interface DerivePredictionsInput {
  readonly hypotheses: readonly Hypothesis[];
  readonly predictions: readonly Prediction[];
  readonly templates: PredictionTemplateSet;
}

function buildPredictionId(hypothesisId: string, templateKey: string, templatesVersion: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalJson([hypothesisId, templateKey, templatesVersion])))
    .digest('hex');
  return `prediction-${digest}`;
}

function withSubject(observation: TemplateObservation, subject: string): ExpectedObservation {
  return { ...observation, subject } as ExpectedObservation;
}

export function derivePredictions({
  hypotheses,
  predictions,
  templates,
}: DerivePredictionsInput): Prediction[] {
  const hypothesesWithPredictions = new Set(
    predictions.map((prediction) => prediction.hypothesisId),
  );
  const derived: Prediction[] = [];

  for (const hypothesis of hypotheses) {
    if (hypothesis.cause === undefined) continue;
    if (hypothesesWithPredictions.has(hypothesis.id)) continue;

    const { component, mechanism } = hypothesis.cause;
    if (!SubjectSchema.safeParse(component).success) continue;
    if (!Object.hasOwn(templates.byMechanism, mechanism)) continue;

    const mechanismTemplates = templates.byMechanism[mechanism];

    for (const template of mechanismTemplates) {
      derived.push({
        id: buildPredictionId(hypothesis.id, template.key, templates.version),
        hypothesisId: hypothesis.id,
        statement: `${template.statement} (${component})`,
        observationVersion: EXPECTED_OBSERVATION_VERSION,
        expectedIfTrue: template.expectedIfTrue.map((observation) => withSubject(observation, component)),
        expectedIfFalse: template.expectedIfFalse.map((observation) => withSubject(observation, component)),
        status: 'untested',
      });
    }
  }

  return derived;
}
