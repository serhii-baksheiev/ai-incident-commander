import { createHash } from 'node:crypto';

import type { ExpectedObservation, InvestigationTest, Prediction, ToolId } from './contracts.js';
import { canonicalJson } from './execution.js';

/**
 * AIC-125 slice a: `planInvestigation`, the pure half of "an untested
 * prediction becomes new, planned `InvestigationTest`s". The
 * observation-form -> tool-request TABLE (`routes`, here) and the graph node
 * that calls this with it belong to the graph half of this slice
 * (`packages/graph`, `INVESTIGATION_ROUTES` / `createPlanInvestigation`);
 * here the table is a parameter the caller supplies, never looked up by this
 * module — the same shape `derivePredictions`'s `templates` parameter takes
 * (`./prediction-derivation.ts`).
 *
 * Rules, in application order:
 * 1. Only a prediction with `status: 'untested'` is ever planned — a
 *    `confirmed`, `refuted` or `untestable` prediction contributes no test —
 *    see investigation-planning.test.mjs › "planInvestigation plans nothing
 *    for a confirmed prediction", › "planInvestigation plans nothing for a
 *    refuted prediction", › "planInvestigation plans nothing for a untestable
 *    prediction" and › "planInvestigation plans an untested prediction
 *    sitting among decided ones, and only that one".
 * 2. Predictions are read in input order, and within one prediction every
 *    `expectedIfTrue` observation is planned before every `expectedIfFalse`
 *    observation — see investigation-planning.test.mjs › "planInvestigation
 *    orders tests as expectedIfTrue observations before expectedIfFalse
 *    observations, within one prediction" and › "planInvestigation keeps
 *    predictions in input order: the first prediction's tests precede the
 *    second's".
 * 3. An observation's `form` must be an OWN property of `routes.byForm`
 *    (`Object.hasOwn`, never a plain index read) — a form reachable only
 *    through the prototype chain (`toString`, `constructor`, `__proto__`) is
 *    never treated as a registered route — see investigation-planning.test.mjs
 *    › "planInvestigation produces no test for an observation whose form has
 *    no entry in routes.byForm", › "planInvestigation produces no test for an
 *    observation whose form is only reachable through Object.prototype
 *    (toString), even when the prototype carries a matching route", ›
 *    "planInvestigation produces no test for an observation whose form is the
 *    inherited property name constructor" and › "planInvestigation produces
 *    no test for an observation whose form is the inherited property name
 *    __proto__".
 *
 *    (AIC-142) A `byForm[form]` entry may instead be a signal-keyed selector
 *    `{ bySignal: { [signal]: InvestigationRouteEntry | InvestigationRouteRefusal } }`
 *    — the form alone does not determine the tool (e.g. `signal-state`, where
 *    `dependency-health` and `latency` name different source families than
 *    `error-rate`). When the resolved entry has an own `bySignal` property,
 *    `observation.signal` is looked up in it by the SAME `Object.hasOwn`
 *    discipline; a refusal (`{ refused }`) or a missing key plans NO test —
 *    fail closed, never a fallback to another tool or to the flat form route
 *    — see investigation-planning.test.mjs › "planInvestigation routes a
 *    signal-state observation through a bySignal-shaped route entry, using
 *    observation.signal to select the per-signal route", › "planInvestigation
 *    plans no test when a bySignal entry refuses the signal, and never falls
 *    back to another tool", › "planInvestigation plans no test when
 *    observation.signal has no entry at all in the route's bySignal map (fail
 *    closed, no fallback)", › "planInvestigation produces no test for a
 *    bySignal-shaped route entry when the observation's signal is only
 *    reachable through Object.prototype (toString), even when the prototype
 *    carries a matching route", › "planInvestigation produces no test for a
 *    bySignal-shaped route entry when the observation's signal is the
 *    inherited property name constructor" and › "planInvestigation produces
 *    no test for a bySignal-shaped route entry when the observation's signal
 *    is the inherited property name __proto__". Otherwise (no own
 *    `bySignal`), planning proceeds exactly as before with the resolved
 *    entry.
 * 4. The route's `input` mapping names, for each request field, which
 *    observation field supplies it (`Object.hasOwn` again, on the
 *    observation) — a mapping naming a field the observation does not carry
 *    produces no test rather than a request with a missing or `undefined`
 *    value — see investigation-planning.test.mjs › "planInvestigation
 *    produces no test for an observation missing a field the route mapping
 *    names" and › "planInvestigation builds the request input exactly from
 *    the route mapping's input keys and named observation fields".
 * 5. The test id is deterministic: `'test-' + sha256 hex of
 *    JSON.stringify(canonicalJson([tool, input, routes.version]))` — the same
 *    tool and input under a different `routes.version` always gets a
 *    different id — see investigation-planning.test.mjs › "planInvestigation
 *    builds the test id from tool, input and routes.version, matching the
 *    sha256 recipe exactly" and › "planInvestigation gives a different test
 *    id when routes.version differs, even though tool and input are
 *    identical". A request's identity is its tool and input, whatever id
 *    the test carrying it was given: a request already carried by any
 *    existing test in `tests`, of any status and under any id, is never
 *    planned again — see investigation-planning.test.mjs ›
 *    "planInvestigation does not plan a request an existing test already
 *    carries under a different id, such as one a challenge role proposed" —
 *    and two
 *    observations — of the same or different predictions — that produce the
 *    identical request collapse into one planned test, attributed to
 *    whichever prediction is reached first in the order rule 2 defines — see
 *    investigation-planning.test.mjs › "planInvestigation does not plan a
 *    second test when an existing test of status planned already carries the
 *    identical request", › "planInvestigation does not plan a second test
 *    when an existing test of status executed already carries the identical
 *    request", › "planInvestigation does not plan a second test when an
 *    existing test of status unavailable already carries the identical
 *    request", › "planInvestigation does not plan a second test when an
 *    existing test of status failed already carries the identical request",
 *    › "planInvestigation plans exactly one test when two
 *    observations of two different predictions produce the identical
 *    request, attributed to the first prediction in order" and ›
 *    "planInvestigation plans exactly one test when a single prediction's
 *    expectedIfTrue and expectedIfFalse observations produce the identical
 *    request".
 *
 * Every planned test carries `cost: 'cheap'`, `status: 'planned'`, and parses
 * under `InvestigationTestSchema` — see investigation-planning.test.mjs ›
 * "every planInvestigation test carries cost cheap and status planned, and
 * parses under InvestigationTestSchema".
 *
 * Pure: no clock, env or I/O, and none of `predictions`, `tests` or `routes`
 * is mutated — see investigation-planning.test.mjs › "planInvestigation gives
 * deepEqual output across two identical calls", › "planInvestigation is
 * unaffected by permuting existing tests unrelated to the new observations"
 * and › "planInvestigation does not mutate its predictions, tests or routes
 * inputs".
 *
 * ⚠ Stated limit: the de-dup pass above builds `requestIdentity` from every
 * EXISTING test's `tool` and `input`, through `canonicalJson`
 * (`./execution.js`), and `canonicalJson` throws a `TypeError` on a value it
 * cannot represent — a `BigInt`, or a circular reference. An existing test
 * carrying such an input is not silently skipped by the de-dup pass; the call
 * throws instead — see investigation-planning.test.mjs › "planInvestigation
 * throws when an existing test's input cannot be canonicalised (a BigInt
 * value)" and › "planInvestigation throws when an existing test's input
 * cannot be canonicalised (a circular reference)".
 */

