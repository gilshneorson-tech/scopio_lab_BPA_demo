import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ─── Config ───

const AUDIO_INPUT_FILE = process.env.AUDIO_INPUT_FILE || '';
const AUDIO_OUTPUT_DIR = process.env.AUDIO_OUTPUT_DIR || '/tmp/scopio_audio';
const AUDIO_OUTPUT_MODE = process.env.AUDIO_OUTPUT || 'file'; // 'file' or 'play'
const CHUNK_SIZE = 3200; // 100ms of 16kHz 16-bit mono PCM
const CHUNK_INTERVAL_MS = 100;

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
const ttsProto = loadProto('tts.proto');

const orchestratorClient = new orchestratorProto.scopio.orchestrator.Orchestrator(
  process.env.ORCHESTRATOR_GRPC_ADDR || 'localhost:50051',
  grpc.credentials.createInsecure(),
);

const sttClient = new sttProto.scopio.stt.STT(
  process.env.STT_GRPC_ADDR || 'localhost:50056',
  grpc.credentials.createInsecure(),
);

const ttsClient = new ttsProto.scopio.tts.TTS(
  process.env.TTS_GRPC_ADDR || 'localhost:50054',
  grpc.credentials.createInsecure(),
);

// ─── Latency tracking ───

class LatencyTracker {
  constructor(callId) {
    this.callId = callId;
    this.marks = {};
  }

  mark(name) {
    this.marks[name] = Date.now();
  }

  report() {
    const m = this.marks;
    const stt = m.stt_done && m.audio_sent ? m.stt_done - m.audio_sent : null;
    const claude = m.claude_done && m.stt_done ? m.claude_done - m.stt_done : null;
    const tts_first = m.tts_first_chunk && m.claude_done ? m.tts_first_chunk - m.claude_done : null;
    const tts_total = m.tts_done && m.claude_done ? m.tts_done - m.claude_done : null;
    const e2e = m.tts_first_chunk && m.audio_sent ? m.tts_first_chunk - m.audio_sent : null;

    return {
      stt_ms: stt,
      claude_ms: claude,
      tts_first_chunk_ms: tts_first,
      tts_total_ms: tts_total,
      e2e_to_first_audio_ms: e2e,
    };
  }
}

// ─── Audio output ───

function ensureOutputDir() {
  try {
    execSync(`mkdir -p "${AUDIO_OUTPUT_DIR}"`);
  } catch { /* ignore */ }
}

function saveAudioToFile(callId, audioChunks, timestamp) {
  ensureOutputDir();
  const filename = `${AUDIO_OUTPUT_DIR}/${callId}_response_${timestamp}.pcm`;
  const combined = Buffer.concat(audioChunks);
  writeFileSync(filename, combined);
  logger.info({ filename, bytes: combined.length }, 'TTS audio saved');
  return filename;
}

function playAudio(filename) {
  try {
    // Convert PCM to WAV for playback
    const wavFile = filename.replace('.pcm', '.wav');
    // SOX or ffmpeg: 16kHz, 16-bit, mono PCM → WAV
    execSync(
      `ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${filename}" "${wavFile}" 2>/dev/null`,
      { stdio: 'pipe' },
    );
    // Play on macOS
    execSync(`afplay "${wavFile}" &`, { stdio: 'pipe' });
    logger.info({ wavFile }, 'Playing audio');
  } catch (err) {
    logger.warn({ err: err.message }, 'Audio playback failed (ffmpeg or afplay not available)');
  }
}

// ─── TTS ───

function synthesizeAndPlay(callId, text, tracker) {
  return new Promise((resolve) => {
    const audioChunks = [];
    let firstChunkReceived = false;

    const stream = ttsClient.synthesize({
      call_id: callId,
      text,
      voice_id: process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM',
      model: process.env.TTS_MODEL || 'eleven_turbo_v2',
    });

    stream.on('data', (response) => {
      if (response.audio_data && response.audio_data.length > 0) {
        if (!firstChunkReceived) {
          tracker.mark('tts_first_chunk');
          firstChunkReceived = true;
          logger.info({ callId }, 'TTS first audio chunk received');
        }
        audioChunks.push(Buffer.from(response.audio_data));

        // In Zoom mode: ZoomSDK.GetAudioRawDataSender().send(response.audio_data)
      }
    });

    stream.on('end', () => {
      tracker.mark('tts_done');
      const timestamp = Date.now();

      if (audioChunks.length > 0) {
        const filename = saveAudioToFile(callId, audioChunks, timestamp);

        if (AUDIO_OUTPUT_MODE === 'play') {
          playAudio(filename);
        }
      }

      const latency = tracker.report();
      logger.info({ callId, latency }, 'Voice loop complete');
      resolve(latency);
    });

    stream.on('error', (err) => {
      logger.error({ err, callId }, 'TTS stream error');
      resolve(null);
    });
  });
}

// ─── Voice loop: STT → Orchestrator → TTS ───

