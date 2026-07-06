# Fix Plan — ScopioLabs BPA Demo Agent

> Produced 2026-07-05 by a full multi-agent code review (orchestrator, zoom-bot + C++ SDK patches,
> all peripheral services, infra/scripts/docs). This is the work plan for the follow-up fix session.

## ✅ STATUS (2026-07-05, same-day fix session)

**Implemented:** all of T0 items 1–3 and 5, all P0 items, all P1 items except the two noted
below, and the P2 sweep (dead code, docs, dashboard monitor mode, lockfiles via `npm ci`,
security hygiene). Verified: 36 unit tests green (`npm test`), 18/18 e2e checks green
(`bash scripts/test-e2e.sh` with orchestrator + browser-controller running locally),
dashboard exercised in a browser against a live auto-demo run.

**Deliberately NOT done (needs environment or scope decisions):**
- **P1.14 participant events** — `OnParticipantEvent` is handled orchestrator-side (LEFT now
  stops the auto-demo), but the zoom-bot never *sends* these events: it needs a
  `MeetingParticipantsCtrlEvent` C++ patch that isn't in the patch set. Highest-leverage
  remaining feature (wait for a human before narrating, greet by name, stop when empty).
- **P1 latency: Claude streaming + pre-synthesized narration** — Claude now has an 8s timeout,
  prompt caching, capped history, `latest_short` STT and `optimize_streaming_latency` TTS,
  but the wrapper still waits for the full completion before TTS, and narration is
  synthesized per step rather than pre-cached at session start. Both remain worthwhile.
- **T0.4 CI** — GitHub Actions workflow not added (needs a repo/actions decision).
- **C++ patches are not compile-checked here** — the Zoom SDK binaries are GCS-only; the
  zoom-bot Docker build is the compile gate. Build the image before the next call.
