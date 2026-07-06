import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import pino from 'pino';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { chromium } from 'playwright';
import { createServer } from 'http';

import { joinGoogleMeet, leaveGoogleMeet } from './meet-join.js';
import { startAudioCapture } from './audio-capture.js';
import { speakResponse } from './audio-playback.js';
import { startScreenShare } from './screen-share.js';
import { spawn } from 'child_process';
import { statSync } from 'fs';

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

// ─── Speech player: serialized paplay playback (one utterance at a time) ───
//
// Everything the bot says (auto-demo narration via the PlayAudio RPC, Q&A
// answers) goes through this queue: no overlapping paplay processes, an
// authoritative isSpeaking window, and StopAudio actually cuts playback.

export const speakingRef = { isSpeaking: false };

class PaplaySpeechPlayer {
  constructor() {
    this.queue = Promise.resolve();
    this.current = null; // { proc, finish }
    this.stopped = false;
  }

  enqueue(pcmBuffer, sampleRate = 16000) {
    const durationMs = Math.ceil((pcmBuffer.length / 2) / sampleRate * 1000);
    const play = () =>
      new Promise((resolvePlay) => {
        if (this.stopped) return resolvePlay({ stopped: true, durationMs });

        speakingRef.isSpeaking = true;
        const proc = spawn('paplay', [
          '--raw', '--format=s16le', `--rate=${sampleRate}`, '--channels=1',
          '--device=TTSPlayback',
        ], { stdio: ['pipe', 'ignore', 'pipe'] });

        let finished = false;
        const finish = (wasStopped, error) => {
          if (finished) return;
          finished = true;
          this.current = null;
          clearTimeout(safety);
          // small tail so the last samples clear the PulseAudio pipeline
          setTimeout(() => {
            speakingRef.isSpeaking = false;
            resolvePlay({ stopped: wasStopped, durationMs, error });
          }, 500);
        };

        this.current = { proc, finish };
        proc.on('exit', () => finish(false));
        proc.on('error', (err) => {
          logger.error({ err: err.message }, 'paplay error');
          finish(false, err.message);
        });
        const safety = setTimeout(() => {
          try { proc.kill('SIGTERM'); } catch { /* gone */ }
          finish(false, 'playback safety timeout');
        }, durationMs + 5000);

        proc.stdin.on('error', () => { /* EPIPE when stopped mid-write */ });
        proc.stdin.end(pcmBuffer);
      });

    const result = this.queue.then(play);
    this.queue = result.then(() => {}, () => {});
    return result;
  }

  stopAll() {
    this.stopped = true;
    const clearFlag = () => { this.stopped = false; };
    this.queue = this.queue.then(clearFlag, clearFlag);
    if (this.current) {
      try { this.current.proc.kill('SIGTERM'); } catch { /* gone */ }
      this.current.finish(true);
    }
  }
}

const speechPlayer = new PaplaySpeechPlayer();

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
    this.bmaUrl = '';
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
    const MIME_TYPES = { '.html': 'text/html', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.css': 'text/css', '.js': 'text/javascript' };
    const server = createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      if (urlPath === '/' || urlPath === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(html);
        return;
      }
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
    server.listen(8090, () => {
      logger.info('Test BMA page served at http://localhost:8090');
    });
    this.bmaUrl = 'http://localhost:8090';

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

    const context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });
    this.page = await context.newPage();
    await this.page.goto(this.bmaUrl);
    logger.info('Demo browser launched on Xvfb display');
  }

  // Set an alternate page (e.g., a tab in the Meet browser) for navigation
  setSharePage(page) {
    this.sharePage = page;
  }

  async navigateToSection(section) {
    // Navigate both the Xvfb browser and the shared tab (if set)
    const pages = [this.page, this.sharePage].filter(Boolean);
    if (pages.length === 0) return;
    const hash = SECTION_HASH[section] || section;
    for (const p of pages) {
      try {
        // Short click timeout: a missing selector must fall back to hash
        // navigation in ~1s, not stall a live demo step for 30s
        const clicked = await p.click(`[data-section="${hash}"], nav a[href="#${hash}"]`, { timeout: 1000 })
          .then(() => true).catch(() => false);
        if (!clicked) {
          await p.goto(`${this.bmaUrl}#${hash}`, { timeout: 5000 });
        }
      } catch (err) {
        logger.warn({ err: err.message, section }, 'Browser navigation failed');
      }
    }
    logger.info({ section, hash }, 'Browser navigated');
  }

  async stop() {
    if (this.browser) await this.browser.close();
  }
}

