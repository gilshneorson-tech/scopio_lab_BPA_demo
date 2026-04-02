# ScopioLabs BMA Autonomous Demo Agent

Autonomous AI agent that joins a Zoom call, navigates the ScopioLabs FF-BMA application via browser automation, and conducts a structured 10-minute product demo with real-time voice interaction — without human intervention.

## Architecture

```
Prospect audio (Zoom)
  → zoom-bot → stt-service (Deepgram)
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
| `claude-wrapper` | 50052 | Node.js + Claude API | AI reasoning |
| `browser-controller` | 50053 | Node.js + Playwright | BMA UI automation |
| `tts-service` | 50054 | Node.js + ElevenLabs | Text-to-speech |
| `persistence` | 50055 | Node.js + Firestore | Call logs |
| `stt-service` | 50056 | Python + Deepgram | Speech-to-text |
| `redis` | 6379 | Redis 7 | Session state |

## Quick Start

```bash
# 1. Copy environment template
cp .env.example .env
# Fill in API keys: ANTHROPIC_API_KEY, DEEPGRAM_API_KEY, ELEVENLABS_API_KEY, etc.

# 2. Start all services
docker compose up --build

# 3. Trigger a demo session
curl -X POST http://localhost:3000/api/sessions \
  -H 'Content-Type: application/json' \
  -d '{"zoom_meeting_id": "123456789", "prospect_name": "Dr. Smith"}'

# 4. Manually advance demo steps (Phase 1)
curl -X POST http://localhost:3000/api/sessions/{call_id}/advance
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
│   ├── stt-service/          # Deepgram streaming STT (Python)
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
- **Phase 2** (wk 4–6): Voice loop — Deepgram STT, real-time Claude, ElevenLabs TTS
- **Phase 3** (wk 7–9): Full automation — FSM-driven demo, synced browser, screen share
- **Phase 4** (wk 10–12): Hardening — error recovery, load testing, GKE migration
