#!/usr/bin/env bash
set -euo pipefail

# ─── Phase 2 Voice Loop Test ───
# Tests: STT → Orchestrator → Claude → TTS end-to-end
#
# Prerequisites:
#   - Redis running on :6379
#   - STT service on :50056 (Google Cloud STT)
#   - TTS service on :50054 (ElevenLabs)
#   - Claude wrapper on :50052
#   - Orchestrator on :3000/:50051
#   - Browser controller on :8090/:50053
#   - ffmpeg
#
# Usage: ELEVENLABS_API_KEY=... bash scripts/test-voice-loop.sh
#   (keys come from the environment or .env — NEVER from argv, which is
#    visible in `ps` output and shell history)

cd "$(dirname "$0")/.."
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

ELEVENLABS_KEY="${ELEVENLABS_API_KEY:-}"
OUTPUT_DIR="/tmp/scopio_audio"
TEST_AUDIO="/tmp/scopio_test_question.pcm"
VOICE_ID="${ELEVENLABS_VOICE_ID:-XrExE9yKIg1WjnnlVkGX}"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

for tool in ffmpeg curl python3; do
  command -v "$tool" >/dev/null 2>&1 || { red "Missing required tool: $tool"; exit 1; }
done

bold "═══════════════════════════════════════════"
bold "  ScopioLabs BMA — Phase 2 Voice Loop Test"
bold "═══════════════════════════════════════════"
echo ""

# ─── Step 1: Generate test audio using TTS ───
bold "1. Generating test audio (TTS → PCM)"

if [ -z "$ELEVENLABS_KEY" ]; then
  red "   ELEVENLABS_API_KEY not set — cannot generate test audio"
  echo "   Usage: ELEVENLABS_API_KEY=... bash scripts/test-voice-loop.sh"
  exit 1
fi

# Use ElevenLabs API directly to generate a test question
QUESTION="Is this FDA cleared and what does that mean for our lab?"

HTTP_CODE=$(curl -sf -o /tmp/scopio_test_raw.mp3 -w "%{http_code}" \
  -X POST "https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}" \
  -H "xi-api-key: $ELEVENLABS_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$QUESTION\", \"model_id\": \"${TTS_MODEL:-eleven_turbo_v2}\"}" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] && [ -s /tmp/scopio_test_raw.mp3 ]; then
  # Convert to 16kHz 16-bit mono PCM (the zoom-bot file mode sends
  # sample_rate=16000 and the STT service now honors it)
  ffmpeg -y -i /tmp/scopio_test_raw.mp3 -f s16le -ar 16000 -ac 1 "$TEST_AUDIO" 2>/dev/null
  AUDIO_SIZE=$(wc -c < "$TEST_AUDIO" | tr -d ' ')
  DURATION=$(python3 -c "print(f'{$AUDIO_SIZE / 32000:.1f}')")
  green "   Generated: $TEST_AUDIO ($AUDIO_SIZE bytes, ${DURATION}s)"
else
  red "   Failed to generate test audio (HTTP $HTTP_CODE)"
  echo "   Check your ElevenLabs API key"
  exit 1
fi
echo ""

# ─── Step 2: Run voice loop ───
bold "2. Running voice loop (STT → Claude → TTS)"
echo "   Input: \"$QUESTION\""
echo ""

mkdir -p "$OUTPUT_DIR"
LOOP_LOG=$(mktemp)

# Run zoom-bot in audio file mode
AUDIO_INPUT_FILE="$TEST_AUDIO" \
AUDIO_OUTPUT_DIR="$OUTPUT_DIR" \
AUDIO_OUTPUT=file \
ORCHESTRATOR_GRPC_ADDR=localhost:50051 \
STT_GRPC_ADDR=localhost:50056 \
TTS_GRPC_ADDR=localhost:50054 \
perl -e 'alarm 45; exec @ARGV' node services/zoom-bot/src/index.js 2>&1 | tee "$LOOP_LOG" || true

echo ""

# ─── Step 3: Check results ───
bold "3. Results"
FAIL=0

# 3a. STT transcription must resemble the spoken question — this catches
# sample-rate/config regressions where STT "works" but produces garbage
TRANSCRIBED=$(grep -o '"text":"[^"]*"' "$LOOP_LOG" | head -3 | tr '[:upper:]' '[:lower:]' || true)
if echo "$TRANSCRIBED" | grep -q "fda"; then
  green "   STT transcribed the question (contains 'FDA')"
else
  red "   STT transcript does not match the spoken question:"
  echo "   $TRANSCRIBED"
  FAIL=1
fi

# 3b. TTS output audio must exist and be non-trivial
OUTPUT_FILES=$(find "$OUTPUT_DIR" -name "*.pcm" -newer "$TEST_AUDIO" 2>/dev/null | head -5)

if [ -n "$OUTPUT_FILES" ]; then
  green "   TTS audio output files:"
  for f in $OUTPUT_FILES; do
    SIZE=$(wc -c < "$f" | tr -d ' ')
    DUR=$(python3 -c "print(f'{$SIZE / 32000:.1f}')")
    echo "   - $f ($SIZE bytes, ${DUR}s)"
    if [ "$SIZE" -lt 8000 ]; then
      red "   Output audio suspiciously short (<0.25s)"
      FAIL=1
    fi
  done
else
  red "   No TTS output audio found in $OUTPUT_DIR"
  FAIL=1
fi
echo ""

# 3c. Latency report should have been printed by the voice loop
if grep -q "Voice Loop Latency Report" "$LOOP_LOG"; then
  green "   Latency report produced (see above)"
else
  red "   No latency report — the loop did not complete"
  FAIL=1
fi

rm -f "$LOOP_LOG"

bold "═══════════════════════════════════════════"
if [ "$FAIL" -eq 0 ]; then
  green "  VOICE LOOP PASSED"
else
  red "  VOICE LOOP FAILED"
fi
bold "═══════════════════════════════════════════"
exit "$FAIL"
