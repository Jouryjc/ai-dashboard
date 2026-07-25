#!/usr/bin/env bash
# 一键启动：服务端(:8787) + Electron 客户端
# 用法：./scripts/dev.sh
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$ROOT/server"
if [ ! -d node_modules ]; then npm install; fi
npm run dev &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null' EXIT

cd "$ROOT/client"
if [ ! -d node_modules ]; then npm install; fi
npm run electron:dev