- **Live-call re-verification** — TESTING_POLICY.md Phase-3 checklist items marked
  NEEDS (RE-)VERIFICATION, especially echo (#11), SDK-death recovery (#12), interrupt cut (#6).

The original plan follows for reference.
>
> **How to use this plan:** Work phases in order (P0 → P1 → P2). Per `TESTING_POLICY.md` and the
> global test-first policy: for every fix, first write (or extend) a test that reproduces the bug,
> confirm it fails, then fix, then confirm it passes. Phase T0 (test scaffolding) is a prerequisite
> for most P0 items — do it first. Run `bash scripts/test-e2e.sh` before every commit touching
> orchestrator / browser-controller / claude-wrapper.

---

## P0 — Demo-breaking. Fix before the next live call.

### P0.1 Claude model is RETIRED — every question currently fails silently
`services/claude-wrapper/src/index.js:15` pins `claude-sonnet-4-20250514`, which retired
**June 15, 2026** (today is past that). Every `Decide` call 404s; the catch returns `WAIT` with
empty text, so on a live call the bot **silently ignores all prospect questions** and nothing on
the dashboard shows why.

- Replace with `claude-sonnet-5` (the official replacement for the retired ID).
- Migration gotchas for `claude-sonnet-5`:
  - Do **not** pass non-default `temperature`/`top_p`/`top_k` (400) and no `budget_tokens`.
  - Omitting `thinking` now runs **adaptive thinking by default** — for this voice pipeline's
    latency budget, set `thinking: {type: "disabled"}` explicitly (or adaptive + `output_config: {effort: "low"}` and measure).
  - New tokenizer: ~30% more tokens for the same text — irrelevant to correctness here but
    re-check `max_tokens`.
- Also update the model name in `ARCHITECTURE.md:110`.
- **Test:** extend `scripts/test-voice-loop.sh` (or new preflight, P0.9) with a 1-token live call
  asserting the configured model responds.

### P0.2 Pause deadlock family — demo freezes forever
`services/orchestrator/src/index.js` has multiple paths that set `demoState.paused = true` and
never resume, while the auto-demo loop (`:645-647`) spins on `paused` with **no timeout**:
- `:196-200` interim pauses; if the final is deduped (`:205-213`) or never arrives, paused stays true.
- `:251-273` interrupt-ack ("I have a question") pauses; if no follow-up question arrives, paused forever.
- `:342-351` on Claude error the pause is cleared but the question is ignored (see P1.6).

Fix shape:
- Add a **pause watchdog**: max pause duration (e.g. 30–45 s) after which the demo resumes with a
  bridge line ("Alright, let's continue…").
- Audit every early-return in `handleTranscription` and make the paused-state decision explicit.
- **Test (requires T0):** unit tests over the extracted transcript-decision module — "interim with
  no final resumes after watchdog", "interrupt-ack with silence resumes after watchdog".

### P0.3 Dedup swallows real questions (dedup runs BEFORE filler filter)
`services/orchestrator/src/index.js:205-214`: the dedup record is written before the filler check,
and matching is bidirectional substring (`a.includes(b)`). A filler final like "okay" is recorded;
"Okay, so how much does this cost?" within the 4 s window matches and is dropped as duplicate —
the question is never answered AND (per P0.2) the demo stays paused.

- Run dedup **after** filler filtering; never record fillers in the dedup window.
- Replace `includes()` containment with normalized equality (or prefix match with a minimum length).
- **Test (T0):** table tests — filler-then-question passes through; true partial/final duplicate
  ("Can we do it in five?" → "Can we do it in five minutes?") is still deduped.

### P0.4 Echo root causes — bot hears and answers itself
Two concrete bugs explain the known "STT echo" issue (BACKLOG "Partial"):
1. `services/zoom-bot/src/index.js:660-691`: the `isSpeaking` guard skips *processing* but never
   advances `lastSize`, so all meeting audio captured during TTS playback (including the bot's own
   voice) is **replayed into STT in one burst** when `isSpeaking` clears. Fix: on resume, set
   `lastSize = current file size` (discard the backlog).
2. Auto-demo narration **bypasses `isSpeaking` entirely**: the orchestrator writes narration PCM
   directly to the shared volume file (`orchestrator/src/index.js:630` → `/tmp/zoom-audio/tts-output.pcm`),
   so zoom-bot never knows the bot is speaking during narration and streams the echo to STT — the
   demo self-interrupts. Fix: give zoom-bot a "narration in progress" signal (orchestrator → zoom-bot
   gRPC call, or zoom-bot watches the tts file mtime/size to derive speaking state + duration).

Also: stale-audio replay at startup — `zoom-bot/src/index.js:662` (`lastSize` starts at 0, old
`meeting-audio.pcm` replays into STT on container restart) and `:627-630` + `ZoomSDKAudioSource.cpp:119-121`
(stale `tts-output.pcm` in the shared volume is **spoken into the next meeting** on join). Truncate
both files on `ZoomSDKBot.start()`.

- **Test:** manual live-call checklist items in TESTING_POLICY (items 4–7 are already "NEEDS
  VERIFICATION" — these fixes are what they've been waiting for) + unit-testable pieces where possible.

### P0.5 STT dies mid-demo — Google streaming ~5-minute hard limit
`services/stt-service/src/server.py:117-155`: Google's `streaming_recognize` is capped at ~305 s;
this is a **10-minute demo**. Mid-call the stream errors, the handler `context.abort`s (`:155`),
and transcription is dead unless the caller's reconnect logic saves it — every ~5 min there is a
guaranteed window where prospect audio is dropped.

- Implement a transparent reconnect loop inside the STT service (re-open the Google stream,
  carry the request iterator over), and stop `abort`ing on transient Google errors (`:155`).
- Also honor `AudioChunk.sample_rate` instead of hardcoding 32000 (`:89-95`) — the Phase-2
  voice-loop test sends 16 kHz and has been silently mis-decoded (see P1.9 / test fixes).
- **Test:** long-stream soak test (stream >6 min of audio, assert transcripts continue), plus a
  16 kHz fixture assertion in the voice-loop test.

### P0.6 browser-controller: every non-NAVIGATE action is broken (enum bug)
`services/browser-controller/src/index.js:174-177`: proto-loader is configured with `enums: String`
(`:165`), so `type` arrives as `"HIGHLIGHT"` etc.; the mapping expression indexes `[0]` for any
string and yields `'NAVIGATE'` — every HIGHLIGHT/SCROLL/CLICK/WAIT/SCREENSHOT request silently
executes NAVIGATE with `section: undefined`.

- Handle the string enum directly; validate against the known set.
- **Test:** e2e section exercising each ActionType round-trip through proto-loader.

### P0.7 Interrupts can't actually stop playback (C++ drains the file to completion)
`sdk-patches/ZoomSDKAudioSource.cpp:97-113` reads the entire utterance and plays it to completion;
there is no stop channel. Prospect interrupts → orchestrator "pauses" → up to ~30 s of already-written
narration keeps playing, and the Q&A answer **queues behind** the remaining bytes. This is the
sluggish-interrupt behavior from the live calls.

- Add a stop/abort signal the C++ send loop checks per 20 ms chunk (e.g. a control file or the
  truncate-detection fix in P0.8), truncating the pcm file on interrupt.
- Pair with `ZoomSDKAudioSource.cpp:73`: treat `fileSize < lastSize` (external truncation) as
  "reset lastSize = 0" instead of silently skipping the new utterance.

### P0.8 Two writers clobber the same virtual-mic file
Orchestrator (`index.js:630`) and zoom-bot (`index.js:629`) both `writeFileSync` (O_TRUNC) to
`/tmp/zoom-audio/tts-output.pcm` while the C++ reader tracks a byte offset. Narration vs Q&A answer
near a step boundary → garbled/truncated audio into the meeting.

- Move to an append-only protocol or per-utterance uniquely-named files consumed in order by the
  C++ loop (this also gives interrupts a clean "drop remaining queue" semantics for P0.7).
- Centralize the path (currently hardcoded in 4 places: zoom-bot ×2, orchestrator, `Zoom.cpp:280`)
  behind one env var.

### P0.9 SDK/process supervision — why MeetingFailCode 8 needs manual container recreate
- `zoom-bot/src/index.js:450-452`: SDK process `exit` only logs. Container stays "healthy" while the
  orchestrator narrates into a dead meeting. Fix: on SDK exit → end orchestrator session →
  `process.exit(1)` so Docker restarts cleanly (paired with the stale-pcm cleanup in P0.4).
- `sdk-patches/Zoom.h:83-110` / `Zoom.cpp:42-45`: `MEETING_STATUS_FAILED` / `ENDED` / `DISCONNECTING`
  are never handled — the C++ binary idles forever on fail code 8. Map them to `exit(code)`.
- `sdk-patches/Zoom.h:104-109`: **missing `else { startRawRecording(); }`** when
  `CanStartRawRecording()` succeeds — if the bot already has recording privilege, raw audio, the
  virtual mic, and screen share silently never start. (Upstream sample has this branch.)
- `docker-compose.yml`: add `restart: unless-stopped` policies, a zoom-bot healthcheck,
  `depends_on: condition: service_healthy` on orchestrator (zoom-bot currently `process.exit(1)`s
  if orchestrator isn't up yet — `:769-772`), and raise zoom-bot memory 1G → ≥3G (it runs Xvfb +
  PulseAudio + Zoom SDK + Node + headed Chromium at 1080p; OOM-kill mid-call is plausible).
- `services/zoom-bot/Dockerfile:93-111`: CMD chain leaves bash as PID 1 without `exec` — SIGTERM
  never reaches Node, so the bot never leaves the meeting on `docker stop` (ghost participant).
  End with `exec node src/index.js` (+ `init: true` in compose).

### P0.10 GCE reboot wipes the operator's .env
`scripts/gce-startup.sh:76-99` regenerates `.env` from scratch on every boot, blanking
`ZOOM_MEETING_ID`, `ZOOM_MEETING_PASSWORD`, `BMA_URL/USERNAME/PASSWORD`, `DEMO_LANGUAGE`, voice ID
(none are in Secret Manager). A GCP maintenance reboot before a call = bot in standby, operator
SSHing mid-call. Also `:49` — `git pull` under `set -e` aborts the whole startup (nothing starts)
on any dirty tree. Fix: only write `.env` if absent (or merge, preserving operator-set keys), and
use `git fetch && git reset --hard origin/main` with failure tolerance.

---

## P1 — High priority: correctness + latency + resilience

### Latency (target E2E 1.2–1.7 s; currently ~7 s)
1. **Stream Claude responses** — `claude-wrapper/src/index.js:30-35` uses non-streaming
   `messages.create`; the pipeline waits for the full completion before TTS starts. Biggest single
   lever. Restructure so speakable text streams to TTS sentence-by-sentence, with the action
   decided via structured output (see P1.5).
2. **Claude request timeout** — `claude-wrapper/src/index.js:17,30`: SDK default is 10 min.
   Set per-request timeout ~8 s (TS SDK timeouts are in **ms**), `maxRetries: 1`. A hung request
   currently = minutes of dead air (and, via E1, a frozen transcript RPC).
3. **Prompt caching** — add `cache_control: {type: "ephemeral"}` on the static system prompt
   (as a content-block array). Note the minimum cacheable prefix (~2048 tokens on Sonnet 5) — if
   the prompt is smaller it silently won't cache; consider caching tools+system together.
4. **Pre-synthesize narration** — the 10 step scripts are static per language; synthesize all of
   them at session start (or build time) and cache the PCM. Removes per-step ElevenLabs latency,
   cost, and a whole class of mid-demo TTS failures. (`orchestrator/src/index.js:610-624`)
5. **STT tuning** — `stt-service/src/server.py:94`: `latest_long` → `latest_short` (or v2 API with
   voice-activity events) for faster `is_final` after end-of-speech; process all
   `response.results`, not just `[0]` (`:126`).
6. **TTS tuning** — `tts-service/src/index.js:54-58`: set `optimize_streaming_latency: 3-4`;
   consider `eleven_flash_v2_5`. Add one quick retry on 429/5xx.
7. **gRPC deadlines everywhere** — orchestrator `claudeDecide`, `ttsSynthesize`,
   `browserExecuteAction`, `browserInitialize` have **no deadlines** (`orchestrator/src/index.js:91-114`);
   only `demoBrowserNavigate` has one. A hung TTS stream blocks the auto-demo step forever
   (`:620` — `stop` can't even be observed while awaiting).

### Correctness / robustness
8. **Auto-demo step divergence** — the loop keeps a local `stepIdx` (`orchestrator/src/index.js:601`)
   while Claude-driven ADVANCE (`:303-304`) and HTTP `/advance` (`:489`) also move the machine →
   double-advance, narration out of sync with state/browser. Loop must re-read
   `actor.getSnapshot().context.currentStep` each iteration (or own ADVANCE exclusively while running).
9. **Lifecycle teardown** — `EndSession` (gRPC `:420-430`) and `POST /:callId/end` (`:687-695`)
   don't stop a running auto-demo (keeps narrating a dead call); the loop's
   `finally { autoDemos.delete(callId) }` (`:669`) can delete a *newer* demo's state after
   stop-then-restart (fix: compare-and-delete). Clear `recentTranscripts`/`lastInterruptAck` on end.
   Mirror the gRPC clean-slate sweep in HTTP `POST /api/sessions` (`:437-454`) — currently it
   accumulates actors indefinitely.
10. **Resume-timing race** — `orchestrator/src/index.js:321-329` estimates answer playback as
    `response_text.length * 60` from when the orchestrator returns, racing actual TTS synthesis +
    playback; the next step's narration clobbers the answer. Proper fix: a "TTS playback finished"
    callback/RPC from zoom-bot (pairs with P0.8's per-utterance file protocol).
11. **AGENT_NAME hardcoded in interrupt patterns** — `orchestrator/src/index.js:168` hardcodes
    "alex" while the name is configurable (`:592`); also the scripted narration says "I'm Alex"
    (`demo-machine.js:29`), so echoed narration containing "alex" triggers the interrupt-ack — the
    bot interrupts itself. Build patterns from `AGENT_NAME`, and don't let the ack path fire on the
    bot's own recently-spoken text. Review broad tokens (`\bwait\b` matches "can't wait to see…").
12. **Filler cancels an interrupt hold** — `orchestrator/src/index.js:222-237`: "yeah" after
    "sorry to interrupt" unpauses and talks over the prospect. Filler should only unpause a pause
    that the interim path itself caused.
13. **Fragile Claude JSON parsing with dangerous fallback** — `claude-wrapper/src/index.js:41-61`:
    greedy `/\{[\s\S]*\}/` regex; on parse failure the **raw model output (up to 500 chars) is
    spoken to the prospect**. Use structured outputs (`output_config.format` json_schema) or a
    strict tool schema; never route unparsed text to TTS. Make `action` a proto enum
    (`proto/claude.proto`) including an explicit WAIT, and change the API-error fallback from
    silent WAIT to a canned spoken ANSWER ("Good question — let me come back to that").
14. **Auto-demo start signal** — `zoom-bot/src/index.js:794-808`: fixed 10 s timer, no `res.ok`
    check, no retry; slow join/waiting room = narration into an empty room or demo never starts.
    Trigger from the SDK's raw-recording/mic-ready events (already parsed at `:437`) and retry the
    HTTP call. Wire **OnParticipantEvent** (proto exists, never used) so the demo can wait for a
    human, greet the prospect, and stop when everyone leaves — highest-leverage missing feature.
15. **Persistence is fully implemented but never called** — `orchestrator` creates
    `persistenceClient` (`index.js:52`) and never uses it; no call is ever logged to Firestore
    despite docs/backlog claiming DONE. Before wiring it in, fix the service itself:
    - `persistence/src/index.js:20-32`: `saveCall` with merge still overwrites `transcript`/`qa_pairs`
      with `[]` on a second call — only set provided fields.
    - `:34-55`: `ref.update()` NOT_FOUND race when appends beat the initial SaveCall — use
      `set(..., {merge:true})` or ensure-doc.
    - `:46-55`: per-utterance `arrayUnion` on one doc → 1 write/s/doc contention, 1 MiB doc limit,
      and arrayUnion dedupes identical entries (corrupts transcripts). Move transcript/QA to a
      subcollection `calls/{id}/transcript/{autoId}`.
    - `:57-61,115-127`: convert Firestore `Timestamp` → `.toMillis()` before gRPC int64 response.
    Then wire orchestrator: SaveCall on session start, AppendTranscript on final transcripts +
    answers, AppendQA on ANSWER, UpdateOutcome on end.
16. **Playwright click timeouts** — both navigation paths use the default 30 s click timeout with
    hash-fallback after (`zoom-bot/src/index.js:329-331`, `browser-controller/src/index.js:72-102`).
    Against the real BMA UI (no `data-section` attributes) every step stalls 30 s mid-narration.
    Pass `{timeout: 1000}` or check `locator.count()` first.
17. **Browser crash recovery** — neither zoom-bot's DemoBrowser (`:305-342`) nor browser-controller
    (`:107`) recovers a crashed/disconnected Chromium; the screen share freezes for the rest of the
    demo. Listen for `browser.on('disconnected')` and relaunch; propagate real failure from the
    DemoBrowser gRPC handler (`:351-365` currently returns success even when nav failed, defeating
    the orchestrator's fallback).
18. **TTS silent-failure signaling** — `tts-service/src/index.js:42-46,78-83`: missing API key or
    mid-synthesis error just `call.end()`s — indistinguishable from success; with orchestrator
    skipping the speech-wait on zero chunks, an invalid ElevenLabs key produces a silent demo that
    races through all 10 steps. Emit a gRPC error (`call.destroy(err)`); handle `call.on('cancelled')`
    with an AbortController to stop wasted synthesis on barge-in.
19. **C++ thread-safety crashes** — `ZoomSDKAudioSource.cpp:25-32`: second `onMicStartSend`
    (mute/unmute, VoIP reconnect) assigns to a joinable `std::thread` → `std::terminate()` kills the
    SDK mid-meeting. Guard it. Also `:39-43,98-105`: `m_sender` nulled while sendLoop may be using
    it (use-after-free on leave) — make it atomic/mutex-protected; don't `sleep(2)` on the SDK
    callback thread (`Zoom.cpp:297`).
20. **Serialize speech** — `zoom-bot/src/index.js:566-597`: concurrent `speakResponse` calls
    overlap synthesis and clear `isSpeaking` early; queue utterances. Queue (don't drop) final
    transcripts that arrive while `isSpeaking` (`:517`). Per-call in-flight lock for Claude
    decisions in the orchestrator (`:277-312`) to prevent double answers.

---

## P2 — Quality, hygiene, docs

### Dead code / config traps (delete or wire in)
- `config/demo-script.json` — dead; real script lives in `orchestrator/src/demo-machine.js`.
  Editing the JSON (the intuitive place during demo prep) changes nothing. Make demo-machine load
  it, or delete it. Same for `duration_sec` (defined twice, used never — see also P1: qa_open step
  should actually hold for its duration instead of rushing to close).
- `config/grpc-ports.json` — referenced by nothing; ports duplicated per service. Wire in or delete.
- `scripts/generate-proto.sh` + gitignored `src/generated/` — nothing uses them (proto-loader at
  runtime everywhere; Python self-generates). Delete, and move Python stub generation from
  container startup (`server.py:40-70`) into the Dockerfile build.
- `zoom-bot/src/zoom-auth.js` — imported, never called. Delete or document.
- `zoom-bot/src/index.js:460-507` `connectAudioSocket()` — dead (SDK 7.0 crash), contains its own
  rotting echo logic. Delete or gate explicitly.
- `sdk-patches/unmute-after-voip.patch` — stale, never applied, contradicts `Zoom.cpp`. Delete.
- Orchestrator: unused `mkdirSync`/`existsSync` imports (and B6: actually `mkdirSync` the TTS dir —
  ENOENT is currently swallowed → fully silent demo); `redis.js` `clearSession` dead (wire into
  EndSession; use SCAN not KEYS); `demoMachine` `conversationHistory` context duplicates Redis and
  is unbounded — pick one. Cap conversation history sent to Claude (`claude-wrapper:89-99`).

### Consistency / config
- **Voice-ID chaos** (5 sources of truth): gce-startup pins Rachel, `.env.example`/tts default
  Matilda, zoom-bot test path Rachel / Q&A path Matilda, ARCHITECTURE says Matilda. Narration and
  Q&A can speak in different voices. One env var, one default, documented. Move language→voice
  mapping (`claude-wrapper/src/system-prompt.js:14-17` VOICE_IDS — exported, never used
  cross-process) into tts-service keyed off `DEMO_LANGUAGE`.
- `.env.example` vs reality: add `AUTO_DEMO`, `PROSPECT_NAME`; remove/fix the
  `GOOGLE_APPLICATION_CREDENTIALS=/secrets/...` red herring (compose never mounts /secrets).
- Section list duplicated in system-prompt (`:104`) vs SECTION_MAP in two browser implementations —
  single source of truth.
- Xvfb geometry hardcoded in 3 places (`Zoom.cpp:340`, zoom-bot Dockerfile `:109`, viewport `:317`).

### Security hygiene
- `zoom-bot/src/index.js:404-416`: URL-encode the meeting password in the join URL; escape TOML
  interpolation; chmod 600 `/tmp/zoom-config.toml`; stop logging the full join URL with password.
- `scripts/test-voice-loop.sh:17`: keys via argv (visible in `ps`/history) → env only.
- Dashboard `config/dashboard.html:168`: `innerHTML` injection of Claude output → use textContent.

### Build reproducibility
- No lockfiles in any service Dockerfile; bare `npm install --production` with caret ranges —
  builds can drift the night before a demo. Commit per-service `package-lock.json`, use
  `npm ci --omit=dev`. Use `npx playwright install --with-deps chromium` (manual dep list is
  missing `libxkbcommon0`). Fix the stale-apt-cache split RUN in zoom-bot Dockerfile (`:49-69`).
  Pin/migrate the deprecated `elevenlabs` npm package (superseded by `@elevenlabs/elevenlabs-js`).
- zoom-bot Dockerfile: wait for the X socket (`/tmp/.X11-unix/X99`) before starting Node; don't
  `2>/dev/null` every PulseAudio step.
- Zoom SDK build requirement (gitignored `services/zoom-bot/sdk/zoomsdk/`) breaks README Quick
  Start on fresh clones — document it or make zoom-bot a compose profile.

### Dashboard (operator visibility on live calls)
Currently a driver, not a monitor: never polls `GET /api/sessions/:id`, so a real Zoom session
shows "No active session"; no step/pause/interrupt state, no live transcript. Auto-Play button
loops manual `/advance` instead of the real `/auto-demo` endpoints; reads a `script` field the API
doesn't return; `endSession()` unhandled errors; hardcoded English step list drifts under fr.
Minimum viable: poll session status + show state/step/paused + append live transcript entries.
This is the operator's only window into a live call — worth doing properly.

### Docs drift (fix in one pass)
- README: Deepgram → Google Cloud Speech (4 places incl. `DEEPGRAM_API_KEY`); add zoom-bot to the
  service table; document the SDK download prerequisite.
- ARCHITECTURE: add DemoBrowser gRPC (port 50057) and `/auto-demo` endpoints; update model name;
  note Redis-degraded mode loses conversation history.
- BACKLOG: "Sync browser navigation" and "Auto-advancing demo" both shipped — mark DONE;
  reconcile Phase-3 dates.
- TESTING_POLICY: expected count 14 → 17 for test-e2e.sh; de-flake step 5 (asserts the 10-step
  loop takes >3 s, which is false without TTS — assert `steps_completed` progression instead).

---

## T0 — Test scaffolding (prerequisite; do before/alongside P0)

Global policy: tests before code. The repo has zero unit tests and the last six commits all
modified interrupt/filler/dedup logic that only manual live calls exercise. Ordered by ROI:

1. **Extract the transcript-decision pipeline into a pure module** (filler filter, dedup,
   interrupt patterns, confidence gate, cooldown, pause-state decisions) out of
   `handleTranscription`, and table-test it with `node:test` (zero new deps). Every P0.2/P0.3/P1.11/
   P1.12 fix lands with a failing-then-passing test here. This converts every future live-call fix
   into a same-day regression test.
2. **`scripts/preflight.sh`** — run before every demo and in gce-startup: 1-token Anthropic call
   with the configured model (would have caught the retired model **before** a live call),
   ElevenLabs synth returns >0 bytes, Google STT round-trip on a committed fixture, Zoom token
   mint, `.env` completeness (meeting ID, voice ID). Targets the expired-external-resource failure
   class no in-repo test can catch.
3. **Fix the voice-loop test** — honor chunk sample_rate (P0.5), assert transcribed text matches
   the spoken fixture, assert output audio duration > 0, keys from env.
4. **CI: GitHub Actions running test-e2e.sh** (Redis service container + orchestrator +
   browser-controller), after de-flaking step 5 and syncing the expected count.
5. **Failure-injection checks** — compose-config assertions (restart policies, healthchecks,
   depends_on, memory limits), a chaos script that kills the SDK process and asserts rejoin,
   gce-startup idempotency (run twice; operator `.env` values survive).

---

## Suggested session breakdown for the fix work

| Session | Scope |
|---|---|
| 1 | T0.1 + P0.1 (model swap) + P0.2 + P0.3 (pause/dedup family, with unit tests) |
| 2 | P0.4 + P0.7 + P0.8 (audio pipeline: echo, interrupt stop, file protocol) + P1.10, P1.20 |
| 3 | P0.5 (STT reconnect + sample rate) + P0.6 (enum) + P0.9 + P0.10 (supervision/deploy) + T0.2 preflight |
| 4 | P1 latency batch (Claude streaming/timeout/caching, pre-synth narration, STT/TTS tuning, deadlines) |
| 5 | P1.8/9 (loop/lifecycle), P1.13 (structured output), P1.14 (participant events), P1.15 (persistence) |
| 6 | P2 sweep: dead code, docs, dashboard, lockfiles, security hygiene + T0.4 CI |

Each session: sync `git log` vs the test suite first, write/extend tests, fix, run
`scripts/test-e2e.sh` (and voice-loop where relevant), update `TESTING_POLICY.md`, commit.
