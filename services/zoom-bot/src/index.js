import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ─── gRPC clients ───

function loadProto(filename) {
  const packageDef = protoLoader.loadSync(resolve(PROTO_DIR, filename), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(packageDef);
}

const orchestratorProto = loadProto('orchestrator.proto');
const sttProto = loadProto('stt.proto');

const orchestratorClient = new orchestratorProto.scopio.orchestrator.Orchestrator(
  process.env.ORCHESTRATOR_GRPC_ADDR || 'localhost:50051',
  grpc.credentials.createInsecure(),
);

const sttClient = new sttProto.scopio.stt.STT(
  process.env.STT_GRPC_ADDR || 'localhost:50056',
  grpc.credentials.createInsecure(),
);

// ─── Zoom Meeting SDK integration ───
// NOTE: The Zoom Meeting SDK for Linux (headless) requires native binaries.
// This module provides the integration scaffold; the actual SDK init
// depends on the Zoom SDK package being available in the container.

class ZoomBot {
  constructor(callId) {
    this.callId = callId;
    this.isJoined = false;
    this.sttStream = null;
  }

  async join(meetingId, password) {
    logger.info({ meetingId, callId: this.callId }, 'Joining Zoom meeting');

    // TODO: Initialize Zoom Meeting SDK
    // - ZoomSDK.InitSDK(config)
    // - ZoomSDK.CreateMeetingService()
    // - meetingService.JoinMeeting({ meetingNumber, password, userName: 'Scopio Demo Agent' })

    this.isJoined = true;
    this.startAudioCapture();

    // Notify orchestrator that we've joined
    // In production, this fires when the Zoom SDK emits the 'joined' event
    logger.info({ callId: this.callId }, 'Zoom meeting joined (stub)');
  }

  startAudioCapture() {
    // Open a bidirectional gRPC stream to the STT service
    this.sttStream = sttClient.streamAudio();

    this.sttStream.on('data', (transcription) => {
      // Forward transcription to orchestrator
      orchestratorClient.onTranscription(
        {
          call_id: this.callId,
          text: transcription.text,
          is_final: transcription.is_final,
          confidence: transcription.confidence,
          timestamp_ms: Date.now(),
        },
        (err, action) => {
          if (err) {
            logger.error({ err }, 'Orchestrator transcription handling failed');
            return;
          }

          // If orchestrator returns response text, synthesize and play it
          if (action.response_text) {
            this.playTTSResponse(action.response_text);
          }
        },
      );
    });

    this.sttStream.on('error', (err) => {
      logger.error({ err }, 'STT stream error');
    });

    // TODO: Hook into Zoom audio raw data callback
    // ZoomSDK.GetAudioRawDataChannel().onAudioRawDataReceived = (data) => {
    //   this.sttStream.write({
    //     call_id: this.callId,
    //     audio_data: data.buffer,
    //     sample_rate: 16000,
    //     encoding: 'LINEAR16',
    //   });
    // };

    logger.info({ callId: this.callId }, 'Audio capture started (stub)');
  }

  async playTTSResponse(text) {
    // TODO: Call TTS service via gRPC, pipe audio chunks to Zoom
    // const ttsStream = ttsClient.synthesize({ call_id: this.callId, text, voice_id, model });
    // ttsStream.on('data', (chunk) => {
    //   ZoomSDK.GetAudioRawDataSender().send(chunk.audio_data);
    // });
    logger.info({ callId: this.callId, textLength: text.length }, 'Playing TTS response (stub)');
  }

  async startScreenShare() {
    // TODO: Share Xvfb display via Zoom screen share API
    // ZoomSDK.GetMeetingShareController().StartAppShare(displayId)
    logger.info({ callId: this.callId }, 'Screen share started (stub)');
  }

  async leave() {
    if (this.sttStream) {
      this.sttStream.end();
    }
    // TODO: ZoomSDK.GetMeetingService().Leave()
    this.isJoined = false;
    logger.info({ callId: this.callId }, 'Left Zoom meeting (stub)');
  }
}

// ─── Main ───

async function main() {
  const meetingId = process.env.ZOOM_MEETING_ID;
  const password = process.env.ZOOM_MEETING_PASSWORD;

  if (!meetingId) {
    logger.warn('No ZOOM_MEETING_ID set — running in standby mode');
    logger.info('Zoom bot standing by. Set ZOOM_MEETING_ID to join a call.');

    // Keep process alive
    setInterval(() => {}, 30000);
    return;
  }

  const bot = new ZoomBot(`zoom-${meetingId}`);
  await bot.join(meetingId, password);
  await bot.startScreenShare();

  // Graceful shutdown
  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, leaving meeting');
    await bot.leave();
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start zoom-bot');
  process.exit(1);
});
