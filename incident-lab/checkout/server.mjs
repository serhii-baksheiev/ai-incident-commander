import { createServer } from 'node:http';

const port = Number.parseInt(process.env.PORT ?? '3000', 10);
const scenario = {
  activeIncident: false,
  scenarioId: null,
  scenarioVersion: null,
};

const evidenceByObservation = Object.freeze({
  deployments: Object.freeze([
    Object.freeze({
      id: 'checkout-deploy-v42',
      trialId: 'live-lab-bad-deployment-v1-deployments',
      kind: 'deploy',
      source: 'deployments/checkout',
      observedAt: '2026-01-01T00:00:00.000Z',
      statement: 'checkout-v42 changed the database endpoint configuration',
      rawRef: 'live-lab://bad-deployment/v1/deployments/checkout-v42',
      reliability: 'high',
    }),
  ]),
  logs: Object.freeze([
    Object.freeze({
      id: 'checkout-invalid-database-endpoint',
      trialId: 'live-lab-bad-deployment-v1-logs',
      kind: 'log',
      source: 'logs/checkout',
      observedAt: '2026-01-01T00:00:01.000Z',
      statement: 'checkout rejected the database endpoint after checkout-v42',
      rawRef: 'live-lab://bad-deployment/v1/logs/invalid-database-endpoint',
      reliability: 'high',
    }),
  ]),
});

function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(`${JSON.stringify(value)}\n`);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) {
      throw new Error('request body is too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isActiveBadDeployment() {
  return scenario.activeIncident
    && scenario.scenarioId === 'bad-deployment'
    && scenario.scenarioVersion === 1;
}

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(response, 200, { status: 'ok' });
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/control/reset') {
      scenario.activeIncident = false;
      scenario.scenarioId = null;
      scenario.scenarioVersion = null;
      sendJson(response, 200, { ...scenario });
      return;
    }

    if (
      request.method === 'POST'
      && requestUrl.pathname === '/control/scenarios/bad-deployment/start'
    ) {
      const body = await readJson(request);
      if (body.scenarioVersion !== 1) {
        sendJson(response, 400, { error: 'unsupported scenario version' });
        return;
      }
      scenario.activeIncident = true;
      scenario.scenarioId = 'bad-deployment';
      scenario.scenarioVersion = 1;
      sendJson(response, 200, { ...scenario });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/observations/deployments') {
      if (
        requestUrl.searchParams.get('service') !== 'checkout'
        || requestUrl.searchParams.get('window') !== 'incident'
      ) {
        sendJson(response, 400, { error: 'unsupported deployments observation' });
        return;
      }
      if (!isActiveBadDeployment()) {
        sendJson(response, 409, { error: 'bad-deployment scenario is not active' });
        return;
      }
      sendJson(response, 200, evidenceByObservation.deployments);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/observations/logs') {
      if (
        requestUrl.searchParams.get('service') !== 'checkout'
        || requestUrl.searchParams.get('query') !== 'startup-errors'
      ) {
        sendJson(response, 400, { error: 'unsupported logs observation' });
        return;
      }
      if (!isActiveBadDeployment()) {
        sendJson(response, 409, { error: 'bad-deployment scenario is not active' });
        return;
      }
      sendJson(response, 200, evidenceByObservation.logs);
      return;
    }

    sendJson(response, 404, { error: 'not found' });
  } catch (error) {
    sendJson(response, 400, { error: error.message });
  }
});

server.listen(port, '0.0.0.0');
