# Architecture — ScopioLabs BPA Demo Agent

> Last updated: 2026-04-04

## System Overview

An autonomous AI agent that joins a Zoom call, navigates the ScopioLabs FF-BMA application via browser automation, and conducts a structured 10-minute product demo with real-time voice interaction — without human intervention.

## Data Flow

```
Prospect speaks (Zoom call)
  → zoom-bot (captures audio)
  → stt-service (Google Cloud Speech-to-Text, streaming)
  → orchestrator (xstate FSM + context routing)
  → claude-wrapper (Claude Sonnet reasoning: ADVANCE / ANSWER / REPEAT / CLOSE)
  → orchestrator (updates state, dispatches actions)
  ├→ tts-service (ElevenLabs, streaming) → zoom-bot (plays audio to prospect)
  └→ browser-controller (Playwright) → ScopioLabs BMA UI (screen shared via Zoom)
```

## Services

| Service | Runtime | Port(s) | Responsibility |
|---|---|---|---|
| `orchestrator` | Node.js 20, Fastify, xstate | 3000 (HTTP), 50051 (gRPC) | Central state machine, coordinates all services, serves dashboard |
| `zoom-bot` | Node.js 20, Zoom Meeting SDK | — | Joins call, captures/plays audio, screen shares |
| `browser-controller` | Node.js 20, Playwright | 8090 (test page), 50053 (gRPC) | Drives BMA UI navigation |
| `stt-service` | Python 3.12, google-cloud-speech | 50056 (gRPC) | Streaming speech-to-text |
| `tts-service` | Node.js 20, ElevenLabs SDK | 50054 (gRPC) | Streaming text-to-speech |
| `claude-wrapper` | Node.js 20, Anthropic SDK | 50052 (gRPC) | AI reasoning + prompt management |
| `persistence` | Node.js 20, Firestore | 50055 (gRPC) | Call logs, transcripts, Q&A pairs |
| `redis` | Redis 7 | 6379 | Session state, conversation history (2hr TTL) |

## Inter-Service Communication

- **Internal:** gRPC on all service-to-service calls (protos in `proto/`)
- **External APIs:** HTTPS to Claude API, Google Cloud STT, ElevenLabs
- **Zoom:** WebSocket via Zoom Meeting SDK (Linux headless)
- **Dashboard:** HTTP served by orchestrator at `/` (same origin as API)

## gRPC Contracts

| Proto | RPC Methods |
|---|---|
| `orchestrator.proto` | `OnTranscription`, `OnParticipantEvent`, `StartSession`, `GetSessionStatus`, `EndSession` |
| `stt.proto` | `StreamAudio` (bidirectional streaming) |
| `tts.proto` | `Synthesize` (server-side streaming) |
| `browser.proto` | `ExecuteAction`, `Initialize`, `Screenshot`, `GetPageState` |
| `claude.proto` | `Decide` |
| `persistence.proto` | `SaveCall`, `AppendQA`, `AppendTranscript`, `GetCall`, `UpdateOutcome` |

## Orchestrator State Machine

```
idle → joining → presenting → ended
                     ↑    ↓
                   (loops on ADVANCE/ANSWER/REPEAT)
```

**States:** `idle` | `joining` | `presenting` | `error` | `ended`

**Events:** `START` | `PROSPECT_JOINED` | `ADVANCE` | `ANSWER` | `REPEAT` | `CLOSE` | `PROSPECT_LEFT` | `ERROR`

**Context:** callId, prospectName, currentStep (0-9), conversationHistory, stepsCompleted

In HTTP/manual mode, `joining` is auto-skipped (immediate `PROSPECT_JOINED` on session create).

## HTTP API (Orchestrator)

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/sessions` | Create new demo session |
| `GET` | `/api/sessions/:callId` | Get session status |
| `POST` | `/api/sessions/:callId/advance` | Advance to next demo step (triggers browser navigation) |
| `POST` | `/api/sessions/:callId/question` | Submit prospect question to Claude |
| `POST` | `/api/sessions/:callId/end` | End session |
| `GET` | `/health` | Health check |
| `GET` | `/` | Dashboard UI |
| `GET` | `/bma` | Test BMA page |

## Redis State Keys

```
session:{call_id}:state          → current FSM state
session:{call_id}:step           → current demo step index
session:{call_id}:history        → last 20 exchanges (list)
session:{call_id}:started_at     → timestamp
session:{call_id}:prospect_name  → extracted from intro
```

TTL: 2 hours per session. Redis is non-critical — orchestrator degrades gracefully if Redis is unavailable (session state lives in-memory via xstate actors).

## Firestore Schema

```
/calls/{call_id}
  - started_at: timestamp
  - ended_at: timestamp
  - prospect_name: string
  - zoom_meeting_id: string
  - steps_completed: number
  - outcome: 'completed' | 'dropped' | 'error'
  - transcript[]: { role, text, timestamp_ms }
  - qa_pairs[]: { question, answer, demo_step, timestamp_ms }
