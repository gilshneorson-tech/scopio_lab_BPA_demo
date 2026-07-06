import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTranscriptGate,
  pauseDemo,
  resumeDemo,
  maybeResumeAfterNoise,
} from '../src/transcript-policy.js';

const CALL = 'call-1';

function finalEvent(text, { confidence = 0.9, now = 1000 } = {}) {
  return { callId: CALL, text, isFinal: true, confidence, now };
}

function interimEvent(text, { now = 1000 } = {}) {
  return { callId: CALL, text, isFinal: false, confidence: 0, now };
}

describe('empty and interim transcripts', () => {
  test('empty text is ignored', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('   ')).kind, 'empty');
  });

  test('non-filler interim requests a pause', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(interimEvent('so I was wondering about'));
    assert.equal(d.kind, 'interim');
    assert.equal(d.shouldPause, true);
  });

  test('filler interim does not request a pause', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(interimEvent('okay'));
    assert.equal(d.kind, 'interim');
    assert.equal(d.shouldPause, false);
  });
});

describe('filler handling', () => {
  test('filler final is classified as filler', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('Okay.')).kind, 'filler');
    assert.equal(gate.evaluate(finalEvent('yeah')).kind, 'filler');
    assert.equal(gate.evaluate(finalEvent('It.')).kind, 'filler');
  });

  test('LIVE-TUNED: attention-getters are NOT filler (they pause the demo)', () => {
    const gate = createTranscriptGate();
    assert.notEqual(gate.evaluate(finalEvent('Hello?')).kind, 'filler');
    assert.notEqual(gate.evaluate(finalEvent('hey')).kind, 'filler');
  });

  test('REGRESSION P0.3: filler followed by a real question is NOT deduplicated', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('okay', { now: 1000 })).kind, 'filler');
    const d = gate.evaluate(finalEvent('Okay, so how much does this cost?', { now: 2500 }));
    assert.equal(d.kind, 'question');
  });
});

describe('deduplication', () => {
  test('partial → final overlap is deduplicated (prefix, similar length)', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('Can we do it in five?', { now: 1000 })).kind, 'question');
    const d = gate.evaluate(finalEvent('Can we do it in five minutes?', { now: 2000 }));
    assert.equal(d.kind, 'duplicate');
  });

  test('exact repeat is deduplicated', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('Is this FDA cleared?', { now: 1000 })).kind, 'question');
    assert.equal(gate.evaluate(finalEvent('Is this FDA cleared?', { now: 3000 })).kind, 'duplicate');
  });

  test('a much longer question sharing a short prefix is NOT deduplicated', () => {
    const gate = createTranscriptGate();
    // "Can you show" is an ackable attention-getter (live-tuned) — but it must
    // not swallow the full question that follows it
    assert.equal(gate.evaluate(finalEvent('Can you show', { now: 1000 })).kind, 'interrupt');
    const d = gate.evaluate(
      finalEvent('Can you show me the scan viewer and the report export section again please?', { now: 2000 }),
    );
    assert.equal(d.kind, 'question');
  });

  test('repeat outside the dedup window is processed again', () => {
    const gate = createTranscriptGate({ dedupWindowMs: 4000 });
    assert.equal(gate.evaluate(finalEvent('Is this FDA cleared?', { now: 1000 })).kind, 'question');
    assert.equal(gate.evaluate(finalEvent('Is this FDA cleared?', { now: 6000 })).kind, 'question');
  });

  test('clearCall resets dedup state', () => {
    const gate = createTranscriptGate();
    gate.evaluate(finalEvent('Is this FDA cleared?', { now: 1000 }));
    gate.clearCall(CALL);
    assert.equal(gate.evaluate(finalEvent('Is this FDA cleared?', { now: 1500 })).kind, 'question');
  });
});

describe('low confidence', () => {
  test('low-confidence garbage is ignored', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(finalEvent('purple monkey dishwasher', { confidence: 0.2 }));
    assert.equal(d.kind, 'low-confidence');
  });

  test('LIVE-TUNED: moderate confidence (0.4) passes — Google scores short real speech low', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(finalEvent('how much does this cost', { confidence: 0.4 }));
    assert.equal(d.kind, 'question');
  });

  test('single non-filler word with high confidence is ignored (too short)', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('Pricing', { confidence: 0.9 })).kind, 'low-confidence');
  });

  test('zero confidence (not reported) is not filtered', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(finalEvent('how much does it cost', { confidence: 0 }));
    assert.equal(d.kind, 'question');
  });
});

