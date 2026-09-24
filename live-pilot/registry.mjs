/**
 * The live-pilot partition: real incidents reconstructed as replay cases for
 * engineering validation (AIC-127). A live-pilot case is never a benchmark
 * scenario and is never promoted into calibration or final evaluation.
 *
 * Each case splits what an investigation may see from what only an evaluator
 * may read. Paths are relative to this directory.
 * see live-pilot-partition.test.mjs › "declares the live-pilot partition identity and exactly one frozen case, flowa-904, split into model-visible and evaluator-only path groups"
 * see live-pilot-partition.test.mjs › "every live-pilot case id, and the partition name itself, are disjoint from the final-evaluation plan's scenario ids, example ids and partition names"
 */
export const LIVE_PILOT_PARTITION = 'live-pilot';

export const LIVE_PILOT_CASES = Object.freeze([
  Object.freeze({
    id: 'flowa-904',
    partition: LIVE_PILOT_PARTITION,
    modelVisible: Object.freeze({
      intake: 'flowa-904/fixture/intake.json',
      bindings: 'flowa-904/fixture/bindings.json',
      recordings: 'flowa-904/fixture/recordings.json',
    }),
    evaluatorOnly: Object.freeze({
      historicalTruth: 'flowa-904/truth/historical-truth.json',
    }),
  }),
]);