```

## Claude Integration

**Model:** `claude-sonnet-4-20250514`

**Decision flow:** Receives current demo step context + conversation history + prospect transcript. Returns one of:
- `ADVANCE` — proceed to next step
- `ANSWER` — respond to question, stay on current step
- `REPEAT` — re-explain current step
- `CLOSE` — wrap up the demo

**System prompt** includes: product knowledge (FDA clearance, imaging, AI capabilities, remote access, LIS integration), Q&A strategies for common questions, 2-3 sentence response limit, pricing redirect rules.

## Browser Controller

**Section map** — maps demo step sections to Playwright navigation actions:

| Section ID | Demo Step | Navigation |
|---|---|---|
| `home` | 0, 9 | page.goto(BMA_URL) |
| `overview` | 1 | click `[data-section="overview"]` or hash fallback |
| `scan_viewer` | 2 | click `[data-section="scan"]` |
| `ndc_panel` | 3 | click `[data-section="ndc"]` |
| `quantification` | 4 | click `[data-section="quantification"]` |
| `remote_access` | 5 | click `[data-section="remote"]` |
| `report_export` | 6 | click `[data-section="report"]` |
| `integration` | 7 | click `[data-section="integration"]` |
| `summary` | 8 | click `[data-section="summary"]` |

When no `BMA_URL` is set, serves a test HTML page at `:8090` with matching selectors.

## Infrastructure

### Current (POC — local)
- All services run directly on macOS (no Docker needed)
- Redis via Homebrew
- Test BMA page served locally by browser-controller

### Target (Phase 3 — GCP)
```
GCP Project:    scopio-lab-bpa-demo
Machine:        n2-standard-8 (8 vCPU, 32GB RAM)
OS:             Ubuntu 22.04 LTS
Region:         us-central1
Deployment:     Docker Compose
Secrets:        GCP Secret Manager
Persistence:    Firestore
STT:            Google Cloud Speech-to-Text API
```

### Future (Phase 4+ — Production)
- GKE cluster with per-service deployments
- Redis → Cloud Memorystore
- Autoscaling based on call queue depth
- Session affinity per call_id

## Port Assignments

| Port | Service | Notes |
|---|---|---|
| 3000 | Orchestrator HTTP | Dashboard + API |
| 6379 | Redis | Session state |
| 8090 | Test BMA page | Dev only (avoids 8080 conflict with video pipeline) |
| 50051 | Orchestrator gRPC | Internal |
| 50052 | Claude wrapper gRPC | Internal |
| 50053 | Browser controller gRPC | Internal |
| 50054 | TTS service gRPC | Internal |
| 50055 | Persistence gRPC | Internal |
| 50056 | STT service gRPC | Internal |

Ports 8001-8007 reserved (video automation pipeline). Port 8080 reserved (Cloud Run).

## Latency Budget

| Step | Target | Phase 2 Actual |
|---|---|---|
| STT (streaming) | ~200-300ms | ~4s (batch, includes audio stream time) |
| Orchestrator routing | ~20ms | included in Claude |
| Claude API (Sonnet) | ~400-800ms | ~2.6s (cold start, improves to ~600ms warm) |
| TTS first chunk | ~200-400ms | ~630ms |
| **E2E target** | **~1.0-1.7s** | **~7.1s (batch mode)** |

Real-time streaming STT will return results while prospect speaks, reducing perceived E2E latency to approximately Claude + TTS time (~1.2-1.4s warm).

## Phase Status

| Phase | Description | Status |
|---|---|---|
| 1 | Manual demo flow, browser nav, Claude Q&A, dashboard | DONE (2026-04-04) |
| 2 | Voice pipeline: STT → Claude → TTS, latency tracking | DONE (2026-04-04) |
| 3 | GCP deployment, Zoom SDK, Firestore, Docker Compose | DONE (2026-04-05) — bot joins Zoom, screen shares BMA page, auto-runs 10-step demo with Matilda voice, answers questions via Claude. Sync browser nav with narration next. |
| 4 | Error recovery, load testing, GKE migration | Backlog |
