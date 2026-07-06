# Quick Start — ScopioLabs BPA Demo Agent

> Orientation for coming back to this project cold. Last updated 2026-07-06.
> Deep dives: [ARCHITECTURE.md](ARCHITECTURE.md) · [TESTING_POLICY.md](TESTING_POLICY.md) · [BACKLOG.md](BACKLOG.md)

## What this is

An autonomous AI sales agent that joins a video call, screen-shares the
ScopioLabs BMA demo page, narrates a 10-step scripted demo with a real voice,
and answers prospect questions live using Claude — pausing narration when
someone speaks and resuming after.

Seven microservices in Docker Compose on a GCP VM (`scopio-demo-agent`,
project `scopio-lab-bpa-demo`), plus:

- **zoom-bot** — joins Zoom via the Linux Meeting SDK (default mode)
- **meet-bot** — joins Google Meet via Playwright (`--profile meet`)
- **meeting-launcher** — web UI on :8080 to start/stop demos without SSH

## Running a demo

### 0. Preflight — always, before every call (~1 minute)

```bash
# on the VM: cd /opt/scopio first
bash scripts/preflight.sh
```

GO/NO-GO on the things that fail *silently* mid-demo: Claude model validity,
ElevenLabs quota/voice, Google STT auth, Zoom credentials, `.env`
completeness. This exists because a retired Claude model quietly broke all
Q&A for weeks.

### Zoom demo (the normal path)

```bash
# On the VM (/opt/scopio):
# 1. Put the meeting in .env:
#      ZOOM_MEETING_ID=...
#      ZOOM_MEETING_PASSWORD=...      (optional)
# 2. Start everything:
docker compose up --build -d
```

The bot joins, screen-shares the demo page, waits for its virtual mic to be
live, then auto-runs the 10-step demo. A VM reboot preserves your `.env`
edits (secrets are refreshed from Secret Manager; operator settings survive).

### Google Meet demo

```bash
# .env:
#   MEET_URL=https://meet.google.com/xxx-xxxx-xxx
#   DEMO_BROWSER_GRPC_ADDR=meet-bot:50057
docker compose --profile meet up --build -d
```

### No-SSH path: the meeting launcher

Web UI at `http://<VM-IP>:8080` (basic auth). Install once on the VM:

```bash
bash scripts/install-launcher.sh   # set LAUNCHER_PASS first, or it generates
                                   # one and prints it
```

Paste a meeting ID/URL, click start/stop. (Also available as a compose
profile: `docker compose --profile launcher up -d`.)

### Watching the call

Dashboard at `http://<VM-IP>:3000`. It auto-attaches to whatever session the
bot started and shows live state — NARRATING / PAUSED (and why), current
step, transcript. You can inject test questions from it as the "prospect".

## What happens on the call

1. Prospect speaks → narration cuts within ~20ms
2. Short attention-getters ("hold on", "hello?", "show me") get an instant
   "Of course, go ahead."
3. The actual question goes to Claude → the answer plays → "Did that answer
   your question?" → ~5s for follow-ups → narration resumes
4. "Show me the scan viewer again" navigates the shared screen
5. Nothing can freeze the demo: every pause auto-resumes after 30s; if Claude
   errors mid-call the bot speaks a bridge line instead of going silent

## Knobs (.env)

| Variable | Default | When to touch it |
|---|---|---|
| `MIN_CONFIDENCE` | `0.3` | Raise if garbage transcripts keep pausing the demo |
| `CAPTURE_DURING_PLAYBACK` | `true` | Set `false` if the bot ever answers its own voice (trades barge-in for hard echo suppression) |
| `AGENT_NAME` | `Alex` | Bot's name (interrupt patterns follow it) |
| `DEMO_LANGUAGE` | `en` | `en` or `fr` (script + voice) |
| `CLAUDE_MODEL` | `claude-sonnet-5` | Model swap without a code change |
| `ELEVENLABS_VOICE_ID` | Matilda (en) / Chloé (fr) | Voice override |

## Dev workflow

```bash
npm test                    # 41 unit tests, no keys/services needed
bash scripts/test-e2e.sh    # 18 checks (orchestrator + browser-controller running)
```

Tests before code — failing test first, then the fix. See
[TESTING_POLICY.md](TESTING_POLICY.md) for the pattern, the full suite table,
and the 16-item live-call checklist.

## Current status (2026-07-06)

- Full code-review fix pass merged (PR #1): retired-model swap, pause
  watchdogs, echo fixes, interruptible narration, STT stream rotation,
  container self-recovery, Firestore persistence wired, preflight script
- Google Meet bot + launcher merged (PR #2), modernized to the same
  narration/interrupt contract as the Zoom bot
- zoom-bot image (incl. patched C++) compile-verified on Cloud Build
- **Owed: one live verification call** — TESTING_POLICY checklist items,
  especially #11 (no echo self-answers), #14 (barge-in mid-narration), and
  #15 (Meet mode end-to-end)
