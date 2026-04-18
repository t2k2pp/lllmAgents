#!/usr/bin/env bash
# localllm インストーラ (macOS/Linux/git-bash)
#  - localllm(.exe) を ~/.local/bin/ にコピー
#  - skills/ を ~/.localllm/skills/ にコピー
#  - PATH 追加は手順表示のみ

set -e

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="$HOME/.local/bin"
SKILLS_DST="$HOME/.localllm/skills"

echo "========================================="
echo " localllm installer"
echo "========================================="
echo "Install dir: $INSTALL_DIR"
echo "Skills dir : $SKILLS_DST"
echo

# localllm.exe (Windows) または localllm (Unix) を探す
EXE=""
if [[ -f "$SRC_DIR/localllm.exe" ]]; then
  EXE="$SRC_DIR/localllm.exe"
  DST_NAME="localllm.exe"
elif [[ -f "$SRC_DIR/localllm" ]]; then
  EXE="$SRC_DIR/localllm"
  DST_NAME="localllm"
else
  echo "[ERROR] executable not found in $SRC_DIR"
  exit 1
fi

mkdir -p "$INSTALL_DIR"
cp "$EXE" "$INSTALL_DIR/$DST_NAME"
chmod +x "$INSTALL_DIR/$DST_NAME" 2>/dev/null || true
echo "[OK] copied $DST_NAME to $INSTALL_DIR"

if [[ -d "$SRC_DIR/skills" ]]; then
  mkdir -p "$SKILLS_DST"
  cp -R "$SRC_DIR/skills/." "$SKILLS_DST/"
  echo "[OK] copied skills to $SKILLS_DST"
else
  echo "[WARN] skills folder not found, skipped"
fi

echo
echo "========================================="
echo " Next step: add to PATH"
echo "========================================="
echo "Add this line to your ~/.bashrc or ~/.zshrc:"
echo
echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
echo
echo "Then restart your terminal and run: localllm --setup"
echo "========================================="
