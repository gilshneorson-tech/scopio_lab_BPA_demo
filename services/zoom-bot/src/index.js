import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { createConnection } from 'net';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { getZoomToken } from './zoom-auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ─── Config ───

const AUDIO_INPUT_FILE = process.env.AUDIO_INPUT_FILE || '';
const AUDIO_OUTPUT_DIR = process.env.AUDIO_OUTPUT_DIR || '/tmp/scopio_audio';
const AUDIO_OUTPUT_MODE = process.env.AUDIO_OUTPUT || 'file';
const CHUNK_SIZE = 3200; // 100ms of 16kHz 16-bit mono PCM
const CHUNK_INTERVAL_MS = 100;

// Zoom SDK paths
const SDK_BUILD_DIR = process.env.SDK_BUILD_DIR || '/opt/zoom-sdk/build';
const SDK_AUDIO_DIR = '/tmp/zoom-audio';

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

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function saveAudioToFile(callId, audioChunks, timestamp) {
  ensureDir(AUDIO_OUTPUT_DIR);
  const filename = `${AUDIO_OUTPUT_DIR}/${callId}_response_${timestamp}.pcm`;
  const combined = Buffer.concat(audioChunks);
  writeFileSync(filename, combined);
  logger.info({ filename, bytes: combined.length }, 'TTS audio saved');
  return filename;
}

function playAudioToZoom(audioChunks) {
  // Write TTS audio to a file that the Zoom SDK can play
  ensureDir(SDK_AUDIO_DIR);
  const filename = `${SDK_AUDIO_DIR}/tts-output.pcm`;
  const combined = Buffer.concat(audioChunks);
  writeFileSync(filename, combined);
  logger.info({ filename, bytes: combined.length }, 'TTS audio written for Zoom playback');
  return filename;
}

function playAudioLocal(filename) {
  try {
    const wavFile = filename.replace('.pcm', '.wav');
    execSync(
      `ffmpeg -y -f s16le -ar 16000 -ac 1 -i "${filename}" "${wavFile}" 2>/dev/null`,
      { stdio: 'pipe' },
    );
    execSync(`afplay "${wavFile}" &`, { stdio: 'pipe' });
    logger.info({ wavFile }, 'Playing audio locally');
  } catch (err) {
    logger.warn({ err: err.message }, 'Local audio playback failed');
  }
}

// ─── TTS ───

function synthesizeAndPlay(callId, text, tracker) {
  return new Promise((resolvePromise) => {
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
        }
        audioChunks.push(Buffer.from(response.audio_data));
      }
    });

    stream.on('end', () => {
      tracker.mark('tts_done');

      if (audioChunks.length > 0) {
        const timestamp = Date.now();
        const filename = saveAudioToFile(callId, audioChunks, timestamp);

        // Write for Zoom SDK to play into the meeting
        if (process.env.ZOOM_MEETING_ID) {
          playAudioToZoom(audioChunks);
        }

        if (AUDIO_OUTPUT_MODE === 'play') {
          playAudioLocal(filename);
        }
      }

      const latency = tracker.report();
      logger.info({ callId, latency }, 'Voice loop complete');
      resolvePromise(latency);
    });

    stream.on('error', (err) => {
      logger.error({ err, callId }, 'TTS stream error');
      resolvePromise(null);
    });
  });
}

// ─── Voice loop: audio → STT → Orchestrator → TTS ───

