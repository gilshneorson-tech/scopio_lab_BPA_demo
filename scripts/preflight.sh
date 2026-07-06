#!/usr/bin/env bash
# ─── Pre-demo preflight ───
#
# Validates every EXTERNAL dependency the demo relies on. In-repo tests can't
# catch an expired API key, a retired Claude model, or an exhausted ElevenLabs
# quota — this script does, in under a minute, before the prospect joins.
#
# Usage:
#   bash scripts/preflight.sh            # reads .env in repo root (if present)
#   STRICT=false bash scripts/preflight.sh   # warn instead of fail on optional checks
#
# Exit code 0 = go for demo. Non-zero = fix before the call.

set -uo pipefail

cd "$(dirname "$0")/.."

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

CLAUDE_MODEL="${CLAUDE_MODEL:-claude-sonnet-5}"
TTS_MODEL="${TTS_MODEL:-eleven_turbo_v2}"
ELEVENLABS_VOICE_ID="${ELEVENLABS_VOICE_ID:-XrExE9yKIg1WjnnlVkGX}"

PASS=0
FAIL=0
WARN=0

ok()   { printf "  \033[32m✔\033[0m %s\n" "$1"; PASS=$((PASS+1)); }
bad()  { printf "  \033[31m✘\033[0m %s\n" "$1"; FAIL=$((FAIL+1)); }
warn() { printf "  \033[33m⚠\033[0m %s\n" "$1"; WARN=$((WARN+1)); }

echo "═══════════════════════════════════════════"
echo "  Scopio Demo Preflight"
echo "═══════════════════════════════════════════"

# ─── 1. .env completeness ───
echo ""
echo "1. Environment"
for key in ANTHROPIC_API_KEY ELEVENLABS_API_KEY ZOOM_CLIENT_ID ZOOM_CLIENT_SECRET; do
  if [ -n "${!key:-}" ]; then ok "$key set"; else bad "$key is EMPTY"; fi
done
if [ -n "${ZOOM_MEETING_ID:-}" ]; then
  ok "ZOOM_MEETING_ID set (${ZOOM_MEETING_ID})"
else
  warn "ZOOM_MEETING_ID empty — bot will start in standby (fine for local testing)"
fi

# ─── 2. Claude API: 1-token call with the CONFIGURED model ───
# Catches: bad key, retired/renamed model (a retired model 404s and the
# wrapper degrades to canned fallback lines on every question).
echo ""
echo "2. Claude API (model: $CLAUDE_MODEL)"
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  CLAUDE_RESP=$(curl -sS --max-time 20 https://api.anthropic.com/v1/messages \
    -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    -H "content-type: application/json" \
    -d "{\"model\": \"${CLAUDE_MODEL}\", \"max_tokens\": 1, \"messages\": [{\"role\": \"user\", \"content\": \"hi\"}]}" 2>&1)
  if echo "$CLAUDE_RESP" | grep -q '"type":"message"'; then
    ok "Claude responded with model $CLAUDE_MODEL"
  else
    bad "Claude API failed: $(echo "$CLAUDE_RESP" | head -c 300)"
  fi
else
  bad "Skipped (no ANTHROPIC_API_KEY)"
fi

# ─── 3. ElevenLabs: synthesize a short utterance, expect real audio bytes ───
# Catches: bad/exhausted key, deleted voice, retired TTS model. A TTS failure
# used to produce a completely SILENT demo racing through all 10 steps.
echo ""
echo "3. ElevenLabs TTS (voice: $ELEVENLABS_VOICE_ID, model: $TTS_MODEL)"
if [ -n "${ELEVENLABS_API_KEY:-}" ]; then
  TTS_OUT=$(mktemp)
  HTTP_CODE=$(curl -sS --max-time 30 -o "$TTS_OUT" -w "%{http_code}" \
    "https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}?output_format=pcm_16000" \
    -H "xi-api-key: ${ELEVENLABS_API_KEY}" \
    -H "content-type: application/json" \
    -d "{\"text\": \"Preflight check.\", \"model_id\": \"${TTS_MODEL}\"}" 2>&1)
  TTS_BYTES=$(wc -c < "$TTS_OUT" | tr -d ' ')
  if [ "$HTTP_CODE" = "200" ] && [ "$TTS_BYTES" -gt 1000 ]; then
    ok "ElevenLabs returned ${TTS_BYTES} bytes of audio"
  else
    bad "ElevenLabs failed (HTTP $HTTP_CODE, $TTS_BYTES bytes): $(head -c 200 "$TTS_OUT")"
  fi
  rm -f "$TTS_OUT"
else
  bad "Skipped (no ELEVENLABS_API_KEY)"
fi

# ─── 4. Google Cloud STT: credentials + API reachability ───
echo ""
echo "4. Google Cloud Speech-to-Text"
if command -v gcloud >/dev/null 2>&1; then
  GCP_TOKEN=$(gcloud auth application-default print-access-token 2>/dev/null || gcloud auth print-access-token 2>/dev/null || echo "")
  if [ -n "$GCP_TOKEN" ]; then
    # Recognize 0.1s of silence — validates auth + API enablement end to end
    SILENCE=$(python3 - <<'PY' 2>/dev/null || printf ''
import base64
print(base64.b64encode(b"\x00" * 3200).decode())
PY
)
    STT_RESP=$(curl -sS --max-time 20 "https://speech.googleapis.com/v1/speech:recognize" \
      -H "Authorization: Bearer ${GCP_TOKEN}" \
      -H "content-type: application/json" \
      -d "{\"config\": {\"encoding\": \"LINEAR16\", \"sampleRateHertz\": 16000, \"languageCode\": \"${STT_LANGUAGE:-en-US}\"}, \"audio\": {\"content\": \"${SILENCE}\"}}" 2>&1)
    if echo "$STT_RESP" | grep -q '"error"'; then
      bad "Google STT error: $(echo "$STT_RESP" | head -c 200)"
    else
      ok "Google STT reachable and authorized"
    fi
  else
    warn "No GCP credentials available locally (fine if only the GCE VM calls STT)"
  fi
else
  warn "gcloud not installed — skipping STT check (fine if only the GCE VM calls STT)"
fi

# ─── 5. Zoom S2S OAuth token mint ───
echo ""
echo "5. Zoom credentials"
if [ -n "${ZOOM_ACCOUNT_ID:-}" ] && [ -n "${ZOOM_CLIENT_ID:-}" ] && [ -n "${ZOOM_CLIENT_SECRET:-}" ]; then
  ZOOM_RESP=$(curl -sS --max-time 20 -X POST \
    "https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${ZOOM_ACCOUNT_ID}" \
    -u "${ZOOM_CLIENT_ID}:${ZOOM_CLIENT_SECRET}" 2>&1)
  if echo "$ZOOM_RESP" | grep -q '"access_token"'; then
    ok "Zoom S2S token minted"
  else
    bad "Zoom token mint failed: $(echo "$ZOOM_RESP" | head -c 200)"
  fi
else
  warn "Zoom S2S credentials incomplete — SDK JWT auth may still work with client id/secret"
fi

# ─── Summary ───
echo ""
echo "═══════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  printf "  \033[31mNO-GO\033[0m: %d failed, %d warnings, %d passed\n" "$FAIL" "$WARN" "$PASS"
  echo "═══════════════════════════════════════════"
  exit 1
fi
printf "  \033[32mGO\033[0m: %d passed, %d warnings\n" "$PASS" "$WARN"
echo "═══════════════════════════════════════════"
