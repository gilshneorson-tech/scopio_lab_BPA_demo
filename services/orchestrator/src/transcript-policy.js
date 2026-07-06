/**
 * Transcript decision policy — pure logic extracted from the orchestrator's
 * OnTranscription handler so it can be unit-tested (see test/transcript-policy.test.js).
 *
 * Classification order for final transcripts:
 *   empty → echo → filler → duplicate → low-confidence → interrupt → question
 *
 * Fillers and echoes are checked BEFORE deduplication and are never recorded in
 * the dedup window, so a filler ("okay") can never swallow the real question
 * that follows it ("Okay, so how much does this cost?").
 */

// Filler / noise that should never pause the demo or call Claude (STT echo + agreement)
export const FILLER_PATTERNS =
  /^[\s.,!?]*(?:it|the|a|um|uh|hmm|ok|okay|got it|sure|right|yes|yeah|yep|interesting|cool|great|nice|thanks|thank you|hello|hi|hey|hello hello)[\s.,!?]*$/i;

// Phrases that always signal "prospect wants attention" regardless of surrounding words
const STRONG_INTERRUPT_PHRASES = [
  'i have a question',
  'can i ask',
  'excuse me',
  'hold on',
  'one moment',
  'quick question',
  'before you move on',
  'sorry to interrupt',
  'can i jump in',
];

// Tokens that only signal an interrupt when the utterance is short and standalone
// (a bare "wait" or the agent's name). In longer sentences these are ordinary words
// ("can't wait to see the reporting side").
const WEAK_INTERRUPT_TOKENS = ['wait', 'may i'];
const WEAK_TOKEN_MAX_WORDS = 4;

// An utterance this long is a real question even if it opens with an interrupt phrase
const INTERRUPT_MAX_WORDS = 12;

