#!/usr/bin/env bash
# sandbox から deploy/ 配布版を起動するラッパー
# 設計書: docs/workspace-separation.md
set -e
SANDBOX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$SANDBOX_DIR/../deploy"
if [ ! -f "$DEPLOY_DIR/index.js" ]; then
  echo "[sandbox] deploy/index.js not found. Run: npm run sync:deploy" >&2
  exit 1
fi
exec node "$DEPLOY_DIR/index.js" "$@"
