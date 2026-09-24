import {
  deriveHypothesisStanding,
  type HypothesisStatus,
  type IncidentState,
  type InvestigationStop,
} from '@aic/domain';

/**
 * AIC-119 slice 4 (owner ruling D1, item 7): the prediction-gap diagnostic.
 *
 * This implements owner ruling D1 item 7, and it is DIAGNOSTIC ONLY — never an
 * AIC-19 quality metric. Its keys never appear among `BENCHMARK_METRIC_KEYS` or
 * `BEHAVIOR_METRIC_KEYS`, in a result's `metrics`/`behaviorMetrics`, in a lane's
 * `observedBaseline` or `graphVsNaive`, or in a persisted feedback row.
 * see prediction-gap.test.mjs › "none of the prediction-gap keys appear in
 * BENCHMARK_METRIC_KEYS or BEHAVIOR_METRIC_KEYS"
 * see prediction-gap.test.mjs › "none of the prediction-gap keys appear in a
 * graph-executed result's metrics or behaviorMetrics, in observedBaseline, or
 * in graphVsNaive"
 * see prediction-gap.test.mjs › "persisting a result carrying predictionGap
 * emits no feedback row keyed by any prediction-gap field"
 *
 * "Final", not "reached": every field below is read off the run's FINAL state
 * only, through the one ranking implementation, `deriveHypothesisStanding`
 * (`@aic/domain`) — never re-ranked here.
 * see prediction-gap.test.mjs › "scenario independence: a different incident.id gives an identical diagnostic"
 */

export interface PredictionGap {
  readonly stopKind: InvestigationStop | undefined;
  readonly leaderId: string | undefined;
  readonly leaderStatus: HypothesisStatus | undefined;
  readonly highestStatus: HypothesisStatus | undefined;
  readonly leaderConfirmedPredictions: number;
  readonly finalCorroborated: boolean;
  readonly finalSupported: boolean;
  readonly sufficientFromCorroborated: boolean;
  readonly stalledLeaderLacksConfirmedPrediction: boolean;
  readonly stalledOther: boolean;
}

/**
 * Derives the prediction-gap diagnostic from a run's final `IncidentState`.
 *
 * `highestStatus` is the leader's own status — the leader is always the
 * top-ranked hypothesis by `deriveHypothesisStanding` — and is `undefined`
 * exactly when there is no leader (no hypotheses).
 * see prediction-gap.test.mjs › "no hypotheses at all, terminated stalled,
 * reports an undefined leader and stalledOther, and nothing else"
 *
 * `stalledLeaderLacksConfirmedPrediction` and `stalledOther` partition every
 * non-`sufficient` stop: the former only when the leader is `corroborated`
 * with zero confirmed predictions and the stop is `stalled` or `ambiguous`;
 * every other non-`sufficient` stop, including `tools-unavailable`, reports
 * `stalledOther`.
 * see prediction-gap.test.mjs › "a tools-unavailable termination reports
 * stalledOther, never stalledLeaderLacksConfirmedPrediction, whatever the
 * leader status"
 */
export function predictionGapOf(finalState: IncidentState): PredictionGap {
  const { standings, leaderId } = deriveHypothesisStanding(
    {
      hypotheses: finalState.hypotheses,
      predictions: finalState.predictions,
      assessments: finalState.assessments,
      evidence: finalState.evidence,
    },
    { rulesVersion: finalState.control.statusRulesVersion },
  );

  const leaderStanding = standings.find(({ id }) => id === leaderId);
  const leaderStatus = leaderStanding?.status;
  const highestStatus = leaderStatus;
  const stopKind = finalState.control.stopKind;

  const leaderConfirmedPredictions =
    leaderId === undefined
      ? 0
      : finalState.predictions.filter(
          (prediction) =>
            prediction.hypothesisId === leaderId && prediction.status === 'confirmed',
        ).length;

  const finalCorroborated = standings.some(({ status }) => status === 'corroborated');
  const finalSupported = standings.some(({ status }) => status === 'supported');

  const sufficientFromCorroborated =
    stopKind === 'sufficient' && leaderStatus === 'corroborated';

  const stalledLeaderLacksConfirmedPrediction =
    (stopKind === 'stalled' || stopKind === 'ambiguous') &&
    leaderStatus === 'corroborated' &&
    leaderConfirmedPredictions === 0;

  const stalledOther = stopKind !== 'sufficient' && !stalledLeaderLacksConfirmedPrediction;

  return Object.freeze({
    stopKind,
    leaderId,
    leaderStatus,
    highestStatus,
    leaderConfirmedPredictions,
    finalCorroborated,
    finalSupported,
    sufficientFromCorroborated,
    stalledLeaderLacksConfirmedPrediction,
    stalledOther,
  });
}

/** One arm's `predictionGapOf` flags, summed over its own results. */
export interface PredictionGapCounts {
  readonly runs: number;
  readonly finalCorroborated: number;
  readonly finalSupported: number;
  readonly sufficientFromCorroborated: number;
  readonly stalledLeaderLacksConfirmedPrediction: number;
  readonly stalledOther: number;
}

/**
 * Aggregates `predictionGapOf`'s boolean flags over one arm's own results — the
 * live lane's per-arm `predictionGapCounts` (AIC-119 slice 4). A result with no
 * `predictionGap` (the naive and oracle arms never execute the graph, so their
 * results never carry one) contributes to `runs` and nothing else; the lane
 * never calls this for those two arms.
 * see prediction-gap.test.mjs › "the live lane reports predictionGapCounts for
 * the control and model arms, equal to a hand-computed aggregate of their own
 * results, and reports the measured calibration control fact that every run
 * stalls with no corroborated hypothesis"
 * see prediction-gap.test.mjs › "predictionGapCounts is absent from the oracle
 * and naive arm entries of the live lane report"
 */
export function predictionGapCountsOf(
  results: readonly Readonly<{ predictionGap?: PredictionGap }>[],
): PredictionGapCounts {
  const counts = {
    runs: results.length,
    finalCorroborated: 0,
    finalSupported: 0,
    sufficientFromCorroborated: 0,
    stalledLeaderLacksConfirmedPrediction: 0,
    stalledOther: 0,
  };
  for (const result of results) {
    const gap = result.predictionGap;
    if (gap === undefined) continue;
    if (gap.finalCorroborated) counts.finalCorroborated += 1;
    if (gap.finalSupported) counts.finalSupported += 1;
    if (gap.sufficientFromCorroborated) counts.sufficientFromCorroborated += 1;
    if (gap.stalledLeaderLacksConfirmedPrediction) {
      counts.stalledLeaderLacksConfirmedPrediction += 1;
    }
    if (gap.stalledOther) counts.stalledOther += 1;
  }
  return Object.freeze(counts);
}
