#!/usr/bin/env bash
# Read-only smoke test. Drives the server over stdio, no Inspector needed.
#   ./smoke.sh                    -> list open PRs
#   ./smoke.sh 42                 -> also fetch the diff for PR 42
#   ./smoke.sh 42 ws repo-slug    -> against a different repo
set -euo pipefail
cd "$(dirname "$0")"

[ -f .env ] || { echo "No .env here. See README." >&2; exit 1; }
set -a; . ./.env; set +a
: "${ATLASSIAN_EMAIL:?not set in .env}" "${BITBUCKET_API_TOKEN:?not set in .env}"

PR="${1:-}"
WS="${2:-${BITBUCKET_WORKSPACE:-}}"
REPO="${3:-${BITBUCKET_REPO_SLUG:-}}"
[ -n "$WS" ] && [ -n "$REPO" ] || {
  echo "usage: ./smoke.sh [pr-id] [workspace] [repo-slug]" >&2
  echo "   or set BITBUCKET_WORKSPACE and BITBUCKET_REPO_SLUG in .env" >&2
  exit 1
}

{
  echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  echo '{"jsonrpc":"2.0","method":"notifications/initialized"}'
  echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"list_pull_requests\",\"arguments\":{\"workspace\":\"$WS\",\"repo_slug\":\"$REPO\",\"state\":\"OPEN\"}}}"
  [ -n "$PR" ] && echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"get_diff\",\"arguments\":{\"workspace\":\"$WS\",\"repo_slug\":\"$REPO\",\"pull_request_id\":$PR,\"max_chars\":3000}}}"
  sleep 20
} | node dist/index.js 2>/dev/null | node -e '
let buf = "";
process.stdin.on("data", d => {
  buf += d;
  const lines = buf.split("\n"); buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) { console.log("handshake ok:", msg.result.serverInfo.name); continue; }
    const label = msg.id === 2 ? "list_pull_requests" : "get_diff";
    const r = msg.result;
    console.log("\n=== " + label + (r?.isError ? "  [ERROR]" : "") + " ===");
    console.log(r?.content?.map(c => c.text).join("\n") ?? JSON.stringify(msg));
  }
});'
