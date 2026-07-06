# Testing Policy — ScopioLabs BPA Demo Agent

## Test Suites

| Suite | What it tests | How to run |
|---|---|---|
| Unit tests | Transcript decision policy (filler/dedup/interrupt/echo/pause-watchdog) and Claude response parsing (JSON extraction, action validation, never-speak-raw-output) | `npm test` (workspaces; no services needed) |
| `scripts/test-e2e.sh` | Session lifecycle, 10-step demo advancement, browser navigation, Claude Q&A degradation, auto-demo step progression | `bash scripts/test-e2e.sh` |
| `scripts/test-voice-loop.sh` | Full voice pipeline: audio → Google Cloud STT → orchestrator → Claude → ElevenLabs TTS → audio output. Asserts the transcription matches the spoken fixture and output audio is non-trivial | `ELEVENLABS_API_KEY=... bash scripts/test-voice-loop.sh` |
| `scripts/preflight.sh` | EXTERNAL dependencies: 1-token Claude call with the configured model (catches retired models), ElevenLabs synthesis, Google STT round-trip, Zoom token mint, .env completeness | `bash scripts/preflight.sh` — run before EVERY live demo |

## How to Run

### Unit tests (no API keys, no services)
```bash
npm test
# Expected: 41 tests pass (33 transcript-policy + 8 parse-decision)
```

### Phase 1 — E2E (no API keys needed)
```bash
# Requires: browser-controller on :8090/:50053, orchestrator on :3000/:50051
# Optional: Redis on :6379, claude-wrapper on :50052 (degrades gracefully without them)
bash scripts/test-e2e.sh
# Expected: 18/18 tests pass
```

### Phase 2 — Voice Loop
```bash
# Requires: All Phase 1 services + stt-service on :50056 + tts-service on :50054
# Requires: ELEVENLABS_API_KEY, ANTHROPIC_API_KEY, GCP ADC for Speech-to-Text
ELEVENLABS_API_KEY=... bash scripts/test-voice-loop.sh
# Expected: transcript matches the spoken question, TTS audio produced, latency report printed
```

### Pre-demo preflight (ALWAYS before a live call)
```bash
bash scripts/preflight.sh
# Expected: GO. A NO-GO names the exact external dependency that would have
# failed mid-demo (this check was added after a retired Claude model silently
# broke Q&A on live calls).
```

## Test-Before-Code Policy

- Every new feature or bug fix must have a corresponding test or be covered by an existing suite
- Bug-fix workflow: write the failing test first (see the REGRESSION-tagged tests in
  `services/orchestrator/test/transcript-policy.test.js` for the pattern), then fix, then verify green
- Run `npm test && bash scripts/test-e2e.sh` before every commit that touches orchestrator, browser-controller, or claude-wrapper
- Run `bash scripts/test-voice-loop.sh` before every commit that touches stt-service, tts-service, or zoom-bot voice loop
- Live-call-only behavior (Zoom SDK, screen share, real barge-in) is covered by the manual checklist below

## Phase 3 — Browser Sync + Interrupt Handling (manual, live Zoom)

These require a live Zoom meeting and cannot be automated yet.
The 2026-07-05 rework changed the implementation under items 4–7 and 9 — all
of them need re-verification on the next live call.

### Test checklist (manual)

| # | Test | Expected | Status |
|---|---|---|---|
| 1 | Auto-demo navigates screen-shared browser before each narration | Orchestrator logs "Screen browser navigated" per step | PASS (2026-04-05) |
| 2 | Fallback to browser-controller when zoom-bot unreachable | E2E test passes, orchestrator logs fallback | PASS (test-e2e.sh section 5) |
| 3 | Demo flows without dead gaps between sections | Narration playback completion (PlayAudio response) paces steps | NEEDS RE-VERIFICATION (new pacing) |
| 4 | Filler words ("ok", "yeah") don't pause demo; "hello"/"hey" DO (attention-getters) | Orchestrator logs "Filler detected — ignoring" | NEEDS VERIFICATION (now unit-tested; verify live) |
| 5 | Duplicate STT transcripts are deduplicated | "Duplicate transcript — skipping"; filler-then-question is NOT eaten | NEEDS VERIFICATION (now unit-tested; verify live) |
| 6 | Interim STT results pause demo instantly AND cut narration audio | "paused (interim)" + StopAudio truncates playback within ~20ms chunks | NEEDS VERIFICATION |
| 7 | Brief interrupts ("I have a question") get instant ack | "Of course, go ahead", demo stays paused, watchdog resumes after 30s of silence | NEEDS VERIFICATION |
| 8 | Real questions answered by Claude, demo resumes | Claude responds, demo unpauses | NEEDS RE-VERIFICATION (new model) |
| 9 | "Show me the scan viewer again" navigates to that section | Claude sets the section JSON field, browser navigates | NEEDS VERIFICATION |
| 10 | CLOSE action ends demo | Claude chooses CLOSE, auto-demo stops | NEEDS RE-VERIFICATION |
| 11 | Bot does NOT answer its own narration (echo) | No self-triggered Q&A; "Own-speech echo detected" in logs at most | NEEDS VERIFICATION (new) |
| 12 | SDK death mid-call recovers | Container exits non-zero, compose restarts, bot rejoins with clean audio state | NEEDS VERIFICATION (new) |
| 13 | Claude API failure mid-call | Bot speaks the canned bridge line instead of ignoring the question | NEEDS VERIFICATION (new) |
| 14 | Barge-in mid-narration ("hold on" while the bot talks) pauses + cuts audio | Works with CAPTURE_DURING_PLAYBACK=true; watch for echo self-answers (see #11) | NEEDS VERIFICATION (new) |
| 15 | Google Meet mode end-to-end (join, share, narrate, Q&A) | Same checklist as Zoom, via `--profile meet` | NEEDS VERIFICATION (new) |
| 16 | Post-answer follow-up ("Did that answer your question?") + 5s hold | Prospect follow-up lands before narration resumes | NEEDS VERIFICATION (new) |

### Known issues history

- 2026-04-05: STT echo (bot transcribing its own TTS) — root causes fixed 2026-07-05
  (playback-window audio discarded instead of replayed; narration playback now goes
  through zoom-bot; orchestrator-side echo suppression). Verify live (#11).
- 2026-04-05: "Alex." classified as ANSWER — agent-name interrupt token now only
  fires on short utterances and echoes are suppressed first (unit-tested).
- 2026-04-05: partial+final duplicates caused double answers — dedup now normalized
  prefix matching AFTER filler filtering (unit-tested).
- 2026-06-15 (latent, found 2026-07-05): pinned Claude model retired — every
  question silently failed. Now: current model + preflight.sh catches this class.

## What's Not Yet Tested

- Firestore persistence writes (wired 2026-07-05; needs a GCP integration check)
- Zoom SDK integration (Linux only, needs live meeting)
- Load testing / concurrent sessions (Phase 4; NOTE: orchestrator enforces a
  single-session model — concurrent sessions are out of scope by design)
- Real BMA UI navigation (blocked on Scopio demo environment access)
- C++ patches compile check outside Docker (the SDK binaries are GCS-only; the
  zoom-bot image build is the compile gate)

## CI/CD

Not yet configured. Plan: GitHub Actions running `npm test` + `test-e2e.sh` on PR
(Redis service container + orchestrator + browser-controller).
