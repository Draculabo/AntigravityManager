#!/bin/sh
set -eu

runtime="/opt/antigravity-manager"
node="$runtime/node/node"
core="$runtime/core/main.cjs"
cli="$runtime/cli/main.cjs"

if [ ! -x "$node" ] || [ ! -f "$core" ] || [ ! -f "$cli" ]; then
  echo "Standalone runtime is incomplete" >&2
  exit 78
fi

if [ "${1:-}" = "health" ]; then
  exec "$node" "$cli" service status
fi

if [ "${1:-}" = "cli" ]; then
  shift
  exec "$node" "$cli" "$@"
fi

"$node" "$core" &
core_pid=$!

finish() {
  "$node" "$cli" service stop >/dev/null 2>&1 || true
  wait "$core_pid" || true
}

trap finish INT TERM
wait "$core_pid"
