import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { ElevenLabsClient } from 'elevenlabs';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY || '';
// One voice per language — must match the orchestrator/zoom-bot defaults
const VOICE_IDS = {
  en: 'XrExE9yKIg1WjnnlVkGX', // Matilda
  fr: 'xNtG3W2oqJs0cJZuTyBc', // Chloé
};
const DEFAULT_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ||
  VOICE_IDS[process.env.DEMO_LANGUAGE] ||
  VOICE_IDS.en;
const DEFAULT_MODEL = process.env.TTS_MODEL || 'eleven_turbo_v2';

let elevenLabs = null;

function getClient() {
  if (!elevenLabs && ELEVENLABS_API_KEY) {
    elevenLabs = new ElevenLabsClient({ apiKey: ELEVENLABS_API_KEY });
  }
  return elevenLabs;
}

// ─── gRPC service implementation ───

function loadTTSProto() {
  const packageDef = protoLoader.loadSync(resolve(PROTO_DIR, 'tts.proto'), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function openElevenLabsStream(client, voiceId, params) {
  // One quick retry on a transient failure — a single flaky request must not
  // become a silent utterance mid-demo
  try {
    return await client.textToSpeech.convertAsStream(voiceId, params);
  } catch (err) {
    logger.warn({ err: err.message }, 'ElevenLabs request failed — retrying once');
    await sleep(250);
    return client.textToSpeech.convertAsStream(voiceId, params);
  }
}

async function handleSynthesize(call) {
  const { call_id, text, voice_id, model } = call.request;
  const client = getClient();

  // Failures surface as gRPC errors — a silent empty stream is
  // indistinguishable from success and produced fully mute demos.
  const fail = (message) => {
    logger.error({ call_id, message }, 'TTS synthesis failed');
    call.emit('error', { code: grpc.status.INTERNAL, message });
  };

  if (!client) {
    return fail('ElevenLabs client not configured (missing ELEVENLABS_API_KEY)');
  }
  if (!text || !text.trim()) {
    return fail('Empty text');
  }

  const selectedVoice = voice_id || DEFAULT_VOICE_ID;
  const selectedModel = model || DEFAULT_MODEL;

  // Barge-in support: when the caller cancels (prospect interrupted), stop
  // pulling from ElevenLabs instead of synthesizing to a dead stream
  let cancelled = false;
  call.on('cancelled', () => {
    cancelled = true;
    logger.info({ call_id }, 'Synthesis cancelled by caller');
  });

  logger.info({ call_id, textLength: text.length, voice: selectedVoice }, 'Synthesizing speech');

  try {
    const audioStream = await openElevenLabsStream(client, selectedVoice, {
      text,
      model_id: selectedModel,
      output_format: 'pcm_16000', // 16kHz PCM for Zoom compatibility
      // Cuts ElevenLabs time-to-first-chunk substantially on turbo models
      optimize_streaming_latency: 3,
    });

    let sentAny = false;
    for await (const chunk of audioStream) {
      if (cancelled) break;
      sentAny = true;
      call.write({
        call_id,
        audio_data: chunk,
        sample_rate: 16000,
        encoding: 'LINEAR16',
        is_final: false,
      });
    }

    if (cancelled) {
      call.end();
      return;
    }

    if (!sentAny) {
      return fail('ElevenLabs returned no audio');
    }

    // Signal end of stream
    call.write({
      call_id,
      audio_data: Buffer.alloc(0),
      sample_rate: 16000,
      encoding: 'LINEAR16',
      is_final: true,
    });
    call.end();
  } catch (err) {
    fail(err.message || 'synthesis error');
  }
}

// ─── Main ───

async function main() {
  const proto = loadTTSProto();
  const server = new grpc.Server();

  server.addService(proto.scopio.tts.TTS.service, {
    synthesize: handleSynthesize,
  });

  const port = process.env.GRPC_PORT || '50054';
  server.bindAsync(`0.0.0.0:${port}`, grpc.ServerCredentials.createInsecure(), (err) => {
    if (err) {
      logger.error({ err }, `Failed to bind tts-service gRPC on :${port}`);
      process.exit(1);
    }
    logger.info(`TTS service gRPC listening on :${port}`);
    logger.info(`Voice: ${DEFAULT_VOICE_ID}, Model: ${DEFAULT_MODEL}`);
    logger.info(`API key configured: ${ELEVENLABS_API_KEY ? 'yes' : 'NO'}`);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start tts-service');
  process.exit(1);
});
