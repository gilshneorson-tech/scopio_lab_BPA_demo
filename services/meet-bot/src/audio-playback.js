import { writeFileSync, existsSync, mkdirSync } from 'fs';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const AUDIO_DIR = '/tmp/meet-audio';

// One voice per language — must match the orchestrator/tts-service defaults
const VOICE_IDS = {
  en: 'XrExE9yKIg1WjnnlVkGX', // Matilda
  fr: 'xNtG3W2oqJs0cJZuTyBc', // Chloé
};

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Synthesize TTS and play it through the shared serialized speech player
 * (paplay → TTSPlayback sink → TTSPlayback.monitor → VirtualMic → Chromium
 * WebRTC). Playback never overlaps narration — the player queues it, and the
 * player owns the authoritative isSpeaking window.
 *
 * @param {object} ttsClient — gRPC TTS client with synthesize()
 * @param {string} callId
 * @param {string} text — Text to speak
 * @param {object} player — PaplaySpeechPlayer
 * @param {object} tracker — LatencyTracker instance
 * @returns {Promise<object|null>} Latency report or null on error
 */
export function speakResponse(ttsClient, callId, text, player, tracker) {
  return new Promise((resolve) => {
    tracker.mark('claude_done');

    const audioChunks = [];
    let firstChunkReceived = false;

    const stream = ttsClient.synthesize(
      {
        call_id: callId,
        text,
        voice_id:
          process.env.ELEVENLABS_VOICE_ID ||
          VOICE_IDS[process.env.DEMO_LANGUAGE] ||
          VOICE_IDS.en,
        model: process.env.TTS_MODEL || 'eleven_turbo_v2',
      },
      { deadline: Date.now() + 30000 },
    );

    stream.on('data', (response) => {
      if (response.audio_data && response.audio_data.length > 0) {
        if (!firstChunkReceived) {
          tracker.mark('tts_first_chunk');
          firstChunkReceived = true;
        }
        audioChunks.push(Buffer.from(response.audio_data));
      }
    });

    stream.on('end', async () => {
      tracker.mark('tts_done');

      if (audioChunks.length === 0) {
        logger.error({ callId }, 'TTS produced no audio for response');
        resolve(tracker.report());
        return;
      }

      const combined = Buffer.concat(audioChunks);

      // Save for debugging
      ensureDir(AUDIO_DIR);
      try {
        writeFileSync(`${AUDIO_DIR}/tts-${callId}-${Date.now()}.pcm`, combined);
      } catch { /* debug copy only */ }

      const result = await player.enqueue(combined);
      const latency = tracker.report();
      logger.info({ callId, latency, stopped: result.stopped }, 'TTS playback complete');
      resolve(latency);
    });

    stream.on('error', (err) => {
      logger.error({ err: err.message, callId }, 'TTS stream error');
      resolve(null);
    });
  });
}