let demoBrowser = null;
let demoBrowserGrpcServer = null;

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
        await demoBrowser.navigateToSection(section);
        const url = demoBrowser.page.url();
        callback(null, { success: true, message: 'navigated', current_url: url });
      } catch (err) {
        logger.error({ err: err.message, section }, 'DemoBrowser gRPC nav failed');
        callback(null, { success: false, message: err.message });
      }
    },

    // Same contract as zoom-bot: the orchestrator narrates through this RPC
    // and paces steps on its completion; StopAudio cuts playback on interrupt.
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

// ─── Google Meet Bot ───

class MeetBot {
  constructor(callId) {
    this.callId = callId;
    this.meetBrowser = null;
    this.meetPage = null;
    this.audioCapture = null;
    // Shared with the speech player — authoritative "bot is talking" window
    this.speakingRef = speakingRef;
  }

  async start(meetUrl, botName) {
    logger.info({ meetUrl, botName, callId: this.callId }, 'Starting Google Meet bot');

    // Ensure PulseAudio devices are ready
    await new Promise(r => setTimeout(r, 2000));

    // Launch fresh Chromium (no persistent profile — it breaks screen sharing)
    this.meetBrowser = await chromium.launch({
      headless: false,
      env: {
        ...process.env,
        // Ensure Chromium finds PulseAudio (user-mode socket)
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/0',
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--use-fake-ui-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--auto-select-desktop-capture-source=Entire screen',
        '--auto-select-tab-capture-source-by-title=Scopio',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--disable-blink-features=AutomationControlled',
        '--enable-features=WebRtcAllowInputVolumeAdjustment',
      ],
    });

    const context = await this.meetBrowser.newContext({
      permissions: ['microphone', 'camera'],
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });
    this.meetPage = await context.newPage();

    // Join the Google Meet
    const joined = await joinGoogleMeet(this.meetPage, meetUrl, botName);
    if (!joined) {
      logger.error('Failed to join Google Meet');
      return false;
    }

    // Open the demo page as a tab in the Meet browser for tab sharing
    const meetContext = this.meetPage.context();
    this.demoTab = await meetContext.newPage();
    await this.demoTab.goto('http://localhost:8090', { waitUntil: 'load' });
    logger.info('Opened demo page as tab in Meet browser');

    // Register this tab with DemoBrowser so navigation happens in both places
    if (demoBrowser) demoBrowser.setSharePage(this.demoTab);

    // Dismiss any "Camera not found" or other error banners before screen sharing
    await this.meetPage.bringToFront();
    await this.meetPage.waitForTimeout(2000);
    try {
      const closeBtn = this.meetPage.locator('button[aria-label="Close"]');
      if (await closeBtn.isVisible({ timeout: 2000 })) {
        await closeBtn.click();
        logger.info('Dismissed error/info dialog before screen share');
        await this.meetPage.waitForTimeout(1000);
      }
    } catch { /* no dialog */ }

    // Start screen sharing
    await startScreenShare(this.meetPage);

    // Verify Chromium connected to PulseAudio
    try {
      const { execSync } = await import('child_process');
      const sinkInputs = execSync('pactl list short sink-inputs 2>/dev/null').toString().trim();
      const sourceOutputs = execSync('pactl list short source-outputs 2>/dev/null').toString().trim();
      logger.info({ sinkInputs: sinkInputs || '(none)', sourceOutputs: sourceOutputs || '(none)' }, 'PulseAudio connections after join');
    } catch (e) {
      logger.warn({ err: e.message }, 'Could not check PulseAudio connections');
    }

    // Start audio capture (parec → STT)
    this.audioCapture = startAudioCapture(sttClient, this.callId, this.speakingRef);
    this.setupSTTHandlers();

    // Watch for TTS audio written by orchestrator's auto-demo
    this.startTTSFileWatcher();

    return true;
  }

