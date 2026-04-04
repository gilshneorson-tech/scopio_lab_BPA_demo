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

## What's Not Yet Tested

- Unit tests for individual services (no test framework set up yet)
- Firestore persistence (Phase 3)
- Zoom SDK integration (Phase 3, Linux only)
- Load testing / concurrent sessions (Phase 4)
- Real BMA UI navigation (blocked on Scopio demo environment access)

## CI/CD

Not yet configured. Plan: GitHub Actions running `test-e2e.sh` on PR, with Redis as a service container.
