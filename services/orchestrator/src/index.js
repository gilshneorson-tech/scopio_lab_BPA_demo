import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import { createActor } from 'xstate';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { demoMachine, DEMO_STEPS } from './demo-machine.js';
import {
  createClaudeClient,
  createBrowserClient,
  createTTSClient,
  createPersistenceClient,
} from './grpc-clients.js';
import {
  setSessionState,
  setSessionStep,
  setSessionStarted,
  setProspectName,
  appendHistory,
  getHistory,
  getSessionInfo,
} from './redis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// Active sessions: callId → xstate actor
const sessions = new Map();

// gRPC clients (lazy-initialized)
let claudeClient, browserClient, ttsClient, persistenceClient;

function initClients() {
  claudeClient = createClaudeClient(process.env.CLAUDE_GRPC_ADDR || 'localhost:50052');
  browserClient = createBrowserClient(process.env.BROWSER_GRPC_ADDR || 'localhost:50053');
  ttsClient = createTTSClient(process.env.TTS_GRPC_ADDR || 'localhost:50054');
  persistenceClient = createPersistenceClient(process.env.PERSISTENCE_GRPC_ADDR || 'localhost:50055');
}

// ─── Session helpers ───

function createSession(callId, prospectName) {
  const actor = createActor(demoMachine);

  actor.subscribe((snapshot) => {
    const state = snapshot.value;
    const ctx = snapshot.context;
    logger.info({ callId, state, step: ctx.currentStep }, 'state transition');
    setSessionState(callId, String(state));
    setSessionStep(callId, ctx.currentStep);
  });

  actor.start();
  actor.send({ type: 'START', callId, prospectName });
  sessions.set(callId, actor);

  setSessionStarted(callId, Date.now());
  setProspectName(callId, prospectName);

  return actor;
}

function getStep(index) {
  return DEMO_STEPS[Math.min(index, DEMO_STEPS.length - 1)];
}

// ─── gRPC orchestrator service ───

