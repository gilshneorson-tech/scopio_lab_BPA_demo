import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, openSync, readSync, closeSync, unlinkSync, chmodSync } from 'fs';
import { execSync, spawn } from 'child_process';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { chromium } from 'playwright';
import { createServer } from 'http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROTO_DIR = resolve(__dirname, '../../../proto');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

// ─── Config ───

const AUDIO_INPUT_FILE = process.env.AUDIO_INPUT_FILE || '';
const AUDIO_OUTPUT_DIR = process.env.AUDIO_OUTPUT_DIR || '/tmp/scopio_audio';
const AUDIO_OUTPUT_MODE = process.env.AUDIO_OUTPUT || 'file';
const CHUNK_SIZE_16K = 3200; // 100ms of 16kHz 16-bit mono PCM (for test audio files)
const CHUNK_SIZE_32K = 6400; // 100ms of 32kHz 16-bit mono PCM (Zoom SDK output)
const CHUNK_INTERVAL_MS = 100;

// Zoom SDK paths
const SDK_BUILD_DIR = process.env.SDK_BUILD_DIR || '/opt/zoom-sdk/build';
const SDK_AUDIO_DIR = process.env.TTS_AUDIO_DIR || '/tmp/zoom-audio';
const TTS_OUTPUT_FILE = `${SDK_AUDIO_DIR}/tts-output.pcm`;
const TTS_STOP_FILE = `${SDK_AUDIO_DIR}/tts-control.stop`;

// One voice per language, shared by every speech path (test loop + live Q&A)
const VOICE_IDS = {
  en: 'XrExE9yKIg1WjnnlVkGX', // Matilda
  fr: 'xNtG3W2oqJs0cJZuTyBc', // Chloé
};
const VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID ||
  VOICE_IDS[process.env.DEMO_LANGUAGE] ||
  VOICE_IDS.en;

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
const browserProto = loadProto('browser.proto');

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

function safeUnlink(path) {
  try { unlinkSync(path); } catch { /* absent */ }
}

