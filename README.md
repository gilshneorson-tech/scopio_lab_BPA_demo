# ScopioLabs BMA Autonomous Demo Agent

Autonomous AI agent that joins a Zoom call, navigates the ScopioLabs FF-BMA application via browser automation, and conducts a structured 10-minute product demo with real-time voice interaction — without human intervention.

## Architecture

```
Prospect audio (Zoom)
  → zoom-bot → stt-service (Google Cloud STT)
  → orchestrator (xstate FSM)
  → claude-wrapper (Claude Sonnet reasoning)
  → tts-service (ElevenLabs)
  → zoom-bot (plays audio)
  → browser-controller (Playwright)
  → ScopioLabs BMA UI
```

### Services

| Service | Port | Runtime | Responsibility |
|---|---|---|---|
| `orchestrator` | 3000/50051 | Node.js + xstate | Central state machine |
| `zoom-bot` | 50057 | Node.js + Zoom SDK (C++) | Joins Zoom call, audio in/out, screen share |
| `meet-bot` | 50057 | Node.js + Playwright | Joins Google Meet (alternative to zoom-bot; `--profile meet`) |
| `meeting-launcher` | 8080 | Node.js + Fastify | Operator web UI: set meeting, start/stop the bot |
| `claude-wrapper` | 50052 | Node.js + Claude API | AI reasoning |
| `browser-controller` | 50053 | Node.js + Playwright | BMA UI automation |
| `tts-service` | 50054 | Node.js + ElevenLabs | Text-to-speech |
| `persistence` | 50055 | Node.js + Firestore | Call logs |
| `stt-service` | 50056 | Python + Google Cloud STT | Speech-to-text |
| `redis` | 6379 | Redis 7 | Session state |

## Quick Start

```bash
# 1. Copy environment template
cp .env.example .env
# Fill in API keys: ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, Zoom credentials, etc.

# 2. (Zoom mode only) Provide the Zoom Meeting SDK
# The Linux SDK (services/zoom-bot/sdk/zoomsdk/) is NOT in git — download it
# from the Zoom marketplace (or GCS in prod; see scripts/gce-startup.sh).
# Without it, the zoom-bot image fails to build; all other services build fine.

# 3. Preflight external dependencies (catches expired keys / retired models)
bash scripts/preflight.sh

# 4. Start all services
docker compose up --build

# 5. Trigger a demo session
curl -X POST http://localhost:3000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"zoom_meeting_id": "123456789", "prospect_name": "Dr. Smith"}'

# 6. Manually advance steps, or run the full narrated demo
curl -X POST http://localhost:3000/api/sessions/{call_id}/advance
curl -X POST http://localhost:3000/api/sessions/{call_id}/auto-demo
```

## Project Structure

```
├── proto/                    # gRPC service definitions
│   ├── orchestrator.proto
│   ├── stt.proto
│   ├── tts.proto
│   ├── browser.proto
│   ├── claude.proto
│   └── persistence.proto
├── services/
│   ├── orchestrator/         # State machine + coordination
│   ├── zoom-bot/             # Zoom Meeting SDK integration
│   ├── browser-controller/   # Playwright BMA navigation
│   ├── stt-service/          # Google Cloud streaming STT (Python)
│   ├── tts-service/          # ElevenLabs streaming TTS
│   ├── claude-wrapper/       # Claude API + prompt management
│   └── persistence/          # Firestore call logging
├── config/                   # Demo script, port mapping
├── scripts/                  # Proto generation, utilities
├── docker-compose.yml
└── .env.example
```

## Implementation Phases

- **Phase 1** (wk 1–3): POC — Zoom join, Playwright nav, Claude API, manual triggers
- **Phase 2** (wk 4–6): Voice loop — Google Cloud STT, real-time Claude, ElevenLabs TTS
- **Phase 3** (wk 7–9): Full automation — FSM-driven demo, synced browser, screen share
- **Phase 4** (wk 10–12): Hardening — error recovery, load testing, GKE migration
- **Phase 5**: Google Meet support (`meet-bot`) + operator meeting launcher

### Google Meet mode

```bash
# .env: set MEET_URL, DEMO_BROWSER_GRPC_ADDR=meet-bot:50057
docker compose --profile meet up --build
```

### Meeting launcher (operator UI)

Web UI on :8080 to set the meeting URL/ID and start/stop the bot without SSH.
Run either as a compose profile (`docker compose --profile launcher up`) or as
a systemd service on the VM (`bash scripts/install-launcher.sh` — set
LAUNCHER_PASS, or a password is generated and printed).
