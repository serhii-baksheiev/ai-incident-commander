import { createServer } from 'node:http';

import {
  findLiveScenario,
  findScenarioObservation,
  LAB_TOPOLOGY_VERSION,
  LIVE_SCENARIOS,
} from './scenario-definitions.mjs';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const paymentsBaseUrl = process.env.PAYMENTS_BASE_URL ?? 'http://payments:3000';
const inventoryBaseUrl = process.env.INVENTORY_BASE_URL ?? 'http://inventory:3000';
const state = {
  activeIncident: false,
  scenarioId: null,
  scenarioVersion: null,
  labTopologyVersion: LAB_TOPOLOGY_VERSION,
};

class ApiError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new ApiError(400, 'request body is too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'request body must be valid JSON');
  }
}

async function forwardObservation(baseUrl, scenarioId, observation) {
  const url = new URL(`/internal/observations/${observation.toolId}`, baseUrl);
  url.searchParams.set('scenarioId', scenarioId);
  for (const [key, value] of Object.entries(observation.input)) {
    url.searchParams.set(key, value);
  }
  try {
    const response = await fetch(url);
    const body = await response.json();
    if (!response.ok) {
      throw new ApiError(503, 'internal observation dependency is unavailable');
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, 'internal observation dependency is unavailable');
  }
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      const health = await Promise.all(
        [paymentsBaseUrl, inventoryBaseUrl].map(async (baseUrl) => {
          try {
            const dependencyResponse = await fetch(new URL('/health', baseUrl));
            return dependencyResponse.ok;
          } catch {
            return false;
          }
        }),
      );
      const healthy = health.every(Boolean);
      sendJson(response, healthy ? 200 : 503, {
        status: healthy ? 'ok' : 'unavailable',
      });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/control/reset') {
      state.activeIncident = false;
      state.scenarioId = null;
      state.scenarioVersion = null;
      sendJson(response, 200, { ...state });
      return;
    }

    const startMatch = requestUrl.pathname.match(
      /^\/control\/scenarios\/([^/]+)\/start$/,
    );
    if (request.method === 'POST' && startMatch) {
      const scenario = findLiveScenario(decodeURIComponent(startMatch[1]));
      const body = await readJson(request);
      if (!scenario) {
        sendJson(response, 404, { error: 'unknown scenario' });
        return;
      }
      if (body.scenarioVersion !== scenario.version) {
        sendJson(response, 400, { error: 'unsupported scenario version' });
        return;
      }
      state.activeIncident = true;
      state.scenarioId = scenario.id;
      state.scenarioVersion = scenario.version;
      sendJson(response, 200, { ...state });
      return;
    }

    const observationMatch = requestUrl.pathname.match(/^\/observations\/([^/]+)$/);
    if (request.method === 'GET' && observationMatch) {
      const toolId = decodeURIComponent(observationMatch[1]);
      const input = Object.fromEntries(requestUrl.searchParams.entries());
      if (!state.activeIncident) {
        const matchingScenarios = LIVE_SCENARIOS.filter((scenario) =>
          findScenarioObservation(scenario, toolId, input),
        );
        const subject = matchingScenarios.length === 1
          ? matchingScenarios[0].id
          : 'live lab';
        sendJson(response, 409, { error: `${subject} scenario is not active` });
        return;
      }
      const scenario = findLiveScenario(state.scenarioId);
      const observation = findScenarioObservation(
        scenario,
        toolId,
        input,
      );
      if (!observation) {
        sendJson(response, 400, { error: 'unsupported scenario observation' });
        return;
      }
      if (observation.owner === 'api') {
        sendJson(response, 200, observation.output);
        return;
      }
      const ownerUrl = observation.owner === 'payments'
        ? paymentsBaseUrl
        : inventoryBaseUrl;
      sendJson(
        response,
        200,
        await forwardObservation(ownerUrl, scenario.id, observation),
      );
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    const statusCode = error instanceof ApiError ? error.statusCode : 500;
    sendJson(response, statusCode, {
      error: statusCode === 500 ? 'internal server error' : error.message,
    });
  }
});

server.listen(port, '0.0.0.0');