function runVoiceLoop(callId, audioBuffer) {
  return new Promise((resolveLoop) => {
    const tracker = new LatencyTracker(callId);

    // Open bidirectional STT stream
    const sttStream = sttClient.streamAudio();
    let resolved = false;

    sttStream.on('data', (transcription) => {
      if (!transcription.is_final || !transcription.text.trim()) return;

      tracker.mark('stt_done');
      logger.info(
        { callId, text: transcription.text, confidence: transcription.confidence },
        'STT transcription (final)',
      );

      // Forward to orchestrator
      orchestratorClient.onTranscription(
        {
          call_id: callId,
          text: transcription.text,
          is_final: true,
          confidence: transcription.confidence,
          timestamp_ms: Date.now(),
        },
        async (err, action) => {
          if (err) {
            logger.error({ err }, 'Orchestrator error');
            if (!resolved) { resolved = true; resolveLoop(null); }
            return;
          }

          tracker.mark('claude_done');
          logger.info(
            { callId, action: action.type, responseLength: action.response_text?.length },
            'Orchestrator decision',
          );

          // Synthesize and play TTS
          if (action.response_text) {
            const latency = await synthesizeAndPlay(callId, action.response_text, tracker);
            if (!resolved) { resolved = true; resolveLoop(latency); }
          } else {
            if (!resolved) { resolved = true; resolveLoop(tracker.report()); }
          }
        },
      );
    });

    sttStream.on('error', (err) => {
      logger.error({ err }, 'STT stream error');
      if (!resolved) { resolved = true; resolveLoop(null); }
    });

    sttStream.on('end', () => {
      logger.info({ callId }, 'STT stream ended');
    });

    // Stream audio chunks to STT
    tracker.mark('audio_sent');

    if (audioBuffer) {
      // Stream from buffer in realistic chunks
      let offset = 0;
      const interval = setInterval(() => {
        if (offset >= audioBuffer.length) {
          clearInterval(interval);
          // Small delay then end stream
          setTimeout(() => sttStream.end(), 500);
          return;
        }
        const end = Math.min(offset + CHUNK_SIZE, audioBuffer.length);
        const chunk = audioBuffer.slice(offset, end);

        sttStream.write({
          call_id: callId,
          audio_data: chunk,
          sample_rate: 16000,
          encoding: 'LINEAR16',
        });

        offset = end;
      }, CHUNK_INTERVAL_MS);
    }

    // Timeout after 30s
    setTimeout(() => {
      if (!resolved) {
        logger.warn({ callId }, 'Voice loop timed out');
        resolved = true;
        resolveLoop(null);
      }
    }, 30000);
  });
}

// ─── Main ───

async function main() {
  // Audio file input mode — for testing without Zoom
  if (AUDIO_INPUT_FILE) {
    if (!existsSync(AUDIO_INPUT_FILE)) {
      logger.error({ file: AUDIO_INPUT_FILE }, 'Audio input file not found');
      process.exit(1);
    }

    logger.info({ file: AUDIO_INPUT_FILE }, 'Running in audio file mode');

    // Read raw PCM audio (16kHz, 16-bit, mono)
    const audioBuffer = readFileSync(AUDIO_INPUT_FILE);
    logger.info({ bytes: audioBuffer.length, duration_sec: (audioBuffer.length / 32000).toFixed(1) }, 'Audio loaded');

    // Create a session first
    orchestratorClient.startSession(
      { zoom_meeting_id: 'test-audio', prospect_name: 'Audio Test' },
      async (err, session) => {
        if (err) {
          logger.error({ err }, 'Failed to create session');
          process.exit(1);
        }

        const callId = session.call_id;
        logger.info({ callId }, 'Session created, running voice loop');

        const latency = await runVoiceLoop(callId, audioBuffer);

        if (latency) {
          console.log('\n═══════════════════════════════════════');
          console.log('  Voice Loop Latency Report');
          console.log('═══════════════════════════════════════');
          console.log(`  STT:              ${latency.stt_ms ?? 'N/A'}ms`);
          console.log(`  Claude:           ${latency.claude_ms ?? 'N/A'}ms`);
          console.log(`  TTS first chunk:  ${latency.tts_first_chunk_ms ?? 'N/A'}ms`);
          console.log(`  TTS total:        ${latency.tts_total_ms ?? 'N/A'}ms`);
          console.log(`  E2E (to audio):   ${latency.e2e_to_first_audio_ms ?? 'N/A'}ms`);
          console.log('═══════════════════════════════════════\n');
        } else {
          console.log('\nVoice loop failed — check service logs\n');
        }

        process.exit(0);
      },
    );
    return;
  }

  // Zoom SDK mode (stub — waiting for SDK approval)
  const meetingId = process.env.ZOOM_MEETING_ID;

  if (!meetingId) {
    logger.warn('No ZOOM_MEETING_ID or AUDIO_INPUT_FILE set');
    logger.info('Usage:');
    logger.info('  Audio test: AUDIO_INPUT_FILE=test.pcm node src/index.js');
    logger.info('  Zoom mode:  ZOOM_MEETING_ID=123 node src/index.js');
    logger.info('Standing by...');
    setInterval(() => {}, 30000);
    return;
  }

  // TODO: Zoom SDK integration (Phase 3)
  // - ZoomSDK.InitSDK(config)
  // - ZoomSDK.CreateMeetingService()
  // - meetingService.JoinMeeting(...)
  // - Audio capture → runVoiceLoop()
  // - Screen share via Xvfb

  logger.info({ meetingId }, 'Zoom SDK mode not yet implemented — use AUDIO_INPUT_FILE for testing');
  setInterval(() => {}, 30000);

  process.on('SIGTERM', () => {
    logger.info('SIGTERM received');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error(err, 'Failed to start zoom-bot');
  process.exit(1);
});
