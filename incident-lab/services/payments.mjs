import { createServer } from 'node:http';

import { findLiveScenario, findScenarioObservation } from './scenario-definitions.mjs';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

const server = createServer((request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }
  const match = requestUrl.pathname.match(/^\/internal\/observations\/([^/]+)$/);
  if (request.method === 'GET' && match) {
    const scenario = findLiveScenario(requestUrl.searchParams.get('scenarioId'));
    const toolId = decodeURIComponent(match[1]);
    const input = Object.fromEntries(
      [...requestUrl.searchParams.entries()].filter(([key]) => key !== 'scenarioId'),
    );
    const observation = scenario
      ? findScenarioObservation(scenario, toolId, input)
      : undefined;
    if (!observation || observation.owner !== 'payments') {
      sendJson(response, 404, { error: 'observation is not owned by payments' });
      return;
    }
    sendJson(response, 200, observation.output);
    return;
  }
  sendJson(response, 404, { error: 'not found' });
});

server.listen(port, '0.0.0.0');
