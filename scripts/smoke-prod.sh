#!/usr/bin/env bash
# Production smoke test for txt.2-38.com (spec §14, §17).
#
# Verifies the public surface end to end without touching an account: host
# policy, security headers, caching rules, API contract, and the passkey
# ceremony options. A full passkey flow needs a real device and is covered by
# the E2E suite against a local instance.
set -euo pipefail

BASE="${TXT_SMOKE_BASE:-https://txt.2-38.com}"
PASS=0
FAIL=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    echo "  ok   ${label}: ${actual}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL ${label}: expected ${expected}, got ${actual}"
    FAIL=$((FAIL + 1))
  fi
}

check_contains() {
  local label="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then
    echo "  ok   ${label}"
    PASS=$((PASS + 1))
  else
    echo "  FAIL ${label}: missing '${needle}'"
    FAIL=$((FAIL + 1))
  fi
}

echo "txt production smoke: ${BASE}"
echo

echo "- health"
HEALTH="$(curl -fsS --max-time 15 "${BASE}/api/v1/health")"
check_contains "health ok" '"ok":true' "$HEALTH"
check_contains "rpId" '"rpId":"txt.2-38.com"' "$HEALTH"

echo "- shell and static assets"
ROOT_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/")"
check "root 200" "200" "$ROOT_STATUS"
INDEX="$(curl -fsS --max-time 15 "${BASE}/")"
check_contains "title is txt" "<title>txt</title>" "$INDEX"
check_contains "no title reflection" 'aria-label="テキスト"' "$INDEX"
CSS_TYPE="$(curl -s -o /dev/null -w '%{content_type}' --max-time 15 "${BASE}/styles.css")"
check_contains "styles.css served as CSS" "text/css" "$CSS_TYPE"
SW_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/sw.js")"
check "service worker 200" "200" "$SW_STATUS"

echo "- security headers"
HEADERS="$(curl -sI --max-time 15 "${BASE}/")"
check_contains "nosniff" "nosniff" "$HEADERS"
check_contains "referrer policy" "no-referrer" "$HEADERS"
check_contains "CSP present" "content-security-policy" "$HEADERS"
API_HEADERS="$(curl -sI --max-time 15 "${BASE}/api/v1/health")"
check_contains "API no-store" "private, no-store" "$API_HEADERS"

echo "- session gating"
SESSION_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/v1/session")"
check "session requires auth" "401" "$SESSION_STATUS"
DOC_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/v1/document")"
check "document requires auth" "401" "$DOC_STATUS"

echo "- registration ceremony"
OPTIONS="$(curl -fsS --max-time 15 -X POST "${BASE}/api/v1/auth/register/options" \
  -H 'content-type: application/json' -H "origin: ${BASE}" -d '{}')"
check_contains "options challenge" '"challenge"' "$OPTIONS"
check_contains "resident key required" '"residentKey":"required"' "$OPTIONS"
check_contains "user verification required" '"userVerification":"required"' "$OPTIONS"
check_contains "attestation none" '"attestation":"none"' "$OPTIONS"
check_contains "random label" 'txt-' "$OPTIONS"
check_contains "prf extension requested" '"prf"' "$OPTIONS"

echo "- local-only surfaces"
LOCAL_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/_local/media/x")"
check "_local is not served directly" "404" "$LOCAL_STATUS"
# AASA is served once the real Team ID / bundle IDs are configured (spec §13).
# Before that it deliberately 404s; after it must be a 200 JSON document that
# names the signed apps, because passkey sharing depends on it.
AASA_BODY="$(curl -s --max-time 15 "${BASE}/.well-known/apple-app-site-association")"
AASA_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/.well-known/apple-app-site-association")"
if [ "$AASA_STATUS" = "404" ]; then
  check "AASA withheld until real values" "404" "$AASA_STATUS"
else
  check "AASA is published" "200" "$AASA_STATUS"
  case "$AASA_BODY" in
    *'"webcredentials"'*'.txt.ios"'*'.txt.mac"'*) check "AASA names the iOS and macOS apps" "ok" "ok" ;;
    *) check "AASA names the iOS and macOS apps" "ok" "missing" ;;
  esac
fi
SPA_STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "${BASE}/api/v1/does-not-exist")"
check "API 404 (no SPA fallback)" "404" "$SPA_STATUS"
SPA_BODY="$(curl -s --max-time 15 "${BASE}/api/v1/does-not-exist")"
check_contains "API 404 is JSON" '"error"' "$SPA_BODY"

echo
echo "passed ${PASS}, failed ${FAIL}"
[ "$FAIL" -eq 0 ]
