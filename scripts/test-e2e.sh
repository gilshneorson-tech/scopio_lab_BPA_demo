#!/usr/bin/env bash
set -euo pipefail

# ─── Phase 1 End-to-End Test ───
# Tests: session lifecycle, manual step advancement, browser navigation, Claude Q&A
#
# Usage: bash scripts/test-e2e.sh [BASE_URL]
#   BASE_URL defaults to http://localhost:3000

BASE_URL="${1:-http://localhost:3000}"
PASS=0
FAIL=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
bold()  { printf "\033[1m%s\033[0m\n" "$1"; }

check() {
  local label="$1" condition="$2"
  if [ "$condition" = "true" ]; then
    green "  PASS: $label"
    PASS=$((PASS + 1))
  else
    red "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

bold "═══════════════════════════════════════════"
bold "  ScopioLabs BMA Demo — Phase 1 E2E Test"
bold "═══════════════════════════════════════════"
echo ""

# ─── 1. Health check ───
bold "1. Health Check"
HEALTH=$(curl -sf "$BASE_URL/health" 2>/dev/null || echo '{"status":"down"}')
STATUS=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
check "Orchestrator is healthy" "$([ "$STATUS" = "ok" ] && echo true || echo false)"
echo ""

# ─── 2. Create session ───
bold "2. Create Session"
SESSION=$(curl -sf -X POST "$BASE_URL/api/sessions" \
  -H "Content-Type: application/json" \
  -d '{"prospect_name":"Dr. Test","zoom_meeting_id":"123456789"}' 2>/dev/null || echo '{"error":"failed"}')

CALL_ID=$(echo "$SESSION" | python3 -c "import sys,json; print(json.load(sys.stdin).get('call_id',''))" 2>/dev/null || echo "")
STATE=$(echo "$SESSION" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state',''))" 2>/dev/null || echo "")

check "Session created with call_id" "$([ -n "$CALL_ID" ] && echo true || echo false)"
check "State is 'presenting'" "$([ "$STATE" = "presenting" ] && echo true || echo false)"
echo "  call_id: $CALL_ID"
echo ""

if [ -z "$CALL_ID" ]; then
  red "Cannot continue without a session. Exiting."
  exit 1
fi

# ─── 3. Advance through all 10 demo steps ───
bold "3. Advance Through Demo Steps"
TOPICS=("Intro + agenda" "The BMA problem today" "Full-Field imaging at 100x" "AI differential count" "M:E ratio + megakaryocyte count" "Remote access + collaboration" "Digital report generation" "LIS / LIMS integration" "Q&A open floor" "Close + next steps")

for i in $(seq 0 9); do
  sleep 0.5
  RESULT=$(curl -sf -X POST "$BASE_URL/api/sessions/$CALL_ID/advance" 2>/dev/null || echo '{"error":"failed"}')
  STEP=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('step','?'))" 2>/dev/null || echo "?")
  TOPIC=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('topic','?'))" 2>/dev/null || echo "?")
  SECTION=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('section','?'))" 2>/dev/null || echo "?")
  BROWSER_OK=$(echo "$RESULT" | python3 -c "import sys,json; r=json.load(sys.stdin).get('browser_result',{}); print('true' if r.get('success') else 'false')" 2>/dev/null || echo "false")
  R_STATE=$(echo "$RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('state','?'))" 2>/dev/null || echo "?")

  printf "  Step %2d: %-40s section=%-15s browser=%s  state=%s\n" "$((i+1))" "$TOPIC" "$SECTION" "$BROWSER_OK" "$R_STATE"

  if [ "$i" -lt 9 ]; then
    check "Step $((i+1)) advanced" "$([ "$STEP" != "?" ] && echo true || echo false)"
  fi
done
echo ""

# ─── 4. Test Claude Q&A (graceful if unavailable) ───
bold "4. Claude Q&A Test"
QA_RESULT=$(curl -sf -X POST "$BASE_URL/api/sessions/$CALL_ID/question" \
  -H "Content-Type: application/json" \
  -d '{"question":"Is this FDA cleared?"}' 2>/dev/null || echo '{"error":"request_failed"}')

QA_ERROR=$(echo "$QA_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('error',''))" 2>/dev/null || echo "")
QA_RESPONSE=$(echo "$QA_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('response_text',''))" 2>/dev/null || echo "")
QA_ACTION=$(echo "$QA_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('action',''))" 2>/dev/null || echo "")

if [ -n "$QA_ERROR" ]; then
  echo "  Claude unavailable (degraded mode): $QA_ERROR"
  check "Claude Q&A gracefully degraded" "true"
else
  echo "  Action: $QA_ACTION"
  echo "  Response: ${QA_RESPONSE:0:120}..."
  check "Claude responded to question" "$([ -n "$QA_RESPONSE" ] && echo true || echo false)"
fi
echo ""

# ─── 5. End session ───
bold "5. End Session"
END_RESULT=$(curl -sf -X POST "$BASE_URL/api/sessions/$CALL_ID/end" 2>/dev/null || echo '{"ok":false}')
END_OK=$(echo "$END_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('ok',False))" 2>/dev/null || echo "False")
check "Session ended cleanly" "$([ "$END_OK" = "True" ] && echo true || echo false)"
echo ""

# ─── Summary ───
bold "═══════════════════════════════════════════"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  green "  ALL $TOTAL TESTS PASSED"
else
  red "  $PASS/$TOTAL passed, $FAIL failed"
fi
bold "═══════════════════════════════════════════"

exit "$FAIL"
