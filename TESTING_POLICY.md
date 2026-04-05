# Testing Policy — ScopioLabs BPA Demo Agent

## Test Scripts

| Script | Phase | What it tests |
|---|---|---|
| `scripts/test-e2e.sh` | Phase 1 | Session lifecycle, 10-step demo advancement, browser navigation, Claude Q&A, graceful degradation |
| `scripts/test-voice-loop.sh` | Phase 2 | Full voice pipeline: audio → Google Cloud STT → orchestrator → Claude → ElevenLabs TTS → audio output |

## How to Run

### Phase 1 — E2E (no API keys needed)
```bash
# Requires: Redis on :6379, browser-controller on :8090/:50053, orchestrator on :3000/:50051
# Optional: claude-wrapper on :50052 (degrades gracefully without it)
bash scripts/test-e2e.sh
# Expected: 14/14 tests pass
```

### Phase 2 — Voice Loop
```bash
# Requires: All Phase 1 services + stt-service on :50056 + tts-service on :50054
# Requires: ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, GCP ADC for Speech-to-Text
bash scripts/test-voice-loop.sh
# Expected: Audio transcribed, Claude responds, TTS audio file saved
```

## Test-Before-Code Policy

- Every new feature or bug fix must have a corresponding test or be covered by an existing test script
- Run `bash scripts/test-e2e.sh` before every commit that touches orchestrator, browser-controller, or claude-wrapper
- Run `bash scripts/test-voice-loop.sh` before every commit that touches stt-service, tts-service, or zoom-bot voice loop

## Phase 3 — Browser Sync + Interrupt Handling (manual, live Zoom)

Tests added 2026-04-05 for browser navigation sync, interrupt detection, and filler filtering.
These require a live Zoom meeting and cannot be automated yet.

### Test checklist (manual)

| # | Test | Expected | Status |
|---|---|---|---|
| 1 | Auto-demo navigates screen-shared browser before each narration | Orchestrator logs "Screen browser navigated" per step | PASS (verified 2026-04-05) |
| 2 | Fallback to browser-controller when zoom-bot unreachable | E2E test passes, orchestrator logs "Screen browser nav failed, falling back" | PASS (test-e2e.sh section 5) |
| 3 | Demo flows without dead gaps between sections | Narration ends → 2s → next section immediately | PASS (verified after timing fix) |
| 4 | Filler words ("ok", "hello", "Alex") don't pause demo | Orchestrator logs "Filler detected — ignoring" | NEEDS VERIFICATION |
| 5 | Duplicate STT transcripts are deduplicated | Orchestrator logs "Duplicate transcript — skipping" | NEEDS VERIFICATION |
| 6 | Interim STT results pause demo instantly | Orchestrator logs "paused (interim)" before is_final arrives | NEEDS VERIFICATION |
| 7 | Brief interrupts ("I have a question") get instant ack | Bot says "Of course, go ahead", demo stays paused | NEEDS VERIFICATION |
| 8 | Real questions answered by Claude, demo resumes | Claude responds, demo unpauses | PASS (verified: "How long is this demo going to take?") |
| 9 | "Show me the scan viewer again" navigates to that section | Claude includes section in response, browser navigates | NEEDS VERIFICATION |
| 10 | CLOSE action ends demo ("You have 10 seconds to be done") | Claude chooses CLOSE | PASS (verified 2026-04-05) |

### Known issues from 2026-04-05 testing

- STT echo: bot's own TTS sometimes leaks into STT as fragments ("It.", "yeah, let's"). `isSpeaking` flag helps but doesn't fully eliminate.
- "Alex." was classified as ANSWER by Claude (4 times) — fixed with filler filter, needs re-verification.
- Partial + final STT duplicates ("Can we do it in five?" → "Can we do it in five minutes?") caused double answers — fixed with dedup, needs re-verification.

## What's Not Yet Tested

- Unit tests for individual services (no test framework set up yet)
- Firestore persistence (Phase 3)
- Zoom SDK integration (Phase 3, Linux only)
- Load testing / concurrent sessions (Phase 4)
- Real BMA UI navigation (blocked on Scopio demo environment access)
- Interrupt detection (items 4-7, 9 above — deployed but not yet verified in live call)

## CI/CD

Not yet configured. Plan: GitHub Actions running `test-e2e.sh` on PR, with Redis as a service container.
