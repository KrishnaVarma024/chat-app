#!/usr/bin/env bash
#
# Phase 15 exercise T1 — "the signal that never arrives".
#
# A graceful-shutdown handler only matters if SIGTERM actually reaches the
# Node process. The platform signals the process IT started, and that is
# often not node: `npm run start` is npm, and a script like
# `npm run migrate && node dist/index.js` is an `sh -c` running node as a
# CHILD. Neither forwards SIGTERM past its own direct child, so node never
# hears it, the handler never runs, and the platform SIGKILLs after its
# shutdown delay.
#
# This starts the REAL server five different ways, sends SIGTERM to the
# process that was launched (exactly what Render does), and reports whether
# the Phase 15 handler ran. Needs no database: the pool connects lazily and
# /health doesn't query.
#
#   bash scripts/signal-forwarding-test.sh        (or: npm run test:signals)
#
# Exit 0 = every launch form that SHOULD deliver the signal did.
set -u
SERVER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

export DATABASE_URL="${DATABASE_URL:-postgresql://x:x@127.0.0.1:1/x}"
export JWT_SECRET="${JWT_SECRET:-signal-test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa}"
export NODE_ENV=development SHUTDOWN_ACK_TIMEOUT_MS=500

cat > "$TMP/package.json" <<JSON
{ "name": "launchers", "version": "1.0.0", "private": true, "scripts": {
  "chain":      "echo migrating... && cd '$SERVER_DIR' && node --import tsx src/index.ts",
  "chain-exec": "echo migrating... && cd '$SERVER_DIR' && exec node --import tsx src/index.ts" } }
JSON

cd "$SERVER_DIR"
port=4200
fail=0

trial () {
  local expect="$1" label="$2"; shift 2
  port=$((port+1)); export PORT=$port
  local log="$TMP/server-$port.log"
  "$@" > "$log" 2>&1 &
  local launcher=$!
  for _ in $(seq 1 60); do curl -sf "localhost:$port/health" >/dev/null 2>&1 && break; sleep 0.3; done
  kill -TERM "$launcher" 2>/dev/null            # what the platform does
  sleep 2.5
  local handler="handler NEVER ran" ok=0
  grep -q "shutdown initiated" "$log" && { handler="HANDLER RAN"; ok=1; }
  local code; code=$(curl -s -o /dev/null -m 1 -w "%{http_code}" "localhost:$port/health")
  local state="server stopped"; [ "$code" != "000" ] && state="SERVER STILL SERVING (orphaned)"
  local verdict="ok"
  if [ "$expect" = "delivers" ] && [ "$ok" != 1 ]; then verdict="UNEXPECTED"; fail=1; fi
  printf "%-58s %-17s %-31s [%s]\n" "$label" "$handler" "$state" "$verdict"
  for p in $(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null); do kill -9 "$p" 2>/dev/null; done
  sleep 0.4
}

trial hazard   "1. npm run: a && node ..."                    npm --prefix "$TMP" run chain
trial hazard   "2. sh -c 'a && node ...'"                     sh -c 'true && node --import tsx src/index.ts'
trial delivers "3. sh -c 'a && exec node ...'"                sh -c 'true && exec node --import tsx src/index.ts'
trial delivers "4. npm run: a && exec node ...  (package.json)" npm --prefix "$TMP" run chain-exec
trial delivers "5. node ...  (migrations in preDeployCommand)" node --import tsx src/index.ts

echo
[ "$fail" = 0 ] && echo "OK — forms 3-5 deliver SIGTERM; 1-2 are the hazard to avoid." || echo "FAILED — a form that should deliver SIGTERM did not."
exit "$fail"