function loadOrchestratorProto() {
  const PROTO_DIR = resolve(__dirname, '../../../proto');
  const packageDef = protoLoader.loadSync(resolve(PROTO_DIR, 'orchestrator.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef);
}

async function handleTranscription(call, callback) {
  const { call_id, text, is_final } = call.request;

  if (!is_final || !text.trim()) {
    return callback(null, { call_id, type: 'WAIT', demo_step: 0 });
  }

  const actor = sessions.get(call_id);
  if (!actor) {
    return callback(new Error(`No session for call_id: ${call_id}`));
  }

  const snapshot = actor.getSnapshot();
  const ctx = snapshot.context;
  const step = getStep(ctx.currentStep);
  const history = await getHistory(call_id, 5);

  // Ask Claude what to do
  claudeClient.decide(
    {
      call_id,
      current_step: ctx.currentStep,
      step_description: `Step ${step.index}: ${step.topic} — ${step.script}`,
      conversation_history: history,
      prospect_transcript: text,
    },
    (err, response) => {
      if (err) {
        logger.error({ err, call_id }, 'Claude decision failed');
        return callback(null, {
          call_id,
          type: 'WAIT',
          response_text: '',
          demo_step: ctx.currentStep,
        });
      }

      const { action, response_text } = response;

      // Update state machine
      if (action === 'ADVANCE') {
        actor.send({ type: 'ADVANCE' });
      } else if (action === 'ANSWER') {
        actor.send({ type: 'ANSWER', question: text, answer: response_text });
      } else if (action === 'REPEAT') {
        actor.send({ type: 'REPEAT' });
      } else if (action === 'CLOSE') {
        actor.send({ type: 'CLOSE' });
      }

      // Record exchange
      appendHistory(call_id, { role: 'prospect', text, timestamp: Date.now() });
      appendHistory(call_id, { role: 'agent', text: response_text, timestamp: Date.now() });

      // Build browser command for the current/next step
      const updatedSnapshot = actor.getSnapshot();
      const nextStep = getStep(updatedSnapshot.context.currentStep);

      callback(null, {
        call_id,
        type: action,
        response_text,
        browser_command: nextStep.browser_action,
        demo_step: updatedSnapshot.context.currentStep,
      });
    },
  );
}

function handleParticipantEvent(call, callback) {
  const { call_id, participant_name, action } = call.request;
  const actor = sessions.get(call_id);

  if (!actor) {
    return callback(null, { ok: false, message: 'No active session' });
  }

  logger.info({ call_id, participant_name, action }, 'participant event');

  if (action === 'JOINED') {
    actor.send({ type: 'PROSPECT_JOINED', prospectName: participant_name });
    setProspectName(call_id, participant_name);
  } else if (action === 'LEFT') {
    actor.send({ type: 'PROSPECT_LEFT' });
  }

  callback(null, { ok: true });
}

function handleStartSession(call, callback) {
  const { zoom_meeting_id, zoom_meeting_password, prospect_name } = call.request;
  const callId = uuidv4();

  createSession(callId, prospect_name);

  logger.info({ callId, zoom_meeting_id, prospect_name }, 'session started');

  callback(null, {
    call_id: callId,
    state: 'joining',
    current_step: 0,
    prospect_name: prospect_name || '',
    started_at: Date.now(),
    steps_completed: 0,
  });
}

async function handleGetSessionStatus(call, callback) {
  const { call_id } = call.request;
  const info = await getSessionInfo(call_id);

  callback(null, {
    call_id,
    state: info.state,
    current_step: info.step,
    prospect_name: info.prospectName,
    started_at: info.startedAt,
    steps_completed: info.step,
  });
}

function handleEndSession(call, callback) {
  const { call_id } = call.request;
  const actor = sessions.get(call_id);

  if (actor) {
    actor.send({ type: 'CLOSE' });
    sessions.delete(call_id);
  }

  callback(null, { ok: true, message: 'Session ended' });
}

// ─── HTTP API (Fastify) for external triggers ───

async function startHTTP() {
  const app = Fastify({ logger: true });

  app.post('/api/sessions', async (req) => {
    const { zoom_meeting_id, zoom_meeting_password, prospect_name } = req.body;
    const callId = uuidv4();
    createSession(callId, prospect_name);
    return {
      call_id: callId,
      state: 'joining',
      zoom_meeting_id,
    };
  });

  app.get('/api/sessions/:callId', async (req) => {
    const info = await getSessionInfo(req.params.callId);
    return { call_id: req.params.callId, ...info };
  });

  app.post('/api/sessions/:callId/advance', async (req) => {
    const actor = sessions.get(req.params.callId);
    if (!actor) return { error: 'No session found' };
    actor.send({ type: 'ADVANCE' });
    const snapshot = actor.getSnapshot();
    const step = getStep(snapshot.context.currentStep);
    return {
      call_id: req.params.callId,
      state: snapshot.value,
      step: snapshot.context.currentStep,
      topic: step.topic,
    };
  });

  app.post('/api/sessions/:callId/end', async (req) => {
    const actor = sessions.get(req.params.callId);
    if (actor) {
      actor.send({ type: 'CLOSE' });
      sessions.delete(req.params.callId);
    }
    return { ok: true };
  });

  app.get('/health', async () => ({ status: 'ok', service: 'orchestrator' }));

  await app.listen({ port: parseInt(process.env.HTTP_PORT || '3000'), host: '0.0.0.0' });
}

// ─── Start ───

async function main() {
  initClients();

  // gRPC server
  const proto = loadOrchestratorProto();
  const server = new grpc.Server();

  server.addService(proto.scopio.orchestrator.Orchestrator.service, {
    onTranscription: handleTranscription,
    onParticipantEvent: handleParticipantEvent,
    startSession: handleStartSession,
    getSessionStatus: handleGetSessionStatus,
    endSession: handleEndSession,
  });

  const grpcPort = process.env.GRPC_PORT || '50051';
  server.bindAsync(
    `0.0.0.0:${grpcPort}`,
    grpc.ServerCredentials.createInsecure(),
    (err) => {
      if (err) throw err;
      logger.info(`Orchestrator gRPC listening on :${grpcPort}`);
    },
  );

  // HTTP API
  await startHTTP();
  logger.info('Orchestrator fully started');
}

main().catch((err) => {
  logger.error(err, 'Failed to start orchestrator');
  process.exit(1);
});
