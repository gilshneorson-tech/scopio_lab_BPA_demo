import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { SYSTEM_PROMPT, buildUserPrompt, VALID_SECTIONS } from './system-prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const AGENT_NAME = process.env.AGENT_NAME || 'Alex';
// claude-sonnet-4-20250514 retired 2026-06-15 — claude-sonnet-5 is its replacement
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';
const DEMO_LANGUAGE = process.env.DEMO_LANGUAGE || 'en';

// Voice pipeline budget: a hung request means dead air on a live call.
// SDK default is 10 minutes / 2 retries — far too slow for a demo.
const REQUEST_TIMEOUT_MS = parseInt(process.env.CLAUDE_TIMEOUT_MS || '8000', 10);

const VALID_ACTIONS = new Set(['ADVANCE', 'ANSWER', 'REPEAT', 'CLOSE']);

// Spoken when the model output can't be parsed or the API fails — never
// route raw model output (or silence) to the prospect.
const FALLBACK_LINE = {
  en: "That's a good question — let me come back to that in just a moment.",
  fr: "Excellente question — permettez-moi d'y revenir dans un instant.",
};

// Lazy client so a missing API key logs a clear message at bind time instead
// of crashing at module load
let anthropic = null;
function getClient() {
  if (!anthropic && process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic({ maxRetries: 1 });
  }
  return anthropic;
}

// ─── Response parsing ───

/**
 * Extract the first balanced JSON object from model output and validate it
 * against the expected shape. Returns null when nothing valid is found —
 * the caller substitutes a safe canned response (raw model output must never
 * be spoken to the prospect).
 */
export function parseDecision(text) {
  if (!text) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    if (start !== -1) {
      let depth = 0;
      let inString = false;
      let escape = false;
      for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) {
            try { parsed = JSON.parse(text.slice(start, i + 1)); } catch { /* invalid */ }
            break;
          }
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') return null;

  const action = String(parsed.action || '').toUpperCase();
  if (!VALID_ACTIONS.has(action)) return null;

  const responseText = typeof parsed.response === 'string' ? parsed.response : '';
  const section = VALID_SECTIONS.has(parsed.section) ? parsed.section : null;

  return { action, responseText, section };
}

// ─── Claude API ───

const systemBlocks = [
  {
    type: 'text',
    text: SYSTEM_PROMPT.replace('{{agent_name}}', AGENT_NAME),
    // Static across every request in a call — served from prompt cache after
    // the first decision (silently a no-op if below the cacheable minimum)
    cache_control: { type: 'ephemeral' },
  },
];

async function decide({ currentStep, stepDescription, history, prospectTranscript }) {
  const client = getClient();
  if (!client) throw new Error('ANTHROPIC_API_KEY not configured');

  const userPrompt = buildUserPrompt({
    currentStep,
    stepDescription,
    // Bound the prompt: a chatty 10-minute call must not inflate latency/cost
    history: (history || []).slice(-8),
    prospectTranscript,
  });

  const response = await client.messages.create(
    {
      model: MODEL,
      max_tokens: 300,
      // Voice latency budget: skip thinking (claude-sonnet-5 runs adaptive
      // thinking by default when the field is omitted)
      thinking: { type: 'disabled' },
      system: systemBlocks,
      messages: [{ role: 'user', content: userPrompt }],
    },
    { timeout: REQUEST_TIMEOUT_MS },
  );

  const textBlock = (response.content || []).find((b) => b.type === 'text');
  const text = textBlock?.text || '';

  const parsed = parseDecision(text);
  if (parsed) {
    return {
      action: parsed.action,
      responseText: parsed.responseText,
      section: parsed.section,
      reasoning: text,
    };
  }

  logger.warn({ text: text.slice(0, 200) }, 'Failed to parse Claude JSON response — using fallback line');
  return {
    action: 'ANSWER',
    responseText: FALLBACK_LINE[DEMO_LANGUAGE] || FALLBACK_LINE.en,
    section: null,
    reasoning: `unparseable: ${text.slice(0, 300)}`,
  };
}

// ─── gRPC server ───

function loadClaudeProto() {
  const packageDef = protoLoader.loadSync(resolve(PROTO_DIR, 'claude.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef);
}

async function handleDecide(call, callback) {
  const {
    call_id,
    current_step,
    step_description,
    conversation_history,
    prospect_transcript,
  } = call.request;

  logger.info({ call_id, current_step, transcript: prospect_transcript }, 'Claude decision requested');

  try {
    const history = (conversation_history || []).map((h) => ({
      role: h.role,
      text: h.text,
    }));

    const result = await decide({
      currentStep: current_step,
      stepDescription: step_description,
      history,
      prospectTranscript: prospect_transcript,
    });

    logger.info({ call_id, action: result.action }, 'Claude decided');

    callback(null, {
      call_id,
      action: result.action,
      response_text: result.responseText,
      reasoning: result.reasoning,
      section: result.section || '',
    });
  } catch (err) {
    logger.error({ err: err.message, call_id }, 'Claude API call failed');
    // A canned spoken answer keeps the call flowing; a silent WAIT leaves the
    // prospect's question hanging with no sign anything went wrong.
    callback(null, {
      call_id,
      action: 'ANSWER',
      response_text: FALLBACK_LINE[DEMO_LANGUAGE] || FALLBACK_LINE.en,
      reasoning: `Error: ${err.message}`,
      section: '',
    });
  }
}

// ─── Main ───

async function main() {
  const proto = loadClaudeProto();
  const server = new grpc.Server();

  server.addService(proto.scopio.claude.ClaudeWrapper.service, {
    decide: handleDecide,
  });

  const port = process.env.GRPC_PORT || '50052';
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      logger.error({ err }, `Failed to bind claude-wrapper gRPC on :${port}`);
      process.exit(1);
    }
    logger.info(`Claude wrapper gRPC listening on :${port}`);
    logger.info(`Model: ${MODEL}, Agent name: ${AGENT_NAME}, timeout: ${REQUEST_TIMEOUT_MS}ms`);
    logger.info(`API key configured: ${process.env.ANTHROPIC_API_KEY ? 'yes' : 'NO'}`);
  });
}

// Allow importing parseDecision for tests without starting the server
if (process.env.NODE_ENV !== 'test') {
  main().catch((err) => {
    logger.error(err, 'Failed to start claude-wrapper');
    process.exit(1);
  });
}
