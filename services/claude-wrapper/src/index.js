import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { SYSTEM_PROMPT, buildUserPrompt } from './system-prompt.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const AGENT_NAME = process.env.AGENT_NAME || 'Alex';
const MODEL = 'claude-sonnet-4-20250514';

const anthropic = new Anthropic();

// ─── Claude API ───

async function decide({ currentStep, stepDescription, history, prospectTranscript }) {
  const systemPrompt = SYSTEM_PROMPT.replace('{{agent_name}}', AGENT_NAME);
  const userPrompt = buildUserPrompt({
    currentStep,
    stepDescription,
    history,
    prospectTranscript,
  });

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 300,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const text = response.content[0]?.text || '';

  // Parse JSON response from Claude
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        action: parsed.action || 'WAIT',
        responseText: parsed.response || '',
        reasoning: text,
      };
    }
  } catch (err) {
    logger.warn({ err, text }, 'Failed to parse Claude JSON response');
  }

  // Fallback: treat the whole response as an ANSWER
  return {
    action: 'ANSWER',
    responseText: text.slice(0, 500),
    reasoning: text,
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
    });
  } catch (err) {
    logger.error({ err, call_id }, 'Claude API call failed');
    callback(null, {
      call_id,
      action: 'WAIT',
      response_text: '',
      reasoning: `Error: ${err.message}`,
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
    if (err) throw err;
    logger.info(`Claude wrapper gRPC listening on :${port}`);
    logger.info(`Model: ${MODEL}, Agent name: ${AGENT_NAME}`);
    logger.info(`API key configured: ${process.env.ANTHROPIC_API_KEY ? 'yes' : 'NO'}`);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start claude-wrapper');
  process.exit(1);
});
