# Backlog — ScopioLabs BPA Demo Agent

## Blocked — Waiting on External

| Item | Blocker |
|---|---|
| Real BMA UI selectors in browser-controller | Need Scopio demo environment URL + credentials |
| Branded agent voice | Decide: use ElevenLabs default (Rachel) or create custom Scopio voice |

## High Priority — Polish Live Demo

| Item | Status | Notes |
|---|---|---|
| Sync browser navigation with narration | Not started | Screen share shows BMA page but nav doesn't advance in step with auto-demo. Zoom-bot's local Playwright needs to navigate on each step. |
| Reduce STT echo during TTS playback | Partial | isSpeaking flag helps but bot still picks up fragments of its own voice |
| Fix MeetingFailCode 8 on meeting switch | Workaround | Full container recreate (down+up) fixes stale SDK state. Don't use restart. |

## Phase 3 — GCP Deployment (DONE 2026-04-04)

| Item | Status |
|---|---|
| Deploy to GCP n2-standard-8 via Docker Compose | DONE |
| Secret Manager for all API keys | DONE |
| Firestore database created | DONE |
| Xvfb + PulseAudio in Docker | DONE |
| Production Dockerfiles with health checks | DONE |
| Firewall rules (port 3000 open) | DONE |
| Zoom Meeting SDK C++ binary in Docker | DONE |
| Bot joins live Zoom calls | DONE |
| Audio capture from Zoom meeting | DONE |
| Voice pipeline on live call (STT → Claude → TTS) | DONE |
| Screen share (Xvfb display via StartMonitorShare) | DONE |
| C++ virtual mic (IZoomSDKVirtualAudioMicEvent) | DONE |
| Auto-demo (10-step scripted narration) | DONE |
| Multi-language scripts (en/fr) | DONE (French voice quality insufficient, English only for now) |
| Playwright browser on Xvfb for screen share content | DONE |

## Phase 4 — Hardening

| Item | Status |
|---|---|
| Auto-advancing demo (timed steps, not just manual triggers) | Not started |
| Error recovery (STT silence detection, browser crash restart) | Not started |
| Prospect drop detection (Zoom SDK event) | Not started |
| Graceful fallback for unknown questions | Partially done (Claude handles it) |
| Load testing single instance | Not started |
| GKE migration plan | Not started |
| CI/CD pipeline (GitHub Actions running test-e2e.sh) | Not started |
| Unit tests per service | Not started |

## Open Questions

| Question | Status |
|---|---|
| Does BMA require authentication? | Unknown — need test credentials from Scopio |
| What URL is BMA served from? | Unknown — cloud-hosted vs on-prem |
| Real scan or pre-loaded demo case? | Need "golden case" from Scopio sales team |
| Agent name? | Currently "Alex" (configurable via AGENT_NAME env var) |
| Legal: AI disclosure to prospect? | Undecided |
| Swap ElevenLabs key before production | TODO — currently sharing with video pipeline |

## Demo Script (10 minutes)

| Step | Time | Topic | Screen Section |
|---|---|---|---|
| 0 | 0:00–0:45 | Intro + agenda | home |
| 1 | 0:45–1:30 | The BMA problem today | overview |
| 2 | 1:30–3:00 | Full-Field imaging at 100x | scan_viewer |
| 3 | 3:00–4:30 | AI differential count | ndc_panel |
| 4 | 4:30–5:30 | M:E ratio + megakaryocyte count | quantification |
| 5 | 5:30–6:30 | Remote access + collaboration | remote_access |
| 6 | 6:30–7:30 | Digital report generation | report_export |
| 7 | 7:30–8:30 | LIS / LIMS integration | integration |
| 8 | 8:30–9:30 | Q&A open floor | summary |
| 9 | 9:30–10:00 | Close + next steps | home |

## Strategic Q&A Knowledge Base

| Prospect Question | Agent Response Strategy |
|---|---|
| "How does this compare to manual?" | Acknowledge limitations, position as additive AI support |
| "What about our LIS integration?" | Confirm compatibility, offer integration team follow-up |
| "HIPAA / data security?" | Secure hospital network, data stays within network |
| "Turnaround time improvement?" | Remote access removes transport lag, AI pre-classification speeds review |
| "What scanners do we need?" | X100 or X100HT — same as peripheral blood smear |
| "Is this FDA cleared?" | Yes — first-ever digital BMA application clearance |
| "Implementation?" | Scopio team + Beckman/Siemens facilitates |
| "Pricing?" | Redirect to account team for formal quote |
| "Can we try with our own slides?" | Yes — free digital image review, done remotely |

## Core Talking Points

### Product
- World's first FDA-cleared digital BMA application
- Full-field imaging at 100x — no FOV vs resolution compromise
- AI: NDC, M:E ratio, megakaryocyte count
- Hundreds of cells vs manual 200–500 cell sampling
- Reduces inter-observer variability
- Beckman Coulter and Siemens Healthineers distribution

### Remote Access
- Hematopathologists review remotely via secure hospital network
- No physical slide transport
- Enables second opinions, consultations, flexible staffing

### Digital Workflow
- Shareable, traceable digital reports
- Consistent and repeatable results
- LIS/LIMS integration
- Eliminates glass slide breakage and misidentification

## Latency Budget (target)

| Step | Target | Phase 2 Actual |
|---|---|---|
| Zoom audio capture + VAD | ~100ms | N/A (no Zoom yet) |
| STT (Google Cloud streaming) | ~200–300ms | ~4s (includes audio stream time) |
| Orchestrator routing | ~20ms | included in Claude time |
| Claude API (Sonnet, streaming) | ~400–800ms | ~2.6s (will improve with warm connections) |
| TTS (ElevenLabs streaming) | ~200–400ms | ~630ms first chunk |
| Zoom audio playback start | ~100ms | N/A |
| **Total target** | **~1.0–1.7s** | **~7.1s (batch mode, not streaming)** |

## Infrastructure

### POC (Phase 3)
- GCP project: `scopio-lab-bpa-demo`
- Machine: n2-standard-8 (8 vCPU, 32GB RAM)
- OS: Ubuntu 22.04 LTS
- Region: us-central1
- Deployment: Docker Compose

### Production (Phase 4+)
- GKE cluster
- Redis → Cloud Memorystore
- Autoscaling based on call queue depth
- Session affinity per call_id

## Key Dependencies

| Package | Service | Purpose |
|---|---|---|
| `playwright` | browser-controller | BMA UI automation |
| `@anthropic-ai/sdk` | claude-wrapper | Claude API |
| `google-cloud-speech` | stt-service | Speech-to-text |
| `elevenlabs` | tts-service | Text-to-speech |
| `xstate` | orchestrator | State machine |
| `fastify` | orchestrator | HTTP API |
| `ioredis` | orchestrator | Redis client |
| `@google-cloud/firestore` | persistence | Call logging |
| `@grpc/grpc-js` | all Node services | Inter-service comms |
