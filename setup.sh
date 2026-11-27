#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Setting up market-brief (React + Vite + Node) on Fly.io Sprite..."

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: node and npm are required." >&2
  exit 1
fi

cd "${REPO_DIR}"
echo "==> Installing dependencies & building frontend..."
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund
npm run build

# Verify Fly.io Sprites zero-key connectors
if command -v curl >/dev/null 2>&1; then
  GW_LIST=$(curl -fsSL --max-time 3 https://api.sprites.dev/v1/gateway/list 2>/dev/null || true)
  echo "${GW_LIST}" | grep -qi '"gemini"' && echo "==> Gemini Sprites Connector: OK" || echo "WARNING: Gemini Connector not found"
  echo "${GW_LIST}" | grep -qi 'twelve' && echo "==> Twelve Data Sprites Connector: OK" || echo "WARNING: Twelve Data Connector not found (will use Yahoo fallback)"
  echo "${GW_LIST}" | grep -qi '"neon"' && echo "==> Neon Postgres Sprites Connector: OK" || echo "==> Neon Connector not found (will use local SQLite)"
fi

if command -v sprite-env >/dev/null 2>&1; then
  echo "==> Registering market-brief HTTP service on port 8080..."
  sprite-env services delete market-brief >/dev/null 2>&1 || true
  sprite-env services create market-brief \
    --cmd node \
    --args "${REPO_DIR}/server.mjs" \
    --http-port 8080 \
    --dir "${REPO_DIR}"
  echo "==> Done! Open your Sprite HTTPS URL on your phone."
else
  echo "==> Local mode. Start with: npm start (http://localhost:8080)"
fi
