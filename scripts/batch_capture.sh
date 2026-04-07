#!/bin/bash

# 設定
START_SEED=2000
END_SEED=3000
CAPTURE_SCRIPT=".localllm/skills/chunkbase-screenshot/scripts/capture.js"
SCREENSHOT_DIR="C:/Users/osia3/GitProjects/claudeclone/lllmAgents/screenshots"

# 実行ディレクトリへ移動
cd "C:/Users/osia3/GitProjects/claudeclone/lllmAgents"

echo "Starting sequential capture from ${START_SEED} to ${END_SEED}..."
echo "Mode: Single-process (Sequential) for maximum stability."

# シード値を1つずつ順番に処理
for SEED in $(seq ${START_SEED} ${END_SEED}); do
    # 既存ファイルの確認
    EXISTING_FILE=$(ls ${SCREENSHOT_DIR}/minecraft-${SEED}-bedrock-*.png 2>/dev/null | head -n 1)

    if [ -n "$EXISTING_FILE" ]; then
        echo "[Skip] Seed ${SEED} already exists: ${EXISTING_FILE}"
    else
        echo "[Process] Capturing Seed ${SEED}..."
        # 単一プロセスで実行し、完了を待機する
        if node "${CAPTURE_SCRIPT}" "${SEED}"; then
            echo "[Success] Seed ${SEED} completed."
        else
            echo "[Error] Seed ${SEED} failed. Stopping to prevent further errors."
            exit 1
        fi
    fi
done

echo "Batch capture process completed successfully."
