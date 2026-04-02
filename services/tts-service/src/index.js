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
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel
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

async function handleSynthesize(call) {
  const { call_id, text, voice_id, model } = call.request;
  const client = getClient();

  if (!client) {
    logger.error('ElevenLabs client not configured');
    call.end();
    return;
  }

  const selectedVoice = voice_id || DEFAULT_VOICE_ID;
  const selectedModel = model || DEFAULT_MODEL;

  logger.info({ call_id, textLength: text.length, voice: selectedVoice }, 'Synthesizing speech');

  try {
    const audioStream = await client.textToSpeech.convertAsStream(selectedVoice, {
      text,
      model_id: selectedModel,
      output_format: 'pcm_16000', // 16kHz PCM for Zoom compatibility
    });

    for await (const chunk of audioStream) {
      call.write({
        call_id,
        audio_data: chunk,
        sample_rate: 16000,
        encoding: 'LINEAR16',
        is_final: false,
      });
    }

    // Signal end of stream
    call.write({
      call_id,
      audio_data: Buffer.alloc(0),
      sample_rate: 16000,
      encoding: 'LINEAR16',
      is_final: true,
    });
  } catch (err) {
    logger.error({ err, call_id }, 'TTS synthesis failed');
  }

  call.end();
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
    if (err) throw err;
    logger.info(`TTS service gRPC listening on :${port}`);
    logger.info(`Voice: ${DEFAULT_VOICE_ID}, Model: ${DEFAULT_MODEL}`);
    logger.info(`API key configured: ${ELEVENLABS_API_KEY ? 'yes' : 'NO'}`);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start tts-service');
  process.exit(1);
});