function saveAudioToFile(callId, audioChunks, timestamp) {
  ensureDir(AUDIO_OUTPUT_DIR);
  const filename = `${AUDIO_OUTPUT_DIR}/${callId}_response_${timestamp}.pcm`;
  const combined = Buffer.concat(audioChunks);
  writeFileSync(filename, combined);
  logger.info({ filename, bytes: combined.length }, 'TTS audio saved');
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

// ─── Speech player: single writer for the virtual-mic file ───
//
// Everything the bot says (auto-demo narration via the PlayAudio RPC, Q&A
// answers via speakResponse) is serialized through this queue. That removes
// the two-writers-truncating-each-other race on tts-output.pcm and gives an
// authoritative isSpeaking window for echo suppression.
//
// StopAudio drops the queue and writes a stop-sentinel file the C++ send loop
// checks per 20ms chunk, so an interrupt actually cuts playback instead of
// letting up to 30s of already-written narration keep talking.

class SpeechPlayer {
  constructor() {
    this.queue = Promise.resolve();
    this.speaking = false;
    this.currentStop = null; // resolve-early hook for the playing utterance
    this.stopped = false;
  }

  get isSpeaking() {
    return this.speaking;
  }

  /** Queue a PCM buffer for playback. Resolves when playback (estimate) ends. */
  enqueue(pcmBuffer, sampleRate = 16000) {
    const durationMs = Math.ceil((pcmBuffer.length / 2) / sampleRate * 1000);
    const play = () =>
      new Promise((resolvePlay) => {
        if (this.stopped) return resolvePlay({ stopped: true, durationMs });
        try {
          ensureDir(SDK_AUDIO_DIR);
          safeUnlink(TTS_STOP_FILE); // never let a stale stop kill this utterance
          writeFileSync(TTS_OUTPUT_FILE, pcmBuffer);
        } catch (err) {
          logger.warn({ err: err.message }, 'Failed to write TTS file for virtual mic');
          return resolvePlay({ stopped: false, durationMs, error: err.message });
        }
        this.speaking = true;

        let finished = false;
        const finish = (wasStopped) => {
          if (finished) return;
          finished = true;
          this.speaking = false;
          this.currentStop = null;
          clearTimeout(timer);
          resolvePlay({ stopped: wasStopped, durationMs });
        };
        const timer = setTimeout(() => finish(false), durationMs + 500);
        this.currentStop = () => finish(true);
      });

    const result = this.queue.then(play);
    // keep the chain alive even if a playback errors
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  /** Cut current playback and drop the queue (prospect interrupted). */
  stopAll() {
    try {
      ensureDir(SDK_AUDIO_DIR);
      writeFileSync(TTS_STOP_FILE, 'stop'); // C++ send loop aborts + truncates
    } catch (err) {
      logger.warn({ err: err.message }, 'Failed to write TTS stop file');
    }
    // Queued-but-not-started utterances see this flag and resolve immediately
    this.stopped = true;
    const clearFlag = () => { this.stopped = false; };
    this.queue = this.queue.then(clearFlag, clearFlag);
    if (this.currentStop) this.currentStop();
  }

  /** Remove stale audio from previous runs so it is never replayed on join. */
  static cleanSlate() {
    ensureDir(SDK_AUDIO_DIR);
    try { writeFileSync(TTS_OUTPUT_FILE, Buffer.alloc(0)); } catch { /* ignore */ }
    safeUnlink(TTS_STOP_FILE);
  }
}

const speechPlayer = new SpeechPlayer();

// ─── TTS ───

function synthesize(callId, text, tracker) {
  return new Promise((resolvePromise) => {
    const audioChunks = [];
    let firstChunkReceived = false;

    const stream = ttsClient.synthesize(
      {
        call_id: callId,
        text,
        voice_id: VOICE_ID,
        model: process.env.TTS_MODEL || 'eleven_turbo_v2',
      },
      { deadline: Date.now() + 30000 },
    );

    stream.on('data', (response) => {
      if (response.audio_data && response.audio_data.length > 0) {
        if (!firstChunkReceived) {
          if (tracker) tracker.mark('tts_first_chunk');
          firstChunkReceived = true;
        }
        audioChunks.push(Buffer.from(response.audio_data));
      }
    });

    stream.on('end', () => {
      if (tracker) tracker.mark('tts_done');
      resolvePromise({ audioChunks });
    });

    stream.on('error', (err) => {
      logger.error({ err: err.message, callId }, 'TTS stream error');
      resolvePromise({ audioChunks, error: err.message });
    });
  });
}

async function synthesizeAndPlay(callId, text, tracker) {
  const { audioChunks } = await synthesize(callId, text, tracker);

  if (audioChunks.length > 0) {
    const timestamp = Date.now();
    const filename = saveAudioToFile(callId, audioChunks, timestamp);

    // Play into the meeting via the serialized speech queue
    if (process.env.ZOOM_MEETING_ID) {
      await speechPlayer.enqueue(Buffer.concat(audioChunks));
    }

    if (AUDIO_OUTPUT_MODE === 'play') {
      playAudioLocal(filename);
    }
  }

  const latency = tracker ? tracker.report() : null;
  logger.info({ callId, latency }, 'Voice loop complete');
  return latency;
}

// ─── Voice loop: audio → STT → Orchestrator → TTS (file-test mode) ───

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
      const end = Math.min(offset + CHUNK_SIZE_16K, audioBuffer.length);
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

// ─── Demo Browser (renders on Xvfb for screen share) ───

const SECTION_HASH = {
  home: 'home', overview: 'overview', scan_viewer: 'scan',
  ndc_panel: 'ndc', quantification: 'quantification',
  remote_access: 'remote', report_export: 'report',
  integration: 'integration', summary: 'summary',
};

class DemoBrowser {
  constructor() {
    this.browser = null;
    this.page = null;
    this.server = null;
    this.bmaUrl = '';
    this.stopped = false;
    this.relaunching = false;
  }

  async start() {
    // Serve the test BMA page locally
    const htmlPath = resolve(__dirname, '../../../config/test-bma.html');
    let html = '';
    try {
      html = readFileSync(htmlPath, 'utf-8');
    } catch {
      logger.warn('test-bma.html not found, browser will show blank page');
    }

    const configDir = resolve(__dirname, '../../../config');
    const MIME_TYPES = {
      '.html': 'text/html', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript',
    };
    await new Promise((resolveListen) => {
      this.server = createServer((req, res) => {
        const urlPath = (req.url || '/').split('?')[0];
        if (urlPath === '/' || urlPath === '/index.html') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(html);
          return;
        }
        // Serve static assets (hero background image etc.) from config/
        const filePath = resolve(configDir, urlPath.replace(/^\//, ''));
        if (!filePath.startsWith(configDir)) { res.writeHead(403); res.end(); return; }
        try {
          const data = readFileSync(filePath);
          const ext = urlPath.substring(urlPath.lastIndexOf('.'));
          res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
          res.end(data);
        } catch {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      this.server.on('error', (err) => {
        // EADDRINUSE etc. must not crash the whole bot with an unhandled throw
        logger.error({ err: err.message }, 'Test BMA page server error — continuing without it');
        resolveListen();
      });
      this.server.listen(8090, () => {
        logger.info('Test BMA page served at http://localhost:8090');
        resolveListen();
      });
    });
    this.bmaUrl = 'http://localhost:8090';

    await this.launchBrowser();
  }

  async launchBrowser() {
    // Launch Chromium on Xvfb display :99 (NOT headless — visible for screen share)
    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--start-fullscreen',
        '--kiosk',
      ],
    });

    // A crashed Chromium must not freeze the screen share for the rest of the
    // demo — relaunch and get back to the page.
    this.browser.on('disconnected', () => {
      if (this.stopped || this.relaunching) return;
      this.relaunching = true;
      logger.error('Demo browser disconnected — relaunching');
      this.launchBrowser()
        .then(() => logger.info('Demo browser relaunched'))
        .catch((err) => logger.error({ err: err.message }, 'Demo browser relaunch failed'))
        .finally(() => { this.relaunching = false; });
    });

    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await context.newPage();
    await this.page.goto(this.bmaUrl);
    logger.info('Demo browser launched on Xvfb display');
  }

  async navigateToSection(section) {
    if (!this.page || this.page.isClosed()) {
      logger.warn({ section }, 'Browser page not available for navigation');
      return false;
    }
    const hash = SECTION_HASH[section] || section;
    try {
      // Try clicking the nav link first — with a short timeout so a missing
      // selector on the real BMA UI can't stall a live demo step for 30s
      const clicked = await this.page
        .click(`[data-section="${hash}"], nav a[href="#${hash}"]`, { timeout: 1000 })
        .then(() => true)
        .catch(() => false);
      if (!clicked) {
        await this.page.goto(`${this.bmaUrl}#${hash}`, { timeout: 5000 });
      }
      logger.info({ section, hash }, 'Browser navigated');
      return true;
    } catch (err) {
      logger.warn({ err: err.message, section }, 'Browser navigation failed');
      return false;
    }
  }

  async stop() {
    this.stopped = true;
    if (this.browser) await this.browser.close().catch(() => {});
    if (this.server) this.server.close();
  }
}

let demoBrowser = null;
let demoBrowserGrpcServer = null;

// gRPC surface the orchestrator drives: navigation of the screen-shared
// browser plus meeting audio playback (PlayAudio/StopAudio).
function startDemoBrowserGrpc(port = 50057) {
  const server = new grpc.Server({
    'grpc.max_receive_message_length': 32 * 1024 * 1024,
    'grpc.max_send_message_length': 32 * 1024 * 1024,
  });
  server.addService(browserProto.scopio.browser.DemoBrowser.service, {
    navigateSection: async (call, callback) => {
      const { section } = call.request;
      if (!demoBrowser || !demoBrowser.page) {
        callback(null, { success: false, message: 'DemoBrowser not started' });
        return;
      }
      try {
        const ok = await demoBrowser.navigateToSection(section);
        const url = ok ? demoBrowser.page.url() : '';
        callback(null, {
          success: ok,
          message: ok ? 'navigated' : 'navigation failed',
          current_url: url,
        });
      } catch (err) {
        logger.error({ err: err.message, section }, 'DemoBrowser gRPC nav failed');
        callback(null, { success: false, message: err.message });
      }
    },

    playAudio: async (call, callback) => {
      const { audio_data, sample_rate } = call.request;
      if (!audio_data || audio_data.length === 0) {
        return callback(null, { success: false, message: 'empty audio', duration_ms: 0, stopped: false });
      }
      try {
        const result = await speechPlayer.enqueue(Buffer.from(audio_data), sample_rate || 16000);
        callback(null, {
          success: !result.error,
          message: result.error || 'played',
          duration_ms: result.durationMs,
          stopped: !!result.stopped,
        });
      } catch (err) {
        logger.error({ err: err.message }, 'PlayAudio failed');
        callback(null, { success: false, message: err.message, duration_ms: 0, stopped: false });
      }
    },

    stopAudio: async (call, callback) => {
      speechPlayer.stopAll();
      logger.info('StopAudio — cut current playback and dropped queue');
      callback(null, { success: true, message: 'stopped', duration_ms: 0, stopped: true });
    },
  });
  server.bindAsync(
    `0.0.0.0:${port}`,
    grpc.ServerCredentials.createInsecure(),
    (err, boundPort) => {
      if (err) {
        logger.error({ err }, 'Failed to start DemoBrowser gRPC server');
        return;
      }
      logger.info({ port: boundPort }, 'DemoBrowser gRPC server started');
    },
  );
  demoBrowserGrpcServer = server;
}

// ─── Zoom SDK Mode ───

// SDK stdout markers that mean the meeting is over or unjoinable. The SDK
// binary otherwise idles forever on failure; exiting lets Docker restart the
// container cleanly instead of narrating into a dead meeting.
const MEETING_DEAD_PATTERNS = /MEETING_STATUS_FAILED|MEETING_STATUS_ENDED|meeting failed|failed to join|fail code/i;

// Keep capturing meeting audio while the bot is speaking so prospects can
// barge in mid-narration (live-tested). Set CAPTURE_DURING_PLAYBACK=false to
// fall back to hard echo suppression at the audio layer.
const CAPTURE_DURING_PLAYBACK = process.env.CAPTURE_DURING_PLAYBACK !== 'false';

class ZoomSDKBot {
  constructor(callId, { onMicReady, onMeetingDead } = {}) {
    this.callId = callId;
    this.process = null;
    this.sttStream = null;
    this.stopped = false;
    this.sttReopenTimer = null;
    this.onMicReady = onMicReady || (() => {});
    this.onMeetingDead = onMeetingDead || (() => {});
    this.micReadyFired = false;
  }

  get isSpeaking() {
    return speechPlayer.isSpeaking;
  }

  async start(meetingId, password) {
    const sdkBinary = `${SDK_BUILD_DIR}/zoomsdk`;

    if (!existsSync(sdkBinary)) {
      logger.error({ sdkBinary }, 'Zoom SDK binary not found. Build it first.');
      return false;
    }

    ensureDir(SDK_AUDIO_DIR);
    ensureDir(resolve(process.cwd(), 'out'));

    // Clean slate: stale audio from a previous run must never be replayed
    // into STT (meeting-audio.pcm) or spoken into the new meeting (tts file)
    SpeechPlayer.cleanSlate();
    const meetingAudioFile = resolve(process.cwd(), 'out/meeting-audio.pcm');
    try { writeFileSync(meetingAudioFile, Buffer.alloc(0)); } catch { /* ignore */ }

    // Write SDK config
    const configPath = '/tmp/zoom-config.toml';
    const joinUrl = `https://zoom.us/j/${meetingId}${password ? `?pwd=${encodeURIComponent(password)}` : ''}`;
    const tomlEscape = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const config = `client-id="${tomlEscape(process.env.ZOOM_CLIENT_ID)}"
client-secret="${tomlEscape(process.env.ZOOM_CLIENT_SECRET)}"
join-url="${tomlEscape(joinUrl)}"
${password ? `password="${tomlEscape(password)}"\n` : ''}display-name="Scopio Demo Agent"

[RawAudio]
file="meeting-audio.pcm"
`;
    writeFileSync(configPath, config);
    try { chmodSync(configPath, 0o600); } catch { /* ignore */ }

    logger.info({ meetingId, callId: this.callId }, 'Starting Zoom SDK bot');

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

      // Virtual mic / VoIP ready → the bot can speak; this is the auto-demo
      // trigger ("join VoIP" observed in live SDK logs as the earlier marker)
      if (!this.micReadyFired && (msg.includes('virtual mic can send') || msg.includes('join VoIP'))) {
        this.micReadyFired = true;
        this.onMicReady();
      }

      if (MEETING_DEAD_PATTERNS.test(msg)) {
        logger.error({ sdk: msg }, 'Meeting failed or ended per SDK output');
        this.onMeetingDead(`SDK reported: ${msg.slice(0, 120)}`);
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
      logger.error({ code, signal, callId: this.callId }, 'Zoom SDK process exited');
      if (!this.stopped) {
        // The bot is useless without the SDK. Exit non-zero so the container
        // restarts with a clean slate instead of idling "healthy" forever.
        this.onMeetingDead(`SDK process exited (code=${code}, signal=${signal})`);
      }
    });

    this.startFileWatcher();

    return true;
  }

  openSTTStream() {
    if (this.sttStream || this.stopped) return;

    this.sttStream = sttClient.streamAudio();

    this.sttStream.on('data', (transcription) => {
      if (!transcription.text.trim()) return;

      const text = transcription.text;

      // Interims are forwarded so the orchestrator can pause the demo
      // immediately; finals go through its full policy (filler/dedup/echo).
      // Audio captured during our own playback never reaches STT (see the
      // file watcher), and the orchestrator suppresses echoes of what we
      // said — so we no longer silently drop finals here.
      if (!transcription.is_final) {
        orchestratorClient.onTranscription(
          {
            call_id: this.callId,
            text,
            is_final: false,
            confidence: 0,
            timestamp_ms: Date.now(),
          },
          () => {}, // Fire-and-forget for interims
        );
        return;
      }

      logger.info({ callId: this.callId, text, confidence: transcription.confidence }, 'Zoom STT transcription');

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
            logger.error({ err: err.message }, 'Orchestrator error');
            return;
          }

          const claude_ms = Date.now() - t_start;
          logger.info(
            { callId: this.callId, action: action.type, claude_ms },
            'Orchestrator decision',
          );

          // Navigate browser if orchestrator sent a browser command
          if (action.browser_command && action.browser_command.section && demoBrowser) {
            demoBrowser.navigateToSection(action.browser_command.section);
          }

          if (action.response_text) {
            await this.speakResponse(action.response_text);
          }
        },
      );
    });

    this.sttStream.on('error', (err) => {
      logger.error({ err: err.message }, 'STT stream error — reopening');
      this.sttStream = null;
      this.scheduleSTTReopen();
    });

    this.sttStream.on('end', () => {
      logger.info('STT stream ended — reopening');
      this.sttStream = null;
      this.scheduleSTTReopen();
    });
  }

  scheduleSTTReopen() {
    if (this.stopped) return;
    if (this.sttReopenTimer) clearTimeout(this.sttReopenTimer);
    this.sttReopenTimer = setTimeout(() => this.openSTTStream(), 1000);
  }

  async speakResponse(text) {
    const tracker = new LatencyTracker(this.callId);
    tracker.mark('claude_done');

    logger.info({ callId: this.callId, textLength: text.length }, 'Synthesizing TTS for Zoom');

    // isSpeaking intentionally stays false during synthesis — the prospect can
    // still be heard while ElevenLabs is working; suppression only applies
    // while audio is actually playing (SpeechPlayer owns that window).
    const { audioChunks, error } = await synthesize(this.callId, text, tracker);

    if (error || audioChunks.length === 0) {
      logger.error({ callId: this.callId, error }, 'TTS produced no audio for response');
      return;
    }

    const combined = Buffer.concat(audioChunks);
    const pcmFile = `${AUDIO_OUTPUT_DIR}/${this.callId}_response_${Date.now()}.pcm`;
    ensureDir(AUDIO_OUTPUT_DIR);
    writeFileSync(pcmFile, combined);

    const result = await speechPlayer.enqueue(combined);
    const latency = tracker.report();
    logger.info({ callId: this.callId, latency, stopped: result.stopped }, 'Voice loop complete');
  }

  startFileWatcher() {
    // Poll the meeting-audio file for new data and stream to STT.
    // Reads only the new bytes (fd + offset) instead of re-reading the whole
    // growing file every 100ms — the old approach copied hundreds of MB/s
    // through the heap after half an hour of meeting audio.
    const audioFile = resolve(process.cwd(), 'out/meeting-audio.pcm');
    let lastSize = 0;
    try {
      // Skip anything recorded before we started watching (stale runs)
      lastSize = statSync(audioFile).size;
    } catch { /* file not created yet */ }

    this.fileWatcher = setInterval(() => {
      if (this.stopped) return;
      let size;
      try {
        size = statSync(audioFile).size;
      } catch {
        return; // not created yet
      }

      if (size < lastSize) {
        lastSize = 0; // file was truncated/rotated
      }

      if (this.isSpeaking && !CAPTURE_DURING_PLAYBACK) {
        // Zoom's mixed stream includes our own TTS voice. Discard everything
        // captured during playback — skipping without advancing lastSize used
        // to replay the whole backlog (our own words) into STT afterwards.
        lastSize = size;
        return;
      }
      // With capture-during-playback (default, live-tested): audio keeps
      // flowing during narration so the prospect can barge in mid-step. The
      // orchestrator's transcript gate is responsible for separating echoes
      // of our own voice from real interrupts.

      if (size <= lastSize) return;

      try {
        const newBytes = size - lastSize;
        const buffer = Buffer.alloc(newBytes);
        const fd = openSync(audioFile, 'r');
        const bytesRead = readSync(fd, buffer, 0, newBytes, lastSize);
        closeSync(fd);
        lastSize += bytesRead;
        if (bytesRead <= 0) return;

        if (!this.sttStream) this.openSTTStream();

        const newData = buffer.subarray(0, bytesRead);
        for (let i = 0; i < newData.length; i += CHUNK_SIZE_32K) {
          const chunk = newData.subarray(i, Math.min(i + CHUNK_SIZE_32K, newData.length));
          if (this.sttStream) {
            this.sttStream.write({
              call_id: this.callId,
              audio_data: chunk,
              sample_rate: 32000,
              encoding: 'LINEAR16',
            });
          }
        }
      } catch { /* file locked by SDK */ }
    }, 100); // Poll every 100ms for responsiveness
  }

  stop() {
    this.stopped = true;
    if (this.fileWatcher) clearInterval(this.fileWatcher);
    if (this.sttReopenTimer) clearTimeout(this.sttReopenTimer);
    if (this.sttStream) {
      try { this.sttStream.end(); } catch { /* ignore */ }
      this.sttStream = null;
    }
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

        let bot = null;
        let shuttingDown = false;
        const shutdown = (exitCode = 0, reason = 'signal') => {
          if (shuttingDown) return;
          shuttingDown = true;
          logger.info({ reason, exitCode }, 'Shutting down...');
          if (bot) bot.stop();
          if (demoBrowser) demoBrowser.stop().catch(() => {});
          if (demoBrowserGrpcServer) {
            try { demoBrowserGrpcServer.tryShutdown(() => {}); } catch { /* ignore */ }
          }
          orchestratorClient.endSession({ call_id: callId }, () => {});
          setTimeout(() => process.exit(exitCode), 2000);
        };

        try {
          // Launch demo browser on Xvfb before SDK starts (so there's something to share)
          demoBrowser = new DemoBrowser();
          await demoBrowser.start();

          // Expose gRPC so orchestrator can navigate the browser + play audio
          startDemoBrowserGrpc();
        } catch (err2) {
          logger.error({ err: err2.message }, 'Failed to start demo browser');
          return shutdown(1, 'demo browser failed');
        }

        // Auto-demo triggers when the virtual mic reports ready — a blind
        // timer used to fire narration before the bot was even in the meeting
        const autoDemo = process.env.AUTO_DEMO !== 'false';
        const orchestratorUrl =
          process.env.ORCHESTRATOR_HTTP_URL ||
          `http://${process.env.ORCHESTRATOR_GRPC_ADDR?.split(':')[0] || 'localhost'}:3000`;

        let autoDemoTriggered = false;
        const triggerAutoDemo = async (attempt = 1) => {
          if (!autoDemo || autoDemoTriggered || shuttingDown) return;
          try {
            logger.info({ callId, attempt }, 'Triggering auto-demo');
            const res = await fetch(`${orchestratorUrl}/api/sessions/${callId}/auto-demo`, {
              method: 'POST',
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            autoDemoTriggered = true;
            logger.info({ callId, data }, 'Auto-demo triggered');
          } catch (err3) {
            logger.error({ err: err3.message, attempt }, 'Failed to trigger auto-demo');
            if (attempt < 5) setTimeout(() => triggerAutoDemo(attempt + 1), 3000);
          }
        };

        bot = new ZoomSDKBot(callId, {
          onMicReady: () => {
            logger.info({ callId }, 'Virtual mic ready');
            // Small grace period so the first narration bytes are not dropped
            setTimeout(() => triggerAutoDemo(), 2000);
          },
          onMeetingDead: (reason) => shutdown(1, reason),
        });

        const started = await bot.start(meetingId, process.env.ZOOM_MEETING_PASSWORD);

        if (!started) {
          logger.error('Failed to start Zoom SDK bot');
          return shutdown(1, 'SDK start failed');
        }

        // Fallback trigger in case the mic-ready stdout marker never appears
        // (SDK log wording changed, line split across data events, …)
        setTimeout(() => {
          if (!autoDemoTriggered) {
            logger.warn({ callId }, 'Mic-ready marker not seen after 25s — triggering auto-demo anyway');
            triggerAutoDemo();
          }
        }, 25000);

        process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
        process.on('SIGINT', () => shutdown(0, 'SIGINT'));
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
