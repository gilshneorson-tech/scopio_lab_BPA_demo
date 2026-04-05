import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import { createActor } from 'xstate';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { demoMachine, DEMO_STEPS, DEMO_LANGUAGE } from './demo-machine.js';

// Voice IDs per language
const VOICE_IDS = {
  en: 'XrExE9yKIg1WjnnlVkGX', // Matilda
  fr: 'xNtG3W2oqJs0cJZuTyBc', // Chloé
};
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || VOICE_IDS[DEMO_LANGUAGE] || VOICE_IDS.en;
import {
  createClaudeClient,
  createBrowserClient,
  createDemoBrowserClient,
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
// Active auto-demos: callId → { running, paused }
const autoDemos = new Map();

// gRPC clients (lazy-initialized)
let claudeClient, browserClient, demoBrowserClient, ttsClient, persistenceClient;

function initClients() {
  claudeClient = createClaudeClient(process.env.CLAUDE_GRPC_ADDR || 'localhost:50052');
  browserClient = createBrowserClient(process.env.BROWSER_GRPC_ADDR || 'localhost:50053');
  demoBrowserClient = createDemoBrowserClient(process.env.DEMO_BROWSER_GRPC_ADDR || 'localhost:50057');
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

function demoBrowserNavigate(callId, section) {
  return new Promise((resolve) => {
    if (!demoBrowserClient) return resolve({ success: false, message: 'No demo browser client' });
    demoBrowserClient.navigateSection(
      { call_id: callId, section },
      { deadline: Date.now() + 5000 },
      (err, result) => {
        if (err) return resolve({ success: false, message: err.message });
        resolve(result);
      },
    );
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

function ttsSynthesize(request) {
  return new Promise((resolve) => {
    if (!ttsClient) return resolve({ audio_chunks: [], error: 'No TTS client' });
    const chunks = [];
    const stream = ttsClient.synthesize(request);
    stream.on('data', (response) => {
      if (response.audio_data && response.audio_data.length > 0) {
        chunks.push(Buffer.from(response.audio_data));
      }
    });
    stream.on('end', () => resolve({ audio_chunks: chunks }));
    stream.on('error', (err) => resolve({ audio_chunks: [], error: err.message }));
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

// Detect brief interrupts: prospect wants to ask a question but hasn't asked it yet
const INTERRUPT_PATTERNS = /\b(i have a question|can i ask|excuse me|hold on|wait|one moment|quick question|before you move on|sorry to interrupt|may i|can i jump in)\b/i;

// Filler / noise that should never pause the demo or call Claude
const FILLER_PATTERNS = /^[\s.,!?]*(?:it|the|a|um|uh|hmm|ok|okay|got it|sure|right|yes|yeah|yep|interesting|cool|great|nice|thanks|thank you|hello|hi|hey|hey alex|alex|hello hello|hello hello hello)[\s.,!?]*$/i;

// STT deduplication: track recent transcripts per call to avoid double-processing
const recentTranscripts = new Map(); // call_id → { text, timestamp }

async function handleTranscription(call, callback) {
  const { call_id, text, is_final } = call.request;
  const t_received = Date.now();
  const trimmed = text.trim();

  if (!trimmed) {
    return callback(null, { call_id, type: 'WAIT', demo_step: 0 });
  }

  // Interim (non-final) results: pause demo immediately but don't process
  if (!is_final) {
    const demoState = autoDemos.get(call_id);
    if (demoState && !demoState.paused && !FILLER_PATTERNS.test(trimmed)) {
      demoState.paused = true;
      logger.info({ call_id, transcript: trimmed.slice(0, 60) }, 'Auto-demo paused — prospect speaking (interim)');
    }
    return callback(null, { call_id, type: 'WAIT', demo_step: 0 });
  }

  // Deduplicate: if we processed a very similar transcript in the last 3s, skip
  const recent = recentTranscripts.get(call_id);
  if (recent && t_received - recent.timestamp < 3000) {
    const overlap = trimmed.startsWith(recent.text) || recent.text.startsWith(trimmed);
    if (overlap) {
      logger.info({ call_id, text: trimmed, prev: recent.text }, 'Duplicate transcript — skipping');
      return callback(null, { call_id, type: 'WAIT', demo_step: 0 });
    }
  }
  recentTranscripts.set(call_id, { text: trimmed, timestamp: t_received });

  const actor = sessions.get(call_id);
  if (!actor) {
    return callback(new Error(`No session for call_id: ${call_id}`));
  }

  // Skip filler / noise — don't pause demo or call Claude for these
  if (FILLER_PATTERNS.test(trimmed)) {
    logger.info({ call_id, text: trimmed }, 'Filler detected — ignoring');
    const demoState = autoDemos.get(call_id);
    if (demoState) demoState.paused = false; // Un-pause if interim paused for filler
    return callback(null, { call_id, type: 'WAIT', demo_step: 0 });
  }

  // Pause auto-demo for substantive speech (may already be paused from interim)
  const demoState = autoDemos.get(call_id);
  if (demoState) {
    demoState.paused = true;
    logger.info({ call_id, transcript: trimmed.slice(0, 60) }, 'Auto-demo paused — prospect speaking');
  }

  const snapshot = actor.getSnapshot();
  const ctx = snapshot.context;
  const step = getStep(ctx.currentStep);

  // Check if this is a brief interrupt (not the actual question yet)
  const isInterrupt = INTERRUPT_PATTERNS.test(text) && text.split(/\s+/).length < 12;

  if (isInterrupt) {
    logger.info({ call_id, text }, 'Interrupt detected — acknowledging, waiting for full question');
    const ackText = 'Of course, go ahead.';
    appendHistory(call_id, { role: 'prospect', text, timestamp: Date.now() });
    appendHistory(call_id, { role: 'agent', text: ackText, timestamp: Date.now() });

    // Demo stays paused — will resume when the actual question is answered
    callback(null, {
      call_id,
      type: 'ANSWER',
      response_text: ackText,
      browser_command: step.browser_action,
      demo_step: ctx.currentStep,
    });
    return;
  }

  const history = await getHistory(call_id, 5);

  try {
    const t_claude_start = Date.now();
    const response = await claudeDecide({
      call_id,
      current_step: ctx.currentStep,
      step_description: `Step ${step.index}: ${step.topic} — ${step.script}`,
      conversation_history: history,
      prospect_transcript: text,
    });
    const t_claude_done = Date.now();

    const { action, response_text } = response;
    const claudeSection = response.section || null;

    logger.info({
      call_id,
      action,
      claudeSection,
      claude_latency_ms: t_claude_done - t_claude_start,
      total_orchestrator_ms: t_claude_done - t_received,
      transcript: text.slice(0, 80),
    }, 'Transcription handled');

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

    // Resume auto-demo after answering
    if (demoState) {
      demoState.paused = false;
      logger.info({ call_id }, 'Auto-demo resumed after Q&A');
    }

    // Navigate browser: use Claude's requested section if provided, otherwise current step
    const updatedSnapshot = actor.getSnapshot();
    const nextStep = getStep(updatedSnapshot.context.currentStep);
    const navSection = claudeSection || nextStep.browser_action.section;
    browserExecuteAction({
      call_id,
      type: 0, // NAVIGATE
      section: navSection,
    });

    callback(null, {
      call_id,
      type: action,
      response_text,
      browser_command: { ...nextStep.browser_action, section: navSection },
      demo_step: updatedSnapshot.context.currentStep,
    });
  } catch (err) {
    logger.error({ err, call_id }, 'Claude decision failed');
    // Resume demo even on error so it doesn't stay stuck
    if (demoState) demoState.paused = false;
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

  // Clean up any stale sessions and auto-demos from previous connections
  for (const [oldCallId, oldDemo] of autoDemos) {
    oldDemo.running = false;
    logger.info({ oldCallId }, 'Stopped stale auto-demo');
  }
  autoDemos.clear();
  for (const [oldCallId, oldActor] of sessions) {
    try { oldActor.send({ type: 'CLOSE' }); } catch {}
    logger.info({ oldCallId }, 'Closed stale session');
  }
  sessions.clear();
  recentTranscripts.clear();

  createSession(callId, prospect_name);

  logger.info({ callId, zoom_meeting_id, prospect_name }, 'session started (clean slate)');

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

  // ─── Auto-Demo: run full 10-step demo autonomously ───

  app.post('/api/sessions/:callId/auto-demo', async (req) => {
    const { callId } = req.params;
    const actor = sessions.get(callId);
    if (!actor) return { error: 'No session found' };

    const snapshot = actor.getSnapshot();
    if (snapshot.value === 'ended' || snapshot.status === 'done') {
      return { error: 'Session already ended' };
    }

    // Don't start if already running
    if (autoDemos.has(callId)) {
      return { call_id: callId, status: 'already_running' };
    }

    const agentName = process.env.AGENT_NAME || 'Alex';
    const demoState = { running: true, paused: false };
    autoDemos.set(callId, demoState);

    logger.info({ callId }, 'Starting auto-demo');

    // Run demo in background (don't await — return immediately)
    (async () => {
      try {
        for (let stepIdx = snapshot.context.currentStep; stepIdx < DEMO_STEPS.length; stepIdx++) {
          if (!demoState.running) break;

          const step = DEMO_STEPS[stepIdx];
          const script = step.script.replace('{{agent_name}}', agentName);

          logger.info({ callId, step: stepIdx, topic: step.topic }, 'Auto-demo step');

          // Navigate the screen-shared browser (zoom-bot's DemoBrowser)
          const navResult = await demoBrowserNavigate(callId, step.browser_action.section);
          if (navResult.success) {
            logger.info({ callId, section: step.browser_action.section }, 'Screen browser navigated');
          } else {
            logger.warn({ callId, section: step.browser_action.section, msg: navResult.message }, 'Screen browser nav failed, falling back to browser-controller');
            browserExecuteAction({ call_id: callId, type: 0, section: step.browser_action.section });
          }

          // Speak the script via TTS
          logger.info({ callId, step: stepIdx, scriptLength: script.length }, 'Speaking step script');
          const ttsResult = await ttsSynthesize({
            call_id: callId,
            text: script,
            voice_id: VOICE_ID,
            model: process.env.TTS_MODEL || 'eleven_turbo_v2',
          });

          if (ttsResult.audio_chunks.length > 0) {
            // Write TTS audio for the zoom-bot virtual mic to pick up
            const combined = Buffer.concat(ttsResult.audio_chunks);
            const ttsFile = '/tmp/zoom-audio/tts-output.pcm';
            try {
              writeFileSync(ttsFile, combined);
              logger.info({ callId, bytes: combined.length }, 'TTS audio written for playback');
            } catch (err) {
              logger.warn({ err: err.message }, 'Failed to write TTS file (zoom-bot will handle)');
            }

            // Wait for speech in small intervals so we can pause on interrupts
            const speechDurationMs = Math.ceil((combined.length / 2) / 16000 * 1000);
            const speechEnd = Date.now() + speechDurationMs + 2000;
            while (Date.now() < speechEnd && demoState.running) {
              if (demoState.paused) {
                logger.info({ callId, step: stepIdx }, 'Narration interrupted — pausing');
                // Hold until prospect finishes speaking
                while (demoState.paused && demoState.running) {
                  await new Promise(r => setTimeout(r, 300));
                }
                logger.info({ callId, step: stepIdx }, 'Resuming after interrupt');
                break; // Move to next step after Q&A
              }
              await new Promise(r => setTimeout(r, 300));
            }
          }

          if (!demoState.running) break;

          // Advance state machine
          if (stepIdx < DEMO_STEPS.length - 1) {
            actor.send({ type: 'ADVANCE' });
          }
        }

        // Demo complete
        actor.send({ type: 'CLOSE' });
        logger.info({ callId }, 'Auto-demo completed');
      } catch (err) {
        logger.error({ err, callId }, 'Auto-demo error');
      } finally {
        autoDemos.delete(callId);
      }
    })();

    return { call_id: callId, status: 'started', steps: DEMO_STEPS.length };
  });

  app.post('/api/sessions/:callId/auto-demo/stop', async (req) => {
    const { callId } = req.params;
    const demo = autoDemos.get(callId);
    if (demo) {
      demo.running = false;
      autoDemos.delete(callId);
      return { call_id: callId, status: 'stopped' };
    }
    return { call_id: callId, status: 'not_running' };
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

  // ─── Dashboard + BMA page serving ───
  const CONFIG_DIR = resolve(__dirname, '../../../config');

  app.get('/', async (req, reply) => {
    const html = readFileSync(resolve(CONFIG_DIR, 'dashboard.html'), 'utf-8');
    reply.type('text/html').send(html);
  });

  app.get('/bma', async (req, reply) => {
    const html = readFileSync(resolve(CONFIG_DIR, 'test-bma.html'), 'utf-8');
    reply.type('text/html').send(html);
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