describe('interrupt detection', () => {
  test('strong interrupt phrase gets an ack', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(finalEvent('I have a question', { now: 1000 }));
    assert.equal(d.kind, 'interrupt');
    assert.equal(d.ack, true);
  });

  test('LIVE-TUNED: a longer utterance with an interrupt phrase goes to Claude', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(finalEvent('Sorry to interrupt, I have a question about pricing', { confidence: 0.9 }));
    assert.equal(d.kind, 'question');
  });

  test('second interrupt within the cooldown is not re-acked', () => {
    const gate = createTranscriptGate({ interruptCooldownMs: 10000 });
    assert.equal(gate.evaluate(finalEvent('I have a question', { now: 1000 })).ack, true);
    const d = gate.evaluate(finalEvent('hold on one moment', { now: 4000 }));
    assert.equal(d.kind, 'interrupt');
    assert.equal(d.ack, false);
  });

  test('agent name is configurable (P1.11)', () => {
    const gate = createTranscriptGate({ agentName: 'Marie' });
    assert.equal(gate.evaluate(finalEvent('Marie? Hello?', { confidence: 0.9 })).kind, 'interrupt');
  });

  test('bare "wait" in a longer sentence is NOT an interrupt (P0/A5)', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(finalEvent("Can't wait to see the reporting side", { confidence: 0.9 }));
    assert.equal(d.kind, 'question');
  });

  test('standalone "wait wait" is an interrupt', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('wait wait', { confidence: 0.9 })).kind, 'interrupt');
  });

  test('LIVE-TUNED: short attention-getters are interrupts', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('Hello?', { confidence: 0.9, now: 1000 })).kind, 'interrupt');
    assert.equal(gate.evaluate(finalEvent('show me', { confidence: 0.9, now: 20000 })).kind, 'interrupt');
    assert.equal(gate.evaluate(finalEvent('Stop.', { confidence: 0.9, now: 40000 })).kind, 'interrupt');
    assert.equal(gate.evaluate(finalEvent('hang on', { confidence: 0.9, now: 60000 })).kind, 'interrupt');
  });

  test('LIVE-TUNED: attention-getter words inside real questions do NOT ack', () => {
    const gate = createTranscriptGate();
    assert.equal(gate.evaluate(finalEvent('Show me the scan viewer again', { confidence: 0.9, now: 1000 })).kind, 'question');
    assert.equal(gate.evaluate(finalEvent('What about the pricing model', { confidence: 0.9, now: 10000 })).kind, 'question');
  });

  test('a long utterance containing an interrupt phrase is treated as a question', () => {
    const gate = createTranscriptGate();
    const d = gate.evaluate(
      finalEvent('I have a question about how the AI differential count compares to a manual count in practice', {
        confidence: 0.9,
      }),
    );
    assert.equal(d.kind, 'question');
  });
});

describe('echo suppression (P0.4)', () => {
  test('a final matching recent agent speech is classified as echo', () => {
    const gate = createTranscriptGate({ agentName: 'Alex' });
    gate.registerAgentSpeech(CALL, "Hi, I'm Alex from Scopio Labs. Thank you for joining today.", 1000);
    const d = gate.evaluate(finalEvent("I'm Alex from Scopio Labs", { now: 3000, confidence: 0.9 }));
    assert.equal(d.kind, 'echo');
  });

  test('echoed narration containing the agent name does NOT trigger an interrupt ack', () => {
    const gate = createTranscriptGate({ agentName: 'Alex' });
    gate.registerAgentSpeech(CALL, "Hi, I'm Alex from Scopio Labs. Thank you for joining today.", 1000);
    const d = gate.evaluate(finalEvent('Alex from Scopio Labs.', { now: 2000, confidence: 0.9 }));
    assert.notEqual(d.kind, 'interrupt');
  });

  test('interim echo does not pause the demo', () => {
    const gate = createTranscriptGate();
    gate.registerAgentSpeech(CALL, 'Our scanner captures the entire bone marrow sample at 100x resolution', 1000);
    const d = gate.evaluate(interimEvent('captures the entire bone marrow sample', { now: 2000 }));
    assert.equal(d.shouldPause, false);
  });

  test('agent speech outside the echo window no longer suppresses', () => {
    const gate = createTranscriptGate({ echoWindowMs: 5000 });
    gate.registerAgentSpeech(CALL, 'remote access removes the transport lag entirely', 1000);
    const d = gate.evaluate(finalEvent('remote access removes the transport lag', { now: 20000, confidence: 0.9 }));
    assert.equal(d.kind, 'question');
  });

  test('a genuine question about narrated content is not an echo', () => {
    const gate = createTranscriptGate();
    gate.registerAgentSpeech(CALL, 'Our AI engine performs a full nucleated differential count.', 1000);
    const d = gate.evaluate(finalEvent('How accurate is the differential count compared to manual?', { now: 3000, confidence: 0.9 }));
    assert.equal(d.kind, 'question');
  });
});

describe('pause manager (P0.2 watchdog)', () => {
  test('pauseDemo sets paused with a reason; resumeDemo clears it', () => {
    const demoState = { running: true, paused: false };
    pauseDemo(demoState, 'interim', 60000);
    assert.equal(demoState.paused, true);
    assert.equal(demoState.pauseReason, 'interim');
    resumeDemo(demoState);
    assert.equal(demoState.paused, false);
    assert.equal(demoState.pauseReason, null);
  });

  test('REGRESSION P0.2: watchdog auto-resumes a stuck pause', async () => {
    const demoState = { running: true, paused: false };
    pauseDemo(demoState, 'interrupt', 50);
    assert.equal(demoState.paused, true);
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(demoState.paused, false);
  });

  test('re-pausing refreshes the watchdog', async () => {
    const demoState = { running: true, paused: false };
    pauseDemo(demoState, 'interim', 100);
    await new Promise((r) => setTimeout(r, 60));
    pauseDemo(demoState, 'question', 100);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(demoState.paused, true); // first watchdog must not fire
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(demoState.paused, false);
  });

  test('REGRESSION P1.12: filler noise only resumes an interim-caused pause', () => {
    const interimPaused = { running: true, paused: false };
    pauseDemo(interimPaused, 'interim', 60000);
    maybeResumeAfterNoise(interimPaused);
    assert.equal(interimPaused.paused, false);

    const interruptPaused = { running: true, paused: false };
    pauseDemo(interruptPaused, 'interrupt', 60000);
    maybeResumeAfterNoise(interruptPaused);
    assert.equal(interruptPaused.paused, true, 'interrupt hold must survive filler noise');
    resumeDemo(interruptPaused);
  });
});