const DEFAULTS = {
  agentName: 'Alex',
  dedupWindowMs: 4000,
  interruptCooldownMs: 10000,
  echoWindowMs: 30000,
  minConfidence: 0.65,
  minWordCount: 2,
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function createTranscriptGate(options = {}) {
  const cfg = { ...DEFAULTS, ...options };

  const strongPattern = new RegExp(
    `\\b(${STRONG_INTERRUPT_PHRASES.map(escapeRegExp).join('|')})\\b`,
    'i',
  );
  const weakPattern = new RegExp(
    `\\b(${[...WEAK_INTERRUPT_TOKENS, cfg.agentName.toLowerCase()]
      .map(escapeRegExp)
      .join('|')})\\b`,
    'i',
  );

  // call_id → { text (normalized), timestamp }
  const recentTranscripts = new Map();
  // call_id → timestamp of last "Of course, go ahead."
  const lastInterruptAck = new Map();
  // call_id → [{ text (normalized), timestamp }] of recent agent utterances
  const agentSpeech = new Map();

  function isEcho(callId, normalized, now) {
    if (normalized.length < 4) return false;
    const spoken = agentSpeech.get(callId);
    if (!spoken) return false;
    // prune while checking
    const live = spoken.filter((s) => now - s.timestamp <= cfg.echoWindowMs);
    agentSpeech.set(callId, live);
    return live.some((s) => s.text.includes(normalized));
  }

  function isLikelyInterrupt(trimmed, wordCount) {
    if (strongPattern.test(trimmed)) return true;
    return wordCount <= WEAK_TOKEN_MAX_WORDS && weakPattern.test(trimmed);
  }

  function isDuplicate(callId, normalized, now) {
    const recent = recentTranscripts.get(callId);
    if (!recent || now - recent.timestamp >= cfg.dedupWindowMs) return false;
    const a = normalized;
    const b = recent.text;
    if (a === b) return true;
    const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
    // Prefix overlap only counts as a partial→final duplicate when the two are
    // similar in length — a long question that merely opens with the same words
    // as an earlier short utterance must still be processed.
    return longer.startsWith(shorter) && shorter.length / longer.length >= 0.6;
  }

  return {
    /**
     * Classify one transcription event.
     * @returns {{kind: string, shouldPause?: boolean, ack?: boolean, wordCount?: number}}
     */
    evaluate({ callId, text, isFinal, confidence = 0, now = Date.now() }) {
      const trimmed = (text || '').trim();
      if (!trimmed) return { kind: 'empty' };

      const normalized = normalize(trimmed);
      const isFiller = FILLER_PATTERNS.test(trimmed);
      const echo = isEcho(callId, normalized, now);

      if (!isFinal) {
        return { kind: 'interim', shouldPause: !isFiller && !echo };
      }

      if (echo) return { kind: 'echo' };
      if (isFiller) return { kind: 'filler' };

      if (isDuplicate(callId, normalized, now)) {
        return { kind: 'duplicate' };
      }
      recentTranscripts.set(callId, { text: normalized, timestamp: now });

      const wordCount = trimmed.split(/\s+/).length;
      const interrupt = isLikelyInterrupt(trimmed, wordCount);

      if (
        !interrupt &&
        confidence > 0 &&
        (confidence < cfg.minConfidence || wordCount < cfg.minWordCount)
      ) {
        return { kind: 'low-confidence', wordCount };
      }

      if (interrupt && wordCount < INTERRUPT_MAX_WORDS) {
        const lastAck = lastInterruptAck.get(callId);
        const ack = lastAck === undefined || now - lastAck >= cfg.interruptCooldownMs;
        if (ack) lastInterruptAck.set(callId, now);
        return { kind: 'interrupt', ack, wordCount };
      }

      return { kind: 'question', wordCount };
    },

    /** Record what the agent said (narration or answer) for echo suppression. */
    registerAgentSpeech(callId, text, now = Date.now()) {
      const normalized = normalize(text || '');
      if (!normalized) return;
      const list = agentSpeech.get(callId) || [];
      list.push({ text: normalized, timestamp: now });
      // keep a bounded window
      agentSpeech.set(callId, list.slice(-10));
    },

    clearCall(callId) {
      recentTranscripts.delete(callId);
      lastInterruptAck.delete(callId);
      agentSpeech.delete(callId);
    },

    clearAll() {
      recentTranscripts.clear();
      lastInterruptAck.clear();
      agentSpeech.clear();
    },
  };
}

// ─── Auto-demo pause management (P0.2: every pause has a watchdog) ───

export const PAUSE_WATCHDOG_MS = 30000;

/**
 * Pause the auto-demo with a reason. A watchdog always accompanies the pause so
 * a swallowed transcript or a prospect who never follows up cannot freeze the
 * demo forever.
 */
export function pauseDemo(demoState, reason, watchdogMs = PAUSE_WATCHDOG_MS, onWatchdogResume) {
  demoState.paused = true;
  demoState.pauseReason = reason;
  if (demoState.pauseWatchdog) clearTimeout(demoState.pauseWatchdog);
  demoState.pauseWatchdog = setTimeout(() => {
    if (demoState.paused) {
      demoState.paused = false;
      demoState.pauseReason = null;
      demoState.pauseWatchdog = null;
      if (onWatchdogResume) onWatchdogResume();
    }
  }, watchdogMs);
  if (demoState.pauseWatchdog.unref) demoState.pauseWatchdog.unref();
}

export function resumeDemo(demoState) {
  demoState.paused = false;
  demoState.pauseReason = null;
  if (demoState.pauseWatchdog) {
    clearTimeout(demoState.pauseWatchdog);
    demoState.pauseWatchdog = null;
  }
}

/**
 * Filler / low-confidence noise may only cancel a pause that an interim result
 * caused. An interrupt hold ("I have a question" → waiting for the question)
 * must survive noise like "yeah" — resuming there talks over the prospect.
 */
export function maybeResumeAfterNoise(demoState) {
  if (demoState.paused && demoState.pauseReason === 'interim') {
    resumeDemo(demoState);
  }
}
