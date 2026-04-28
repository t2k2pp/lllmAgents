#!/usr/bin/env bash
# build-exe.sh - macOS / Linux 用 SEA exe ビルダ (build-exe.bat の Unix 版)
#
# build-exe.bat は `npm run build:deploy` を呼ぶだけで完了するが、
# macOS / Linux では SEA ビルド後に以下が追加で必要なため本スクリプトに集約する:
#   1. Node.js 20+ の存在チェック (SEA は v20 から安定)
#   2. node_modules 未インストール時に自動で npm install
#   3. macOS のみ: postject 経路でのみ必要だった ad-hoc codesign は build-exe.js
#      側に移動済み。本スクリプトは事前チェックと事後の起動ガイダンスを担当
#   4. SEA に使えない node (homebrew のダイナミックリンク版) を検出した場合は
#      公式 .pkg 版 /usr/local/bin/node に自動切替
#
# build-exe.js が SEA ビルド失敗時にフォールバックでシェルラッパを書き出す経路は
# このスクリプトを通しても透過的に動く。

set -e
set -u
set -o pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

echo "========================================="
echo " Building Node.js Single Executable (SEA)"
echo " and updating deploy/ folder"
echo "========================================="

# ---- 前提チェック: node ----
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] node コマンドが見つかりません。Node.js 20+ をインストールしてください。"
  echo "        macOS 推奨: 公式 .pkg を https://nodejs.org/ からダウンロード"
  echo "        (homebrew の node は SEA 不可。下記参照)"
  exit 1
fi

# macOS の SEA 罠: homebrew の node は libnode.dylib 等にダイナミックリンクされた
# 68KB ほどの薄いラッパで、SEA フューズ文字列が node 本体側に存在せず postject が
# "Could not find the sentinel ..." で失敗する。さらに仮に通せても他環境では
# /opt/homebrew/opt/* の dylib が見つからず実行不能。
# 公式 .pkg からインストールされた /usr/local/bin/node は universal binary かつ
# 静的リンクで SEA 可能。サイズ (>50MB) と libnode.dylib への依存有無で判定する。
pick_sea_node() {
  local candidate="$1"
  [ -x "$candidate" ] || return 1
  # libnode.dylib に依存していたらアウト
  if otool -L "$candidate" 2>/dev/null | grep -q 'libnode\.[0-9]'; then
    return 1
  fi
  # サイズ < 50MB ならまずシン・ラッパ。SEA 不可
  local sz
  sz=$(stat -f%z "$candidate" 2>/dev/null || stat -c%s "$candidate" 2>/dev/null || echo 0)
  if [ "$sz" -lt 52428800 ]; then
    return 1
  fi
  return 0
}

NODE_BIN="$(command -v node)"
if [ "$(uname -s)" = "Darwin" ]; then
  if ! pick_sea_node "$NODE_BIN"; then
    echo "[WARN] $NODE_BIN は SEA に使えない node (homebrew ダイナミックリンク版の可能性)"
    if pick_sea_node "/usr/local/bin/node"; then
      NODE_BIN="/usr/local/bin/node"
      echo "[INFO] 公式 .pkg 版 $NODE_BIN を SEA ビルドに使用します"
      export PATH="/usr/local/bin:$PATH"
    else
      echo "[WARN] SEA に使える node が見つかりません。"
      echo "        build-exe.js のフォールバックで shell wrapper モードに退化します"
      echo "        (出力 dist/localllm は node 経由で .cjs を起動する薄いラッパ)。"
      echo "        単一 exe が必要なら https://nodejs.org/ から公式 .pkg をインストールしてください。"
    fi
  fi
fi

NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "[ERROR] Node.js $NODE_MAJOR.x が検出されました ($NODE_BIN)。SEA ビルドには Node.js 20+ が必要です。"
  exit 1
fi
echo "[OK] node $("$NODE_BIN" -v)  ($NODE_BIN)"

# ---- 前提チェック: npm ----
if ! command -v npm >/dev/null 2>&1; then
  echo "[ERROR] npm コマンドが見つかりません。"
  exit 1
fi

# ---- node_modules 自動インストール ----
if [ ! -d "$ROOT/node_modules" ]; then
  echo "[INFO] node_modules が見つからないため npm install を実行します..."
  npm install
fi

# ---- 本体ビルド (Windows と共通の build:deploy を呼ぶ) ----
npm run build:deploy

# ---- 結果サマリ ----
DEPLOY_BIN="$ROOT/deploy/localllm"
echo
echo "========================================="
echo " Done."
if [ -f "$DEPLOY_BIN" ]; then
  echo " 配布バイナリ: $DEPLOY_BIN"
  echo " 起動テスト:"
  echo "   $DEPLOY_BIN"
else
  echo " 配布バイナリが見つかりません。build:deploy のログを確認してください。"
fi
echo "========================================="
