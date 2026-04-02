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

// ─── gRPC helpers (callback → promise) ───

function browserExecuteAction(action) {
  return new Promise((resolve) => {
    if (!browserClient) return resolve({ success: false, message: 'No browser client' });
    browserClient.executeAction(action, (err, result) => {
      if (err) return resolve({ success: false, message: err.message });
      resolve(result);
    });
  });
}

function browserInitialize(request) {
  return new Promise((resolve) => {
    if (!browserClient) return resolve({ success: false, message: 'No browser client' });
    browserClient.initialize(request, (err, result) => {
      if (err) return resolve({ success: false, message: err.message });
      resolve(result);
    });
  });
}

function claudeDecide(request) {
  return new Promise((resolve, reject) => {
    if (!claudeClient) return reject(new Error('Claude service not available'));
    claudeClient.decide(request, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
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

  // Auto-transition past 'joining' for manual/HTTP mode
  actor.send({ type: 'PROSPECT_JOINED', prospectName: prospectName || 'Demo Prospect' });

  sessions.set(callId, actor);

  setSessionStarted(callId, Date.now());
  setProspectName(callId, prospectName);

  // Initialize browser (non-blocking, graceful failure)
  browserInitialize({ call_id: callId, url: process.env.BMA_URL || '' }).then((result) => {
    if (result.success) logger.info({ callId }, 'Browser initialized for session');
    else logger.warn({ callId, msg: result.message }, 'Browser init skipped (degraded mode)');
  });

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

  try {
    const response = await claudeDecide({
      call_id,
      current_step: ctx.currentStep,
      step_description: `Step ${step.index}: ${step.topic} — ${step.script}`,
      conversation_history: history,
      prospect_transcript: text,
    });

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

    // Dispatch browser command
    const updatedSnapshot = actor.getSnapshot();
    const nextStep = getStep(updatedSnapshot.context.currentStep);
    browserExecuteAction({
      call_id,
      type: 0, // NAVIGATE
      section: nextStep.browser_action.section,
    });

    callback(null, {
      call_id,
      type: action,
      response_text,
      browser_command: nextStep.browser_action,
      demo_step: updatedSnapshot.context.currentStep,
    });
  } catch (err) {
    logger.error({ err, call_id }, 'Claude decision failed');
    callback(null, {
      call_id,
      type: 'WAIT',
      response_text: '',
      demo_step: ctx.currentStep,
    });
  }
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
    state: 'presenting',
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
    const { zoom_meeting_id, zoom_meeting_password, prospect_name } = req.body || {};
    const callId = uuidv4();
    createSession(callId, prospect_name);

    const actor = sessions.get(callId);
    const snapshot = actor.getSnapshot();
    const step = getStep(snapshot.context.currentStep);

    return {
      call_id: callId,
      state: String(snapshot.value),
      step: 0,
      topic: step.topic,
      section: step.browser_action.section,
      zoom_meeting_id,
    };
  });

  app.get('/api/sessions/:callId', async (req) => {
    const { callId } = req.params;
    const actor = sessions.get(callId);

    if (actor) {
      const snapshot = actor.getSnapshot();
      const ctx = snapshot.context;
      const step = getStep(ctx.currentStep);
      return {
        call_id: callId,
        state: String(snapshot.value),
        step: ctx.currentStep,
        topic: step.topic,
        section: step.browser_action.section,
        prospect_name: ctx.prospectName,
        steps_completed: ctx.stepsCompleted,
      };
    }

    const info = await getSessionInfo(callId);
    return { call_id: callId, ...info };
  });

  app.post('/api/sessions/:callId/advance', async (req) => {
    const { callId } = req.params;
    const actor = sessions.get(callId);
    if (!actor) return { error: 'No session found' };

    const prevSnapshot = actor.getSnapshot();
    if (prevSnapshot.value === 'ended' || prevSnapshot.status === 'done') {
      return { call_id: callId, state: 'ended', message: 'Demo already completed' };
    }

    actor.send({ type: 'ADVANCE' });

    const snapshot = actor.getSnapshot();
    const ctx = snapshot.context;
    const step = getStep(ctx.currentStep);

    // Dispatch browser navigation for this step
    const browserResult = await browserExecuteAction({
      call_id: callId,
      type: 0, // NAVIGATE enum
      section: step.browser_action.section,
    });

    return {
      call_id: callId,
      state: String(snapshot.value),
      step: ctx.currentStep,
      topic: step.topic,
      section: step.browser_action.section,
      script: step.script.replace('{{agent_name}}', process.env.AGENT_NAME || 'Alex'),
      browser_result: browserResult,
    };
  });

  app.post('/api/sessions/:callId/question', async (req) => {
    const { callId } = req.params;
    const { question } = req.body || {};

    if (!question) return { error: 'Missing "question" in request body' };

    const actor = sessions.get(callId);
    if (!actor) return { error: 'No session found' };

    const snapshot = actor.getSnapshot();
    const ctx = snapshot.context;
    const step = getStep(ctx.currentStep);
    const history = await getHistory(callId, 5);

    try {
      const response = await claudeDecide({
        call_id: callId,
        current_step: ctx.currentStep,
        step_description: `Step ${step.index}: ${step.topic} — ${step.script}`,
        conversation_history: history.map((h) => ({ role: h.role, text: h.text })),
        prospect_transcript: question,
      });

      const { action, response_text, reasoning } = response;

      // Update state machine
      if (action === 'ANSWER') {
        actor.send({ type: 'ANSWER', question, answer: response_text });
      } else if (action === 'ADVANCE') {
        actor.send({ type: 'ADVANCE' });
      } else if (action === 'CLOSE') {
        actor.send({ type: 'CLOSE' });
      }

      // Record exchange
      appendHistory(callId, { role: 'prospect', text: question, timestamp: Date.now() });
      appendHistory(callId, { role: 'agent', text: response_text, timestamp: Date.now() });

      const updatedSnapshot = actor.getSnapshot();
      const updatedStep = getStep(updatedSnapshot.context.currentStep);

      return {
        call_id: callId,
        action,
        response_text,
        reasoning,
        state: String(updatedSnapshot.value),
        step: updatedSnapshot.context.currentStep,
        topic: updatedStep.topic,
      };
    } catch (err) {
      logger.error({ err, callId }, 'Claude Q&A failed');
      return {
        call_id: callId,
        error: 'Claude service not available',
        message: err.message,
        step: ctx.currentStep,
        topic: step.topic,
      };
    }
  });

  app.post('/api/sessions/:callId/end', async (req) => {
    const { callId } = req.params;
    const actor = sessions.get(callId);
    if (actor) {
      actor.send({ type: 'CLOSE' });
      sessions.delete(callId);
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
