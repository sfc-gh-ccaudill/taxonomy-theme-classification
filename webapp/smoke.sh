#!/bin/bash
# Smoke-check every page and API route of the app.
# Usage: ./smoke.sh [base_url] [dev_log_file]
BASE="${1:-http://localhost:3000}"
LOG="${2:-}"

echo "=== pages ==="
for p in / /build /evaluate /run /monitor; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 120 "$BASE$p")
  printf "  %-14s %s\n" "$p" "$code"
done

echo "=== api ==="
for a in /api/corpus /api/taxonomy "/api/taxonomy?rendered=v001" /api/runs "/api/runs?production=1" /api/eval /api/configs "/api/notes?limit=2" "/api/classified?summary=1" "/api/classified?limit=2"; do
  code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 180 "$BASE$a")
  printf "  %-24s %s\n" "$a" "$code"
done

echo "=== allowlist rejection (expect 400) ==="
code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 60 -X POST "$BASE/api/action" \
  -H 'Content-Type: application/json' -d '{"proc":"DROP_EVERYTHING","params":{}}')
printf "  unknown proc             %s\n" "$code"

if [ -n "$LOG" ]; then
  echo "=== compile/runtime errors in dev log ==="
  grep -E "Failed to compile|Module not found|Type error|⨯" "$LOG" | tail -8
  echo "  (nothing above means clean)"
fi
