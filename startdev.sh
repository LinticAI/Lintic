#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

backend_pid=""
frontend_pid=""
backend_port="${1:-3300}"
frontend_port="${2:-5173}"

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

if port_in_use "$backend_port"; then
  echo "Cannot start backend: port ${backend_port} is already in use."
  print_port_owner "$backend_port"
  exit 1
fi

if port_in_use "$frontend_port"; then
  echo "Cannot start frontend: port ${frontend_port} is already in use."
  print_port_owner "$frontend_port"
  exit 1
fi

echo "Building @lintic/core..."
npm run build --workspace @lintic/core

echo "Starting backend on http://localhost:${backend_port}"
PORT="$backend_port" npm run dev --workspace @lintic/backend &
backend_pid=$!

echo "Starting frontend on http://localhost:${frontend_port} (proxying /api to backend port ${backend_port})"
VITE_BACKEND_PORT="$backend_port" npm run dev --workspace @lintic/frontend -- --host localhost --port "$frontend_port" --strictPort &
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
