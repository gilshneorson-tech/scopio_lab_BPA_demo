import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Fastify from 'fastify';
import { createActor } from 'xstate';
import { v4 as uuidv4 } from 'uuid';
import pino from 'pino';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { demoMachine, DEMO_STEPS, DEMO_LANGUAGE } from './demo-machine.js';
import {
  createTranscriptGate,
  pauseDemo,
  resumeDemo,
  maybeResumeAfterNoise,
  PAUSE_WATCHDOG_MS,
} from './transcript-policy.js';

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
  clearSession,
  redis,
} from './redis.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const AGENT_NAME = process.env.AGENT_NAME || 'Alex';
const TTS_AUDIO_DIR = process.env.TTS_AUDIO_DIR || '/tmp/zoom-audio';
const TTS_FALLBACK_FILE = `${TTS_AUDIO_DIR}/tts-output.pcm`;

// Spoken when the Claude service fails mid-call — silence is worse than a bridge line
const CLAUDE_FALLBACK_LINE = {
  en: "That's a good question — let me come back to that in just a moment.",
  fr: 'Excellente question — permettez-moi d\'y revenir dans un instant.',
};

// gRPC call deadlines (ms) — a hung downstream service must never freeze the call
const CLAUDE_DEADLINE_MS = 15000;
const TTS_DEADLINE_MS = 30000;
const BROWSER_DEADLINE_MS = 10000;

// Active sessions: callId → xstate actor
const sessions = new Map();
// Active auto-demos: callId → { running, paused, pauseReason, pauseWatchdog }
const autoDemos = new Map();

// Transcript classification (filler/dedup/interrupt/echo) — see transcript-policy.js
const gateOptions = { agentName: AGENT_NAME };
if (process.env.MIN_CONFIDENCE) {
  const floor = parseFloat(process.env.MIN_CONFIDENCE);
  if (!Number.isNaN(floor)) gateOptions.minConfidence = floor;
}
const gate = createTranscriptGate(gateOptions);

// After answering, invite a follow-up and hold the pause a little longer so
// the prospect can take the offer before narration resumes
const ANSWER_FOLLOWUP_SUFFIX = {
  en: ' Did that answer your question?',
  fr: ' Est-ce que cela répond à votre question ?',
};
const ANSWER_FOLLOWUP_WAIT_MS = 5000;
const NON_ANSWER_RESUME_EXTRA_MS = 3000;

// gRPC clients (lazy-initialized)
let claudeClient, browserClient, demoBrowserClient, ttsClient, persistenceClient;

function initClients() {
  claudeClient = createClaudeClient(process.env.CLAUDE_GRPC_ADDR || 'localhost:50052');
  browserClient = createBrowserClient(process.env.BROWSER_GRPC_ADDR || 'localhost:50053');
  demoBrowserClient = createDemoBrowserClient(process.env.DEMO_BROWSER_GRPC_ADDR || 'localhost:50057');
  ttsClient = createTTSClient(process.env.TTS_GRPC_ADDR || 'localhost:50054');
  persistenceClient = createPersistenceClient(process.env.PERSISTENCE_GRPC_ADDR || 'localhost:50055');
}

// ─── gRPC helpers (callback → promise, all with deadlines) ───

