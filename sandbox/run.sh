#!/usr/bin/env bash
# sandbox から deploy/localllm(.exe) を起動するラッパー
# 設計書: docs/workspace-separation.md
set -e
SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SANDBOX_DIR/../deploy"

EXE=""
if [ -f "$DEPLOY_DIR/localllm.exe" ]; then
  EXE="$DEPLOY_DIR/localllm.exe"
elif [ -f "$DEPLOY_DIR/localllm" ]; then
  EXE="$DEPLOY_DIR/localllm"
else
  echo "[sandbox] localllm(.exe) not found. Run: npm run build:deploy" >&2
  exit 1
fi

exec "$EXE" "$@"
