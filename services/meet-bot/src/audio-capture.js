import { spawn } from 'child_process';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const CHUNK_SIZE = 3200; // 100ms of 16kHz 16-bit mono PCM

/**
 * Captures audio from PulseAudio monitor source and streams it to the STT gRPC client.
 *
 * PulseAudio setup (done in Dockerfile CMD):
 *   - MeetSpeaker null-sink is the default sink (Chromium outputs Meet audio here)
 *   - We capture from MeetSpeaker.monitor to get meeting participant audio
 *
 * @param {object} sttClient — gRPC STT client with streamAudio()
 * @param {string} callId — Session identifier
 * @param {object} speakingRef — Object with { isSpeaking: boolean } for echo suppression
 * @returns {{ stream: object, stop: () => void }}
 */
export function startAudioCapture(sttClient, callId, speakingRef) {
  const sttStream = sttClient.streamAudio();
  let audioBuffer = Buffer.alloc(0);
  let stopped = false;

  // Spawn parec to capture from MeetSpeaker.monitor
  const parec = spawn('parec', [
    '--format=s16le',
    '--rate=16000',
    '--channels=1',
    '--device=MeetSpeaker.monitor',
    '--raw',
    '--latency-msec=50',
  ], { stdio: ['pipe', 'pipe', 'pipe'] });

  parec.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) logger.warn({ parec: msg }, 'parec stderr');
  });

  parec.on('exit', (code) => {
    if (!stopped) logger.info({ code }, 'parec process exited');
  });

  let totalBytes = 0;
  let nonSilentChunks = 0;
  let chunkCount = 0;

  parec.stdout.on('data', (data) => {
    if (stopped) return;
    totalBytes += data.length;

    audioBuffer = Buffer.concat([audioBuffer, data]);

    // Send complete chunks to STT
    while (audioBuffer.length >= CHUNK_SIZE) {
      const chunk = audioBuffer.subarray(0, CHUNK_SIZE);
      audioBuffer = audioBuffer.subarray(CHUNK_SIZE);
      chunkCount++;

      // Check if chunk has actual audio (not silence)
      let maxSample = 0;
      for (let i = 0; i < chunk.length; i += 2) {
        const sample = Math.abs(chunk.readInt16LE(i));
        if (sample > maxSample) maxSample = sample;
      }
      if (maxSample > 100) nonSilentChunks++;

      // Log audio stats every 5 seconds (50 chunks at 100ms each)
      if (chunkCount % 50 === 0) {
        logger.info({ totalBytes, chunkCount, nonSilentChunks, lastMaxSample: maxSample }, 'Audio capture stats');
      }

      try {
        sttStream.write({
          call_id: callId,
          audio_data: chunk,
          sample_rate: 16000,
          encoding: 'LINEAR16',
        });
      } catch {
        // Stream already closed — will be restarted by error/end handler
        break;
      }
    }
  });

  // Send silence periodically to keep STT stream alive during quiet periods
  const SILENCE_CHUNK = Buffer.alloc(CHUNK_SIZE, 0); // 100ms of silence
  const keepAlive = setInterval(() => {
    if (stopped) return;
    try {
      sttStream.write({
        call_id: callId,
        audio_data: SILENCE_CHUNK,
        sample_rate: 16000,
        encoding: 'LINEAR16',
      });
    } catch { /* stream closed */ }
  }, 5000); // Send silence every 5s to prevent STT timeout

  logger.info({ callId, device: 'MeetSpeaker.monitor' }, 'Audio capture started');

  return {
    stream: sttStream,
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(keepAlive);
      parec.kill('SIGTERM');
      try { sttStream.end(); } catch { /* already ended */ }
      logger.info('Audio capture stopped');
    },
  };
}