  startTTSFileWatcher() {
    // FALLBACK path only: the orchestrator narrates via the PlayAudio RPC.
    // It writes this shared file solely when the RPC is unreachable. Only the
    // NEW bytes are enqueued (the previous version re-played the whole file
    // on every size change), and playback goes through the serialized speech
    // player like everything else.
    const ttsFile = '/tmp/zoom-audio/tts-output.pcm';
    let lastSize = 0;
    try { lastSize = statSync(ttsFile).size; } catch { /* not created yet */ }

    this.ttsWatcher = setInterval(() => {
      let size;
      try {
        size = statSync(ttsFile).size;
      } catch {
        return; // file doesn't exist yet — normal during startup
      }
      if (size < lastSize) lastSize = 0; // truncated/rotated
      if (size <= lastSize) return;

      try {
        const buffer = readFileSync(ttsFile);
        const newAudio = buffer.subarray(lastSize, size);
        lastSize = size;
        if (newAudio.length === 0) return;
        logger.info({ bytes: newAudio.length }, 'Playing fallback TTS audio from shared file');
        speechPlayer.enqueue(Buffer.from(newAudio));
      } catch (err) {
        logger.warn({ err: err.message }, 'Failed to read fallback TTS file');
      }
    }, 200);
  }

  setupSTTHandlers() {
    const { stream } = this.audioCapture;
    let restarting = false;

    const restartCapture = (reason) => {
      if (restarting) return;
      restarting = true;
      logger.info({ reason }, 'Restarting audio capture');
      setTimeout(() => {
        if (this.audioCapture) this.audioCapture.stop();
        this.audioCapture = startAudioCapture(sttClient, this.callId, this.speakingRef);
        this.setupSTTHandlers();
      }, 3000); // 3s debounce to prevent rapid restart loops
    };

    stream.on('data', (transcription) => {
      if (!transcription.text.trim()) return;

      const text = transcription.text;

      // Always forward interim results for demo pause detection (even during TTS)
      if (!transcription.is_final) {
        orchestratorClient.onTranscription(
          {
            call_id: this.callId,
            text,
            is_final: false,
            confidence: 0,
            timestamp_ms: Date.now(),
          },
          () => {},
        );
        return;
      }

      // During TTS playback, we still forward finals but flag them.
      // The orchestrator handles interrupt detection — suppressing here blocks user interrupts.
      if (this.speakingRef.isSpeaking) {
        logger.info({ text, confidence: transcription.confidence }, 'Final transcription during TTS (possible interrupt or echo)');
      }

      logger.info({ callId: this.callId, text, confidence: transcription.confidence }, 'Meet STT transcription');

      // Forward final result to orchestrator for Claude processing
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

          // Navigate browser if orchestrator sent a browser command
          if (action.browser_command && action.browser_command.section && demoBrowser) {
            demoBrowser.navigateToSection(action.browser_command.section);
          }

          if (action.response_text) {
            const tracker = new LatencyTracker(this.callId);
            await speakResponse(ttsClient, this.callId, action.response_text, speechPlayer, tracker);
          }
        },
      );
    });

    stream.on('error', (err) => {
      logger.error({ err: err.message }, 'STT stream error');
      restartCapture('stream_error');
    });

    stream.on('end', () => {
      restartCapture('stream_ended');
    });
  }

  async stop() {
    if (this.ttsWatcher) clearInterval(this.ttsWatcher);
    if (this.audioCapture) this.audioCapture.stop();
    if (this.meetPage) await leaveGoogleMeet(this.meetPage).catch(() => {});
    if (this.meetBrowser) await this.meetBrowser.close().catch(() => {});
    logger.info({ callId: this.callId }, 'Meet bot stopped');
  }
}

