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
#
# Usage: bash scripts/test-voice-loop.sh [ELEVENLABS_API_KEY] [ANTHROPIC_API_KEY]

ELEVENLABS_KEY="${1:-${ELEVENLABS_API_KEY:-}}"
ANTHROPIC_KEY="${2:-${ANTHROPIC_API_KEY:-}}"
OUTPUT_DIR="/tmp/scopio_audio"
TEST_AUDIO="/tmp/scopio_test_question.pcm"

bold()  { printf "\033[1m%s\033[0m\n" "$1"; }
green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }

bold "═══════════════════════════════════════════"
bold "  ScopioLabs BMA — Phase 2 Voice Loop Test"
bold "═══════════════════════════════════════════"
echo ""

# ─── Step 1: Generate test audio using TTS ───
bold "1. Generating test audio (TTS → PCM)"

if [ -z "$ELEVENLABS_KEY" ]; then
  red "   ELEVENLABS_API_KEY not set — cannot generate test audio"
  echo "   Usage: bash scripts/test-voice-loop.sh <ELEVENLABS_KEY> [ANTHROPIC_KEY]"
  exit 1
fi

# Use ElevenLabs API directly to generate a test question
QUESTION="Is this FDA cleared and what does that mean for our lab?"

HTTP_CODE=$(curl -sf -o /tmp/scopio_test_raw.mp3 -w "%{http_code}" \
  -X POST "https://api.elevenlabs.io/v1/text-to-speech/21m00Tcm4TlvDq8ikWAM" \
  -H "xi-api-key: $ELEVENLABS_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"text\": \"$QUESTION\", \"model_id\": \"eleven_turbo_v2\"}" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ] && [ -s /tmp/scopio_test_raw.mp3 ]; then
  # Convert to 16kHz 16-bit mono PCM
  ffmpeg -y -i /tmp/scopio_test_raw.mp3 -f s16le -ar 16000 -ac 1 "$TEST_AUDIO" 2>/dev/null
  AUDIO_SIZE=$(wc -c < "$TEST_AUDIO" | tr -d ' ')
  DURATION=$(echo "scale=1; $AUDIO_SIZE / 32000" | bc)
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

# Run zoom-bot in audio file mode
AUDIO_INPUT_FILE="$TEST_AUDIO" \
AUDIO_OUTPUT_DIR="$OUTPUT_DIR" \
AUDIO_OUTPUT=file \
ORCHESTRATOR_GRPC_ADDR=localhost:50051 \
STT_GRPC_ADDR=localhost:50056 \
TTS_GRPC_ADDR=localhost:50054 \
perl -e 'alarm 30; exec @ARGV' node services/zoom-bot/src/index.js 2>&1 || true

echo ""

# ─── Step 3: Check results ───
bold "3. Results"

# Check for output audio files
OUTPUT_FILES=$(find "$OUTPUT_DIR" -name "*.pcm" -newer "$TEST_AUDIO" 2>/dev/null | head -5)

if [ -n "$OUTPUT_FILES" ]; then
  green "   TTS audio output files:"
  for f in $OUTPUT_FILES; do
    SIZE=$(wc -c < "$f" | tr -d ' ')
    DUR=$(echo "scale=1; $SIZE / 32000" | bc)
    echo "   - $f ($SIZE bytes, ${DUR}s)"
  done
else
  red "   No TTS output audio found in $OUTPUT_DIR"
fi
echo ""

bold "═══════════════════════════════════════════"
echo "  Check service logs for latency breakdown:"
echo "  tail /tmp/orchestrator.log | grep latency"
echo "  tail /tmp/claude-wrapper.log"
bold "═══════════════════════════════════════════"