export interface InvestigationRouteEntry {
  readonly tool: ToolId;
  readonly input: Readonly<Record<string, string>>;
}

/**
 * (AIC-142) A signal names no reachable tool at all — e.g. `latency` names
 * two source families in the frozen vocabulary and no route picks between
 * them. A refusal entry names no `tool`, so it can never be planned.
 */
export interface InvestigationRouteRefusal {
  readonly refused: string;
}

/**
 * (AIC-142) A `byForm[form]` value is either a flat route, or — when one
 * form's tool depends on which signal an observation names — a signal-keyed
 * selector. `planInvestigation` resolves `observation.signal` in `bySignal`
 * by own-property lookup only (see rule 3 above); a refusal or a missing key
 * plans no test.
 */
export type InvestigationRouteByFormValue =
  | InvestigationRouteEntry
  | { readonly bySignal: Readonly<Record<string, InvestigationRouteEntry | InvestigationRouteRefusal>> };

/**
 * The observation-form -> tool-request table `planInvestigation` reads.
 * `version` feeds the id recipe alongside `tool` and `input`, so bumping it
 * changes every id a request would otherwise have produced identically.
 */
export interface InvestigationRouteTable {
  readonly version: string;
  readonly byForm: Readonly<Record<string, InvestigationRouteByFormValue>>;
}

