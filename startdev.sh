#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

backend_pid=""
frontend_pid=""

port_in_use() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
}

print_port_owner() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

cleanup() {
  trap - EXIT INT TERM

  if [[ -n "$backend_pid" ]] && kill -0 "$backend_pid" 2>/dev/null; then
    kill "$backend_pid" 2>/dev/null || true
  fi

  if [[ -n "$frontend_pid" ]] && kill -0 "$frontend_pid" 2>/dev/null; then
    kill "$frontend_pid" 2>/dev/null || true
  fi

  wait 2>/dev/null || true
}

trap cleanup EXIT INT TERM

if port_in_use 3300; then
  echo "Cannot start backend: port 3300 is already in use."
  print_port_owner 3300
  exit 1
fi

if port_in_use 5173; then
  echo "Cannot start frontend: port 5173 is already in use."
  print_port_owner 5173
  exit 1
fi

echo "Starting backend on http://localhost:3300"
PORT=3300 npm run dev --workspace @lintic/backend &
backend_pid=$!

echo "Starting frontend on http://localhost:5173"
npm run dev --workspace @lintic/frontend -- --host localhost --port 5173 --strictPort &
frontend_pid=$!

while true; do
  if ! kill -0 "$backend_pid" 2>/dev/null; then
    wait "$backend_pid" 2>/dev/null || true
    break
  fi

  if ! kill -0 "$frontend_pid" 2>/dev/null; then
    wait "$frontend_pid" 2>/dev/null || true
    break
  fi

  sleep 1
done
