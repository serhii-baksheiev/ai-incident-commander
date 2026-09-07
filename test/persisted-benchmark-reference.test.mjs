/**
 * AIC-19: what a publication hands back to the run that asked for it.
 *
 * The v0.2 exit gate requires the final evidence to be tied to NATIVE LangSmith
 * identities and the exact candidate SHA. The persistence boundary creates the
 * dataset and reads its id, creates the project and reads its id, and then
 * discards both — so a run that publishes its evidence cannot say afterwards
 * where the evidence went, and the record it writes has to be assembled by hand
 * from what somebody believes happened.
 *
 * Both rows here are about the same property from opposite sides: the
 * identities a publication really produced are the ones the caller receives,
 * and an identity the publication did NOT produce is never handed over as an
 * empty string. An empty native id is worse than a missing one — it serialises
 * into a gate record that looks tied to a workspace object and points at
 * nothing.
 *
 * It is a file of its own rather than more cases in
 * `test/benchmark-evaluation.test.mjs` because that file's two capture helpers
 * both assert what CROSSED the boundary (datasets, examples, projects, runs,
 * feedback), and nothing there reads the call's own answer; these rows read
 * only the answer. The fixtures are the shared ones either way —
 * `capturingClient` and `singleRecordExperiment` from
 * `fixtures/benchmark-experiment.mjs`, the same pair
 * `test/persist-boundary-refusals.test.mjs` uses.
 *
 * ## Isolation
 *
 * Every call below passes its own client, so the real LangSmith client is never
 * constructed. `globalThis.fetch` is replaced for the whole file with a
 * tripwire anyway, on the same reasoning as the sibling refusal file: `langsmith`
 * resolves the global at call time, `node --test` gives this file its own
 * process, and an attempted request fails the test that made it rather than
 * reaching a workspace.
 */
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';

import * as observability from '@aic/observability';

import {
  capturingClient,
  singleRecordExperiment,
} from './fixtures/benchmark-experiment.mjs';

/** Every outbound attempt made by anything in this file. Must stay empty. */
const outboundAttempts = [];

globalThis.fetch = async (input, init) => {
  const target = typeof input === 'string' ? input : String(input?.url ?? input);
  outboundAttempts.push(`${init?.method ?? 'GET'} ${target}`);
  throw new Error('this test attempted an outbound call');
};

afterEach(() => {
  const attempted = outboundAttempts.splice(0, outboundAttempts.length);
  assert.deepEqual(
    attempted,
    [],
    'no test in this file may reach the network: every row passes its own client, so a request here means the real one was constructed',
  );
});

/**
 * The one-record experiment under a caller-chosen experiment id.
 *
 * The experiment id is the project name at this boundary, so the plural entry
 * point needs two that differ — otherwise `projects` cannot show which native
 * project belongs to which experiment, which is the whole reason it is a list.
 */
function experimentNamed(experimentId) {
  const { experiment } = singleRecordExperiment();
  return {
    records: experiment.records.map((record) => ({ ...record, experimentId })),
    results: experiment.results.map((result) => ({ ...result, experimentId })),
  };
}

/** A capturing client whose answer to one create call is the caller's. */
function clientAnswering(method, answer) {
  const capture = capturingClient();
  return {
    ...capture,
    client: {
      ...capture.client,
      async [method](payload) {
        capture.calls.push({ method, payload });
        return answer;
      },
    },
  };
}

test('records the native dataset, project, example and run identities the publication returned', async () => {
  const capture = capturingClient();
  const experiment = experimentNamed('aic-19-final-evaluation');
  const [record] = experiment.records;

  const reference = await observability.persistBenchmarkExperiment({
    client: capture.client,
    datasetName: 'aic-19-final-evaluation-evidence',
    experiment,
  });

  assert.deepEqual(
    reference,
    {
      datasetId: 'resource-dataset-id',
      datasetName: 'aic-19-final-evaluation-evidence',
      projects: [
        {
          experimentId: 'aic-19-final-evaluation',
          projectId: 'resource-project-id',
        },
      ],
      exampleIds: [record.exampleId],
      runIds: [record.runId],
    },
    'the gate record is tied to native identities, and the only place they exist is the answers this call already read and threw away',
  );

  // The plural entry point is where `projects` is a list rather than a single
  // entry, and it is the one the singular delegates to — a reference the
  // singular assembled on its own would be a second implementation of this
  // mapping.
  const pluralCapture = capturingClient();
  const pluralReference = await observability.persistBenchmarkExperiments({
    client: pluralCapture.client,
    datasetName: 'aic-19-final-evaluation-evidence',
    experiments: [
      experimentNamed('aic-19-baseline'),
      experimentNamed('aic-19-candidate'),
    ],
  });

  assert.deepEqual(
    pluralReference.projects.map(({ experimentId }) => experimentId),
    ['aic-19-baseline', 'aic-19-candidate'],
    'one native project per experiment, named by the experiment it belongs to: a bare list of project ids cannot be read back against the arms that produced them',
  );
  assert.deepEqual(
    pluralReference.exampleIds,
    [record.exampleId],
    'both experiments share one set of native example identities, and the reference reports that set once',
  );
});

test('records an absent publication as absent with its reason, never as an empty identity', async () => {
  for (const [method, subject, mustNotReach] of [
    ['createDataset', 'dataset', 'createExamples'],
    ['createProject', 'project', 'createRun'],
  ]) {
    // The shape of a create call that did not create anything: an answer that
    // carries the id KEY with nothing in it. `requireOwnString` reads the field
    // as present and hands `''` on, so today the publication continues and the
    // examples cross the boundary carrying `dataset_id: ""`.
    const capture = clientAnswering(method, { id: '' });

    await assert.rejects(
      () =>
        observability.persistBenchmarkExperiment({
          client: capture.client,
          datasetName: 'aic-19-absent-identity',
          experiment: experimentNamed('aic-19-absent-identity'),
        }),
      (error) => {
        assert.match(
          error.message,
          new RegExp(subject),
          `the refusal must name the ${subject} whose identity the publication never returned: "absent" is a reason a reader can act on, and an empty string is not a reason at all`,
        );
        return true;
      },
    );

    assert.equal(
      capture.calls.some((call) => call.method === mustNotReach),
      false,
      `nothing may be published against an empty ${subject} id: ${mustNotReach} carries it onward, and every record it writes then points at a workspace object that does not exist`,
    );
  }
});