export interface PlanInvestigationInput {
  readonly predictions: readonly Prediction[];
  readonly tests: readonly InvestigationTest[];
  readonly routes: InvestigationRouteTable;
}

function buildTestId(tool: string, input: Readonly<Record<string, unknown>>, routesVersion: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(canonicalJson([tool, input, routesVersion])))
    .digest('hex');
  return `test-${digest}`;
}

/**
 * A request's identity is its tool and input, whatever id the test carrying
 * it was given — a challenge role's proposed test included.
 */
function requestIdentity(tool: string, input: unknown): string {
  return JSON.stringify(canonicalJson([tool, input]));
}

function buildRequest(
  observation: ExpectedObservation,
  route: InvestigationRouteEntry,
): Readonly<Record<string, unknown>> | undefined {
  const input: Record<string, unknown> = {};
  for (const [requestField, observationField] of Object.entries(route.input)) {
    if (!Object.hasOwn(observation, observationField)) return undefined;
    input[requestField] = (observation as Readonly<Record<string, unknown>>)[observationField];
  }
  return input;
}

function orderedObservations(prediction: Prediction): readonly ExpectedObservation[] {
  return [...prediction.expectedIfTrue, ...prediction.expectedIfFalse];
}

export function planInvestigation({
  predictions,
  tests,
  routes,
}: PlanInvestigationInput): InvestigationTest[] {
  const claimedRequests = new Set(tests.map((test) => requestIdentity(test.tool, test.input)));
  const planned: InvestigationTest[] = [];

  for (const prediction of predictions) {
    if (prediction.status !== 'untested') continue;

    for (const observation of orderedObservations(prediction)) {
      if (!Object.hasOwn(routes.byForm, observation.form)) continue;
      const formEntry = routes.byForm[observation.form];

      let route: InvestigationRouteEntry;
      if (Object.hasOwn(formEntry, 'bySignal')) {
        const bySignal = (formEntry as { readonly bySignal: Readonly<Record<string, InvestigationRouteEntry | InvestigationRouteRefusal>> }).bySignal;
        const signal = (observation as Readonly<Record<string, unknown>>).signal;
        if (typeof signal !== 'string' || !Object.hasOwn(bySignal, signal)) continue;
        const signalEntry = bySignal[signal];
        if (Object.hasOwn(signalEntry, 'refused')) continue;
        route = signalEntry as InvestigationRouteEntry;
      } else {
        route = formEntry as InvestigationRouteEntry;
      }

      const input = buildRequest(observation, route);
      if (input === undefined) continue;

      const request = requestIdentity(route.tool, input);
      if (claimedRequests.has(request)) continue;
      claimedRequests.add(request);
      const id = buildTestId(route.tool, input, routes.version);

      planned.push({
        id,
        predictionId: prediction.id,
        tool: route.tool,
        input,
        cost: 'cheap',
        status: 'planned',
      });
    }
  }

  return planned;
}