function runVoiceLoop(callId, audioBuffer) {
  return new Promise((resolveLoop) => {
    const tracker = new LatencyTracker(callId);
    const sttStream = sttClient.streamAudio();
    let resolved = false;

    sttStream.on('data', (transcription) => {
      if (!transcription.is_final || !transcription.text.trim()) return;

      tracker.mark('stt_done');
      logger.info(
        { callId, text: transcription.text, confidence: transcription.confidence },
        'STT transcription (final)',
      );

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

    // Stream audio to STT
    tracker.mark('audio_sent');

    let offset = 0;
    const interval = setInterval(() => {
      if (offset >= audioBuffer.length) {
        clearInterval(interval);
        setTimeout(() => sttStream.end(), 500);
        return;
      }
      const end = Math.min(offset + CHUNK_SIZE, audioBuffer.length);
      sttStream.write({
        call_id: callId,
        audio_data: audioBuffer.slice(offset, end),
        sample_rate: 16000,
        encoding: 'LINEAR16',
      });
      offset = end;
    }, CHUNK_INTERVAL_MS);

    setTimeout(() => {
      if (!resolved) {
        logger.warn({ callId }, 'Voice loop timed out');
        resolved = true;
        resolveLoop(null);
      }
    }, 30000);
  });
}

// ─── Zoom SDK Mode ───

class ZoomSDKBot {
  constructor(callId) {
    this.callId = callId;
    this.process = null;
    this.socketClient = null;
    this.sttStream = null;
    this.isSpeaking = false; // true when TTS is playing, suppress STT
  }

  async start(meetingId, password) {
    const sdkBinary = `${SDK_BUILD_DIR}/zoomsdk`;

    if (!existsSync(sdkBinary)) {
      logger.error({ sdkBinary }, 'Zoom SDK binary not found. Build it first.');
      return false;
    }

    ensureDir(SDK_AUDIO_DIR);
    ensureDir(resolve(process.cwd(), 'out'));

    // Write SDK config — use transcribe mode for socket streaming
    const configPath = '/tmp/zoom-config.toml';
    const joinUrl = `https://zoom.us/j/${meetingId}${password ? `?pwd=${password}` : ''}`;
    const config = `client-id="${process.env.ZOOM_CLIENT_ID || ''}"
client-secret="${process.env.ZOOM_CLIENT_SECRET || ''}"
join-url="${joinUrl}"
display-name="Scopio Demo Agent"

[RawAudio]
file="meeting-audio.pcm"
`;
    writeFileSync(configPath, config);

    logger.info({ meetingId, joinUrl, callId: this.callId }, 'Starting Zoom SDK bot');

    // Spawn the C++ SDK process (file mode — socket mode crashes in SDK 7.0)
    this.process = spawn(sdkBinary, [
      '--config', configPath,
      'RawAudio',
    ], {
      env: {
        ...process.env,
        DISPLAY: ':99',
        LD_LIBRARY_PATH: '/opt/zoom-sdk/lib/zoomsdk',
        QT_LOGGING_RULES: '*.debug=false;*.warning=false',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.process.stdout.on('data', (data) => {
      const msg = data.toString().trim();
      logger.info({ sdk: msg }, 'SDK stdout');

      // Once connected and recording, start STT stream
      if (msg.includes('subscribe to raw audio') || msg.includes('start raw recording')) {
        setTimeout(() => this.openSTTStream(), 1000);
      }
    });

    this.process.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      // Only log non-ALSA errors to reduce noise
      if (!msg.includes('ALSA lib')) {
        logger.info({ sdk: msg }, 'SDK stderr');
      }
    });

    this.process.on('exit', (code, signal) => {
      logger.info({ code, signal, callId: this.callId }, 'Zoom SDK process exited');
    });

    // Also start file-based watcher as fallback (socket may not be available)
    this.startFileWatcher();

    return true;
  }

  connectAudioSocket() {
    const SOCKET_PATH = '/tmp/meeting.sock';

    if (!existsSync(SOCKET_PATH)) {
      logger.warn('Socket not found yet, retrying in 2s...');
      setTimeout(() => this.connectAudioSocket(), 2000);
      return;
    }

    logger.info({ path: SOCKET_PATH }, 'Connecting to SDK audio socket');

    this.socketClient = createConnection(SOCKET_PATH);
    let audioBuffer = Buffer.alloc(0);

    this.socketClient.on('connect', () => {
      logger.info('Connected to SDK audio socket — streaming to STT');
      this.openSTTStream();
    });

    this.socketClient.on('data', (data) => {
      if (this.isSpeaking) return; // Don't transcribe our own TTS output

      audioBuffer = Buffer.concat([audioBuffer, data]);

      // Send complete chunks to STT
      while (audioBuffer.length >= CHUNK_SIZE) {
        const chunk = audioBuffer.slice(0, CHUNK_SIZE);
        audioBuffer = audioBuffer.slice(CHUNK_SIZE);

        if (this.sttStream) {
          this.sttStream.write({
            call_id: this.callId,
            audio_data: chunk,
            sample_rate: 16000,
            encoding: 'LINEAR16',
          });
        }
      }
    });

    this.socketClient.on('error', (err) => {
      logger.warn({ err: err.message }, 'Audio socket error, falling back to file watcher');
    });

    this.socketClient.on('close', () => {
      logger.info('Audio socket closed');
    });
  }

  openSTTStream() {
    if (this.sttStream) return;

    this.sttStream = sttClient.streamAudio();

    this.sttStream.on('data', (transcription) => {
      if (!transcription.is_final || !transcription.text.trim()) return;
      if (this.isSpeaking) return; // Ignore transcriptions while we're speaking

      const text = transcription.text;
      logger.info({ callId: this.callId, text, confidence: transcription.confidence }, 'Zoom STT transcription');

      // Forward to orchestrator
      const t_start = Date.now();
      orchestratorClient.onTranscription(
        {
          call_id: this.callId,
          text,
          is_final: true,
          confidence: transcription.confidence,
          timestamp_ms: Date.now(),
        },
        async (err, action) => {
          if (err) {
            logger.error({ err }, 'Orchestrator error');
            return;
          }

          const claude_ms = Date.now() - t_start;
          logger.info(
            { callId: this.callId, action: action.type, claude_ms },
            'Orchestrator decision',
          );

          if (action.response_text) {
            await this.speakResponse(action.response_text);
          }
        },
      );
    });

    this.sttStream.on('error', (err) => {
      logger.error({ err: err.message }, 'STT stream error — reopening');
      this.sttStream = null;
      // Reopen after a short delay
      setTimeout(() => this.openSTTStream(), 1000);
    });

    this.sttStream.on('end', () => {
      logger.info('STT stream ended — reopening');
      this.sttStream = null;
      setTimeout(() => this.openSTTStream(), 1000);
    });
  }

  async speakResponse(text) {
    this.isSpeaking = true;
    const tracker = new LatencyTracker(this.callId);
    tracker.mark('claude_done');

    logger.info({ callId: this.callId, textLength: text.length }, 'Synthesizing TTS for Zoom');

    const audioChunks = [];
    let firstChunkReceived = false;

    await new Promise((resolveSpeak) => {
      const stream = ttsClient.synthesize({
        call_id: this.callId,
        text,
        voice_id: process.env.ELEVENLABS_VOICE_ID || 'XrExE9yKIg1WjnnlVkGX',
        model: process.env.TTS_MODEL || 'eleven_turbo_v2',
      });

      stream.on('data', (response) => {
        if (response.audio_data && response.audio_data.length > 0) {
          if (!firstChunkReceived) {
            tracker.mark('tts_first_chunk');
            firstChunkReceived = true;
          }
          audioChunks.push(Buffer.from(response.audio_data));
        }
      });

      stream.on('end', () => {
        tracker.mark('tts_done');

        if (audioChunks.length > 0) {
          // Save audio file
          const combined = Buffer.concat(audioChunks);
          const pcmFile = `${AUDIO_OUTPUT_DIR}/${this.callId}_response_${Date.now()}.pcm`;
          ensureDir(AUDIO_OUTPUT_DIR);
          writeFileSync(pcmFile, combined);

          // Play into Zoom via PulseAudio
          try {
            logger.info({ bytes: combined.length, pcmFile }, 'Playing TTS into Zoom via PulseAudio');
            execSync(
              `paplay --raw --rate=16000 --channels=1 --format=s16le "${pcmFile}"`,
              { stdio: 'pipe', timeout: 30000 },
            );
            logger.info('TTS playback complete');
          } catch (err) {
            logger.error({ err: err.message }, 'PulseAudio playback failed');
          }
        }

        const latency = tracker.report();
        logger.info({ callId: this.callId, latency }, 'Voice loop complete');

        this.isSpeaking = false;
        resolveSpeak();
      });

      stream.on('error', (err) => {
        logger.error({ err, callId: this.callId }, 'TTS stream error');
        this.isSpeaking = false;
        resolveSpeak();
      });
    });
  }

  startFileWatcher() {
    // Poll the audio file for new data and stream to STT
    const audioFile = resolve(process.cwd(), 'out/meeting-audio.pcm');
    let lastSize = 0;

    this.fileWatcher = setInterval(() => {
      if (!existsSync(audioFile)) return;
      if (this.isSpeaking) return; // Don't transcribe during TTS playback

      try {
        const buffer = readFileSync(audioFile);
        if (buffer.length > lastSize) {
          const newData = buffer.slice(lastSize);
          lastSize = buffer.length;

          if (!this.sttStream) this.openSTTStream();

          for (let i = 0; i < newData.length; i += CHUNK_SIZE) {
            const chunk = newData.slice(i, Math.min(i + CHUNK_SIZE, newData.length));
            if (this.sttStream) {
              this.sttStream.write({
                call_id: this.callId,
                audio_data: chunk,
                sample_rate: 16000,
                encoding: 'LINEAR16',
              });
            }
          }
        }
      } catch { /* file locked by SDK */ }
    }, 100); // Poll every 100ms for better responsiveness
  }

  stop() {
    if (this.fileWatcher) clearInterval(this.fileWatcher);
    if (this.socketClient) this.socketClient.destroy();
    if (this.sttStream) this.sttStream.end();
    if (this.process) this.process.kill('SIGTERM');
    logger.info({ callId: this.callId }, 'Zoom SDK bot stopped');
  }
}

// ─── Main ───

async function main() {
  // Mode 1: Audio file input (testing without Zoom)
  if (AUDIO_INPUT_FILE) {
    if (!existsSync(AUDIO_INPUT_FILE)) {
      logger.error({ file: AUDIO_INPUT_FILE }, 'Audio input file not found');
      process.exit(1);
    }

    logger.info({ file: AUDIO_INPUT_FILE }, 'Running in audio file mode');
    const audioBuffer = readFileSync(AUDIO_INPUT_FILE);
    logger.info({ bytes: audioBuffer.length, duration_sec: (audioBuffer.length / 32000).toFixed(1) }, 'Audio loaded');

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

  // Mode 2: Zoom SDK (real meeting)
  const meetingId = process.env.ZOOM_MEETING_ID;

  if (meetingId) {
    logger.info({ meetingId }, 'Starting in Zoom SDK mode');

    // Meeting SDK handles auth internally via JWT from Client ID + Secret
    // No OAuth token needed — the C++ binary generates its own JWT
    if (!process.env.ZOOM_CLIENT_ID || !process.env.ZOOM_CLIENT_SECRET) {
      logger.error('ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET required for SDK mode');
      process.exit(1);
    }

    // Create orchestrator session
    orchestratorClient.startSession(
      {
        zoom_meeting_id: meetingId,
        zoom_meeting_password: process.env.ZOOM_MEETING_PASSWORD || '',
        prospect_name: process.env.PROSPECT_NAME || 'Zoom Prospect',
      },
      async (err, session) => {
        if (err) {
          logger.error({ err }, 'Failed to create session');
          process.exit(1);
        }

        const callId = session.call_id;
        logger.info({ callId, meetingId }, 'Session created, starting Zoom SDK bot');

        const bot = new ZoomSDKBot(callId);
        const started = await bot.start(meetingId, process.env.ZOOM_MEETING_PASSWORD);

        if (!started) {
          logger.error('Failed to start Zoom SDK bot');
          process.exit(1);
        }

        // Graceful shutdown
        const shutdown = () => {
          logger.info('Shutting down...');
          bot.stop();
          orchestratorClient.endSession({ call_id: callId }, () => {});
          setTimeout(() => process.exit(0), 2000);
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
      },
    );
    return;
  }

  // Mode 3: Standby
  logger.warn('No ZOOM_MEETING_ID or AUDIO_INPUT_FILE set');
  logger.info('Usage:');
  logger.info('  Audio test: AUDIO_INPUT_FILE=test.pcm node src/index.js');
  logger.info('  Zoom mode:  ZOOM_MEETING_ID=123 node src/index.js');
  logger.info('Standing by...');
  setInterval(() => {}, 30000);

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  logger.error(err, 'Failed to start zoom-bot');
  process.exit(1);
});