// ─── Main ───

async function main() {
  const meetUrl = process.env.MEET_URL;

  if (meetUrl) {
    logger.info({ meetUrl }, 'Starting in Google Meet mode');

    const botName = process.env.MEET_BOT_NAME || 'Scopio Demo Agent';

    // Create orchestrator session
    orchestratorClient.startSession(
      {
        zoom_meeting_id: meetUrl, // Reuse field — orchestrator doesn't care about platform
        prospect_name: process.env.PROSPECT_NAME || 'Meet Prospect',
      },
      async (err, session) => {
        if (err) {
          logger.error({ err }, 'Failed to create session');
          process.exit(1);
        }

        const callId = session.call_id;
        logger.info({ callId, meetUrl }, 'Session created, starting Meet bot');

        // Launch demo browser on Xvfb before joining Meet (so there's something to share)
        demoBrowser = new DemoBrowser();
        await demoBrowser.start();

        // Expose gRPC so orchestrator can navigate the screen-shared browser
        startDemoBrowserGrpc();

        const bot = new MeetBot(callId);

        // Retry joining up to 3 times with increasing delays
        let started = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
          logger.info({ attempt }, 'Attempting to join Google Meet');
          started = await bot.start(meetUrl, botName);
          if (started) break;
          logger.warn({ attempt }, 'Join attempt failed, retrying...');
          await bot.stop().catch(() => {});
          await new Promise(r => setTimeout(r, attempt * 5000));
        }

        if (!started) {
          logger.error('Failed to join Google Meet after 3 attempts');
          process.exit(1);
        }

        // Start auto-demo after a delay (let audio devices initialize)
        const autoDemo = process.env.AUTO_DEMO !== 'false';
        if (autoDemo) {
          const orchestratorUrl =
            process.env.ORCHESTRATOR_HTTP_URL ||
            `http://${process.env.ORCHESTRATOR_GRPC_ADDR?.split(':')[0] || 'localhost'}:3000`;
          const triggerAutoDemo = async (attempt = 1) => {
            try {
              logger.info({ callId, attempt }, 'Triggering auto-demo');
              const res = await fetch(`${orchestratorUrl}/api/sessions/${callId}/auto-demo`, {
                method: 'POST',
              });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              const data = await res.json();
              logger.info({ callId, data }, 'Auto-demo triggered');
            } catch (err) {
              logger.error({ err: err.message, attempt }, 'Failed to trigger auto-demo');
              if (attempt < 5) setTimeout(() => triggerAutoDemo(attempt + 1), 3000);
            }
          };
          setTimeout(() => triggerAutoDemo(), 5000); // Wait 5s for Meet join + audio init
        }

        // Graceful shutdown
        const shutdown = () => {
          logger.info('Shutting down...');
          bot.stop();
          orchestratorClient.endSession({ call_id: callId }, () => {});
          if (demoBrowser) demoBrowser.stop();
          setTimeout(() => process.exit(0), 2000);
        };

        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
      },
    );
    return;
  }

  // Standby mode
  logger.warn('No MEET_URL set');
  logger.info('Usage: MEET_URL=https://meet.google.com/abc-defg-hij node src/index.js');
  logger.info('Standing by...');
  setInterval(() => {}, 30000);

  process.on('SIGTERM', () => process.exit(0));
}

main().catch((err) => {
  logger.error(err, 'Failed to start meet-bot');
  process.exit(1);
});