function browserExecuteAction(action) {
  return new Promise((resolve) => {
    if (!browserClient) return resolve({ success: false, message: 'No browser client' });
    browserClient.executeAction(action, { deadline: Date.now() + BROWSER_DEADLINE_MS }, (err, result) => {
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

function demoBrowserPlayAudio(callId, pcmBuffer, durationMs) {
  return new Promise((resolve) => {
    if (!demoBrowserClient) return resolve({ success: false, message: 'No demo browser client' });
    demoBrowserClient.playAudio(
      { call_id: callId, audio_data: pcmBuffer, sample_rate: 16000 },
      // The RPC resolves after playback finishes — deadline must cover it
      { deadline: Date.now() + durationMs + 15000 },
      (err, result) => {
        if (err) return resolve({ success: false, message: err.message });
        resolve(result);
      },
    );
  });
}

// Fire-and-forget: cut whatever narration is playing (prospect interrupted)
function stopNarration(callId) {
  if (!demoBrowserClient) return;
  demoBrowserClient.stopAudio(
    { call_id: callId },
    { deadline: Date.now() + 3000 },
    (err) => {
      if (err) logger.debug({ callId, err: err.message }, 'StopAudio failed (zoom-bot absent?)');
    },
  );
}

function browserInitialize(request) {
  return new Promise((resolve) => {
    if (!browserClient) return resolve({ success: false, message: 'No browser client' });
    browserClient.initialize(request, { deadline: Date.now() + 30000 }, (err, result) => {
      if (err) return resolve({ success: false, message: err.message });
      resolve(result);
    });
  });
}

function ttsSynthesize(request) {
  return new Promise((resolve) => {
    if (!ttsClient) return resolve({ audio_chunks: [], error: 'No TTS client' });
    const chunks = [];
    const stream = ttsClient.synthesize(request, { deadline: Date.now() + TTS_DEADLINE_MS });
    stream.on('data', (response) => {
      if (response.audio_data && response.audio_data.length > 0) {
        chunks.push(Buffer.from(response.audio_data));
      }
    });
    stream.on('end', () => resolve({ audio_chunks: chunks }));
    stream.on('error', (err) => resolve({ audio_chunks: chunks, error: err.message }));
  });
}

function claudeDecide(request) {
  return new Promise((resolve, reject) => {
    if (!claudeClient) return reject(new Error('Claude service not available'));
    claudeClient.decide(request, { deadline: Date.now() + CLAUDE_DEADLINE_MS }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

// ─── Persistence (fire-and-forget: call logging must never block the call) ───

const PERSIST_DEADLINE_MS = 5000;

function persistSaveCall(record) {
  if (!persistenceClient) return;
  persistenceClient.saveCall(record, { deadline: Date.now() + PERSIST_DEADLINE_MS }, (err) => {
    if (err) logger.debug({ err: err.message }, 'persistence SaveCall failed');
  });
}

function persistTranscript(callId, role, text) {
  if (!persistenceClient) return;
  persistenceClient.appendTranscript(
    { call_id: callId, role, text, timestamp_ms: Date.now() },
    { deadline: Date.now() + PERSIST_DEADLINE_MS },
    (err) => {
      if (err) logger.debug({ err: err.message }, 'persistence AppendTranscript failed');
    },
  );
}

function persistQA(callId, question, answer, demoStep) {
  if (!persistenceClient) return;
  persistenceClient.appendQA(
    { call_id: callId, question, answer, demo_step: demoStep, timestamp_ms: Date.now() },
    { deadline: Date.now() + PERSIST_DEADLINE_MS },
    (err) => {
      if (err) logger.debug({ err: err.message }, 'persistence AppendQA failed');
    },
  );
}

function persistOutcome(callId, outcome, stepsCompleted) {
  if (!persistenceClient) return;
  persistenceClient.updateOutcome(
    { call_id: callId, outcome, steps_completed: stepsCompleted },
    { deadline: Date.now() + PERSIST_DEADLINE_MS },
    (err) => {
      if (err) logger.debug({ err: err.message }, 'persistence UpdateOutcome failed');
    },
  );
}

// Record an exchange in Redis history, Firestore, and the echo suppressor
function recordAgentLine(callId, text) {
  gate.registerAgentSpeech(callId, text);
  appendHistory(callId, { role: 'agent', text, timestamp: Date.now() });
  persistTranscript(callId, 'agent', text);
}

function recordProspectLine(callId, text) {
  appendHistory(callId, { role: 'prospect', text, timestamp: Date.now() });
  persistTranscript(callId, 'prospect', text);
}

// ─── Session helpers ───

function createSession(callId, prospectName, zoomMeetingId = '') {
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
  persistSaveCall({
    call_id: callId,
    zoom_meeting_id: zoomMeetingId || '',
    prospect_name: prospectName || '',
    started_at: Date.now(),
  });

  // Initialize browser (non-blocking, graceful failure)
  browserInitialize({ call_id: callId, url: process.env.BMA_URL || '' }).then((result) => {
    if (result.success) logger.info({ callId }, 'Browser initialized for session');
    else logger.warn({ callId, msg: result.message }, 'Browser init skipped (degraded mode)');
  });

  return actor;
}

/**
 * Fully tear down one session: stop its auto-demo, stop narration, close and
 * stop the actor, clear per-call state, and record the outcome.
 */
function teardownSession(callId, outcome = 'ended') {
  const demo = autoDemos.get(callId);
  if (demo) {
    demo.running = false;
    resumeDemo(demo); // clears the pause watchdog timer
    autoDemos.delete(callId);
  }
  stopNarration(callId);

  const actor = sessions.get(callId);
  if (actor) {
    let steps = 0;
    try {
      steps = actor.getSnapshot().context.stepsCompleted;
    } catch { /* actor already stopped */ }
    try { actor.send({ type: 'CLOSE' }); } catch { /* ignore */ }
    try { actor.stop(); } catch { /* ignore */ }
    sessions.delete(callId);
    persistOutcome(callId, outcome, steps);
  }

  gate.clearCall(callId);
  clearSession(callId);
}

// Single-session model: starting a new session tears down everything stale
function cleanSlate() {
  for (const callId of [...sessions.keys()]) {
    logger.info({ callId }, 'Tearing down stale session (clean slate)');
    teardownSession(callId, 'dropped');
  }
  for (const [callId, demo] of autoDemos) {
    demo.running = false;
    resumeDemo(demo);
    logger.info({ callId }, 'Stopped orphaned auto-demo (clean slate)');
  }
  autoDemos.clear();
  gate.clearAll();
}

function getStep(index) {
  return DEMO_STEPS[Math.min(index, DEMO_STEPS.length - 1)];
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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

const ACK_TEXT = 'Of course, go ahead.';

async function handleTranscription(call, callback) {
  const { call_id, text, is_final, confidence } = call.request;
  const t_received = Date.now();

  const actor = sessions.get(call_id);
  const demoState = autoDemos.get(call_id);
  let currentStep = 0;
  if (actor) {
    try { currentStep = actor.getSnapshot().context.currentStep; } catch { /* stopped */ }
  }
  const reply = (type, extra = {}) =>
    callback(null, { call_id, type, demo_step: currentStep, ...extra });

  const decision = gate.evaluate({
    callId: call_id,
    text,
    isFinal: is_final,
    confidence,
    now: t_received,
  });

  const trimmed = (text || '').trim();

  switch (decision.kind) {
    case 'empty':
      return reply('WAIT');

    case 'interim': {
      if (decision.shouldPause && demoState && demoState.running && !demoState.paused) {
        pauseDemo(demoState, 'interim', PAUSE_WATCHDOG_MS, () =>
          logger.warn({ call_id }, 'Pause watchdog resumed auto-demo (interim never resolved)'));
        stopNarration(call_id);
        logger.info({ call_id, transcript: trimmed.slice(0, 60) }, 'Auto-demo paused — prospect speaking (interim)');
      }
      return reply('WAIT');
    }

    case 'echo':
      logger.info({ call_id, text: trimmed.slice(0, 60) }, 'Own-speech echo detected — ignoring');
      return reply('WAIT');

    case 'duplicate':
      logger.info({ call_id, text: trimmed }, 'Duplicate transcript — skipping');
      return reply('WAIT');

    case 'filler':
      logger.info({ call_id, text: trimmed }, 'Filler detected — ignoring');
      if (demoState) maybeResumeAfterNoise(demoState);
      return reply('WAIT');

    case 'low-confidence':
      logger.info({ call_id, text: trimmed, confidence }, 'Low-confidence STT — ignoring');
      if (demoState) maybeResumeAfterNoise(demoState);
      return reply('WAIT');
  }

  if (!actor) {
    const err = new Error(`No session for call_id: ${call_id}`);
    err.code = grpc.status.NOT_FOUND;
    return callback(err);
  }

  const snapshot = actor.getSnapshot();
  const ctx = snapshot.context;
  const step = getStep(ctx.currentStep);

  if (decision.kind === 'interrupt') {
    if (demoState && demoState.running) {
      pauseDemo(demoState, 'interrupt', PAUSE_WATCHDOG_MS, () =>
        logger.warn({ call_id }, 'Pause watchdog resumed auto-demo (interrupt never followed up)'));
      stopNarration(call_id);
    }
    if (!decision.ack) {
      logger.info({ call_id, text: trimmed }, 'Interrupt during cooldown — still waiting for question');
      return reply('WAIT');
    }
    logger.info({ call_id, text: trimmed }, 'Interrupt detected — acknowledging, waiting for full question');
    recordProspectLine(call_id, trimmed);
    recordAgentLine(call_id, ACK_TEXT);
    return reply('ANSWER', {
      response_text: ACK_TEXT,
      browser_command: step.browser_action,
    });
  }

  // decision.kind === 'question' — pause the demo and route to Claude
  if (demoState && demoState.running) {
    pauseDemo(demoState, 'question', PAUSE_WATCHDOG_MS, () =>
      logger.warn({ call_id }, 'Pause watchdog resumed auto-demo (answer flow stalled)'));
    stopNarration(call_id);
    logger.info({ call_id, transcript: trimmed.slice(0, 60) }, 'Auto-demo paused — prospect speaking');
  }

  const history = await getHistory(call_id, 5);

  try {
    const t_claude_start = Date.now();
    const response = await claudeDecide({
      call_id,
      current_step: ctx.currentStep,
      step_description: `Step ${step.index}: ${step.topic} — ${step.script}`,
      conversation_history: history,
      prospect_transcript: trimmed,
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
      transcript: trimmed.slice(0, 80),
    }, 'Transcription handled');

    // Update state machine (but don't ADVANCE if demo already ended)
    const currentState = String(snapshot.value);
    if (currentState !== 'ended' && snapshot.status !== 'done') {
      if (action === 'ADVANCE') {
        // While an auto-demo runs, the loop owns stepping — Claude's ADVANCE
        // just means "nothing to answer, keep going" (prevents double-advance).
        if (!(demoState && demoState.running)) {
          actor.send({ type: 'ADVANCE' });
        }
      } else if (action === 'ANSWER') {
        actor.send({ type: 'ANSWER', question: trimmed, answer: response_text });
      } else if (action === 'REPEAT') {
        actor.send({ type: 'REPEAT' });
      } else if (action === 'CLOSE') {
        actor.send({ type: 'CLOSE' });
        if (demoState) demoState.running = false;
      }
    }

    // Mid-demo answers invite a follow-up question before narration resumes
    let finalResponseText = response_text;
    if (action === 'ANSWER' && response_text && demoState && demoState.running) {
      finalResponseText =
        response_text + (ANSWER_FOLLOWUP_SUFFIX[DEMO_LANGUAGE] || ANSWER_FOLLOWUP_SUFFIX.en);
    }

    // Record exchange
    recordProspectLine(call_id, trimmed);
    if (finalResponseText) {
      recordAgentLine(call_id, finalResponseText);
      if (action === 'ANSWER') {
        persistQA(call_id, trimmed, finalResponseText, ctx.currentStep);
      }
    }

    // Resume narration after the answer has (approximately) played out, plus
    // a grace window for follow-up questions. zoom-bot serializes all
    // playback, so an early resume cannot talk over the answer — narration
    // just queues behind it.
    if (demoState && demoState.running) {
      const estimatedSpeechMs = Math.max((finalResponseText || '').length * 60, 2000);
      const followUpWaitMs = action === 'ANSWER' ? ANSWER_FOLLOWUP_WAIT_MS : NON_ANSWER_RESUME_EXTRA_MS;
      setTimeout(() => {
        if (demoState.paused) {
          resumeDemo(demoState);
          logger.info({ call_id }, 'Auto-demo resumed after Q&A');
        }
      }, estimatedSpeechMs + followUpWaitMs);
    }

    // Navigate browser: use Claude's section, or stay on current section
    const navSection = claudeSection || step.browser_action.section;
    demoBrowserNavigate(call_id, navSection);

    // Re-read the step — Claude may have advanced/closed the machine
    let latestStep = ctx.currentStep;
    try { latestStep = actor.getSnapshot().context.currentStep; } catch { /* stopped */ }

    callback(null, {
      call_id,
      type: action,
      response_text: finalResponseText,
      browser_command: { ...step.browser_action, section: navSection },
      demo_step: latestStep,
    });
  } catch (err) {
    logger.error({ err, call_id }, 'Claude decision failed — speaking fallback line');
    // Never leave the prospect's question hanging in silence: speak a bridge
    // line and let the (already-armed) watchdog resume the demo.
    const fallbackText = CLAUDE_FALLBACK_LINE[DEMO_LANGUAGE] || CLAUDE_FALLBACK_LINE.en;
    recordProspectLine(call_id, trimmed);
    recordAgentLine(call_id, fallbackText);
    if (demoState && demoState.running) {
      const estimatedSpeechMs = Math.max(fallbackText.length * 60, 2000);
      setTimeout(() => {
        if (demoState.paused) resumeDemo(demoState);
      }, estimatedSpeechMs);
    }
    callback(null, {
      call_id,
      type: 'ANSWER',
      response_text: fallbackText,
      browser_command: step.browser_action,
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
    const demo = autoDemos.get(call_id);
    if (demo) demo.running = false;
  }

  callback(null, { ok: true });
}

function handleStartSession(call, callback) {
  const { zoom_meeting_id, zoom_meeting_password, prospect_name } = call.request;
  const callId = uuidv4();

  cleanSlate();
  createSession(callId, prospect_name, zoom_meeting_id);

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

  // Prefer the live actor (authoritative even when Redis is degraded)
  const actor = sessions.get(call_id);
  if (actor) {
    try {
      const snapshot = actor.getSnapshot();
      const ctx = snapshot.context;
      return callback(null, {
        call_id,
        state: String(snapshot.value),
        current_step: ctx.currentStep,
        prospect_name: ctx.prospectName || '',
        started_at: ctx.startedAt || 0,
        steps_completed: ctx.stepsCompleted,
      });
    } catch { /* actor stopped, fall through to Redis */ }
  }

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
  teardownSession(call_id, 'ended');
  callback(null, { ok: true, message: 'Session ended' });
}

// ─── HTTP API (Fastify) for external triggers ───

async function startHTTP() {
  const app = Fastify({ logger: true });

  app.post('/api/sessions', async (req) => {
    const { zoom_meeting_id, zoom_meeting_password, prospect_name } = req.body || {};
    const callId = uuidv4();

    // Same single-session model as gRPC StartSession: a dashboard "Start Demo"
    // during a live call must not leave the old auto-demo running.
    cleanSlate();
    createSession(callId, prospect_name, zoom_meeting_id);

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

  // List active sessions — lets the dashboard attach to a session the
  // zoom-bot created (it used to show "No active session" during live calls)
  app.get('/api/sessions', async () => {
    const active = [];
    for (const [callId, actor] of sessions) {
      try {
        const snapshot = actor.getSnapshot();
        const ctx = snapshot.context;
        const demo = autoDemos.get(callId);
        active.push({
          call_id: callId,
          state: String(snapshot.value),
          step: ctx.currentStep,
          prospect_name: ctx.prospectName,
          auto_demo: demo ? { running: demo.running, paused: demo.paused } : null,
        });
      } catch { /* actor stopped */ }
    }
    return { sessions: active };
  });

  app.get('/api/sessions/:callId', async (req) => {
    const { callId } = req.params;
    const actor = sessions.get(callId);

    if (actor) {
      const snapshot = actor.getSnapshot();
      const ctx = snapshot.context;
      const step = getStep(ctx.currentStep);
      const demo = autoDemos.get(callId);
      return {
        call_id: callId,
        state: String(snapshot.value),
        step: ctx.currentStep,
        topic: step.topic,
        section: step.browser_action.section,
        prospect_name: ctx.prospectName,
        steps_completed: ctx.stepsCompleted,
        auto_demo: demo ? { running: demo.running, paused: demo.paused, pause_reason: demo.pauseReason || null } : null,
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

    // Navigate both browsers: the screen-shared one (zoom-bot) with fallback
    // to the headless browser-controller — same path the auto-demo uses.
    const navResult = await demoBrowserNavigate(callId, step.browser_action.section);
    let browserResult = navResult;
    if (!navResult.success) {
      browserResult = await browserExecuteAction({
        call_id: callId,
        type: 'NAVIGATE',
        section: step.browser_action.section,
      });
    }

    return {
      call_id: callId,
      state: String(snapshot.value),
      step: ctx.currentStep,
      topic: step.topic,
      section: step.browser_action.section,
      script: step.script.replace('{{agent_name}}', AGENT_NAME),
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
      recordProspectLine(callId, question);
      if (response_text) {
        recordAgentLine(callId, response_text);
        if (action === 'ANSWER') persistQA(callId, question, response_text, ctx.currentStep);
      }

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

    const startSnapshot = actor.getSnapshot();
    if (startSnapshot.value === 'ended' || startSnapshot.status === 'done') {
      return { error: 'Session already ended' };
    }

    // Don't start if already running
    if (autoDemos.has(callId)) {
      return { call_id: callId, status: 'already_running' };
    }

    const demoState = { running: true, paused: false, pauseReason: null, pauseWatchdog: null };
    autoDemos.set(callId, demoState);

    logger.info({ callId }, 'Starting auto-demo');

    // Run demo in background (don't await — return immediately)
    (async () => {
      let outcome = 'completed';
      try {
        while (demoState.running) {
          // Step index comes from the state machine each iteration so a
          // Claude-driven or HTTP-driven ADVANCE can never desync narration.
          const snap = actor.getSnapshot();
          if (snap.status === 'done' || String(snap.value) === 'ended') break;
          const stepIdx = snap.context.currentStep;
          const step = DEMO_STEPS[stepIdx];
          const script = step.script.replace('{{agent_name}}', AGENT_NAME);

          logger.info({ callId, step: stepIdx, topic: step.topic }, 'Auto-demo step');

          // Navigate the screen-shared browser (zoom-bot's DemoBrowser)
          const navResult = await demoBrowserNavigate(callId, step.browser_action.section);
          if (navResult.success) {
            logger.info({ callId, section: step.browser_action.section }, 'Screen browser navigated');
          } else {
            logger.warn({ callId, section: step.browser_action.section, msg: navResult.message }, 'Screen browser nav failed, falling back to browser-controller');
            browserExecuteAction({ call_id: callId, type: 'NAVIGATE', section: step.browser_action.section });
          }

          // Speak the script via TTS
          logger.info({ callId, step: stepIdx, scriptLength: script.length }, 'Speaking step script');
          const ttsResult = await ttsSynthesize({
            call_id: callId,
            text: script,
            voice_id: VOICE_ID,
            model: process.env.TTS_MODEL || 'eleven_turbo_v2',
          });
          if (ttsResult.error) {
            logger.warn({ callId, step: stepIdx, err: ttsResult.error }, 'TTS synthesis failed for step');
          }

          if (!demoState.running) break;

          if (ttsResult.audio_chunks.length > 0) {
            const combined = Buffer.concat(ttsResult.audio_chunks);
            gate.registerAgentSpeech(callId, script);
            persistTranscript(callId, 'agent', script);

            const durationMs = Math.ceil((combined.length / 2) / 16000 * 1000);
            // Preferred path: hand playback to zoom-bot and wait for it to
            // finish (serialized with Q&A answers, interruptible via StopAudio)
            const playResult = await demoBrowserPlayAudio(callId, combined, durationMs);
            if (playResult.success) {
              logger.info({ callId, step: stepIdx, durationMs, stopped: playResult.stopped }, 'Narration played');
            } else {
              // Fallback (no zoom-bot, e.g. local testing): write the shared
              // file directly and wait out the estimated duration
              try {
                mkdirSync(TTS_AUDIO_DIR, { recursive: true });
                writeFileSync(TTS_FALLBACK_FILE, combined);
                logger.info({ callId, bytes: combined.length }, 'TTS audio written for playback (fallback)');
              } catch (err) {
                logger.warn({ err: err.message }, 'Failed to write TTS file');
              }
              const speechEnd = Date.now() + durationMs + 2000;
              while (Date.now() < speechEnd && demoState.running && !demoState.paused) {
                await sleep(300);
              }
            }
          } else {
            logger.warn({ callId, step: stepIdx }, 'No TTS audio for step — pausing briefly instead of racing ahead');
            await sleep(1500);
          }

          // Hold while a Q&A exchange is in flight (pause watchdog bounds this)
          while (demoState.paused && demoState.running) {
            await sleep(300);
          }
          if (!demoState.running) break;

          // The Q&A open-floor step actually holds the floor for its scripted
          // duration instead of racing to the close after two seconds
          if (step.id === 'qa_open') {
            const holdUntil = Date.now() + (step.duration_sec || 60) * 1000;
            logger.info({ callId }, 'Q&A open floor — holding for questions');
            while (Date.now() < holdUntil && demoState.running) {
              await sleep(300);
              while (demoState.paused && demoState.running) await sleep(300);
            }
            if (!demoState.running) break;
          }

          const cur = actor.getSnapshot();
          if (cur.status === 'done' || String(cur.value) === 'ended') break;
          if (cur.context.currentStep !== stepIdx) continue; // already moved (manual/Claude)
          if (stepIdx >= DEMO_STEPS.length - 1) break;
          actor.send({ type: 'ADVANCE' });
        }

        if (demoState.running) {
          try { actor.send({ type: 'CLOSE' }); } catch { /* ignore */ }
          logger.info({ callId }, 'Auto-demo completed');
        } else {
          outcome = 'stopped';
          logger.info({ callId }, 'Auto-demo stopped');
        }
      } catch (err) {
        outcome = 'error';
        logger.error({ err, callId }, 'Auto-demo error');
      } finally {
        resumeDemo(demoState); // clear any pending watchdog timer
        // Compare-and-delete: never delete a NEWER demo's state after a
        // stop-then-restart race
        if (autoDemos.get(callId) === demoState) {
          autoDemos.delete(callId);
        }
        let steps = 0;
        try { steps = actor.getSnapshot().context.stepsCompleted; } catch { /* stopped */ }
        persistOutcome(callId, outcome, steps);
      }
    })();

    return { call_id: callId, status: 'started', steps: DEMO_STEPS.length };
  });

  app.post('/api/sessions/:callId/auto-demo/stop', async (req) => {
    const { callId } = req.params;
    const demo = autoDemos.get(callId);
    if (demo) {
      demo.running = false;
      resumeDemo(demo);
      stopNarration(callId);
      // The loop's finally block removes the map entry (compare-and-delete)
      return { call_id: callId, status: 'stopped' };
    }
    return { call_id: callId, status: 'not_running' };
  });

  app.post('/api/sessions/:callId/end', async (req) => {
    const { callId } = req.params;
    teardownSession(callId, 'ended');
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
  return app;
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
      if (err) {
        logger.error({ err }, `Failed to bind gRPC on :${grpcPort}`);
        process.exit(1);
      }
      logger.info(`Orchestrator gRPC listening on :${grpcPort}`);
    },
  );

  // HTTP API
  const app = await startHTTP();
  logger.info('Orchestrator fully started');

  // Graceful shutdown: stop demos so narration halts, then close servers
  const shutdown = (signal) => {
    logger.info({ signal }, 'Shutting down orchestrator');
    for (const callId of [...sessions.keys()]) {
      teardownSession(callId, 'dropped');
    }
    server.tryShutdown(() => {});
    app.close().catch(() => {});
    redis.quit().catch(() => {});
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error(err, 'Failed to start orchestrator');
  process.exit(1);
});
