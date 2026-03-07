---
name: chunkbase-screenshot
description: Chunkbaseのシードマップの指定領域をスクリーンショットして保存します。シード値を受け取り、確実にキャプチャを実行します。
trigger: /chunkbase
---

# Chunkbase Screenshot Skill

## 概要

このスキルは、ユーザーから提供されたシード値を元に、Chunkbase シードマップ（Minecraft）の特定領域のスクリーンショットを確実に撮影し、保存するためのものです。
ブラウザ操作の不確実性を排除するため、決定論的な専用スクリプト (`scripts/capture.js`) を実行して処理を行います。

## 実行要件

- ユーザーから `seed` (シード値) を受け取ります。引数がない場合は `ask_user` スキルなどを活用してシード値を特定して下さい。
- スクリーンショットは `screenshots/` フォルダ配下に `minecraft-{seed}-bedrock-{YYYYMMDD_HHMMSS}.png` という名前で保存されます。

## 実行手順 (Low Freedom)

本スキルは完全にスクリプト化されているため、手順は固定されています。

1. コマンド引数やユーザーとの会話から `seed` (シード値) を特定します。
2. `bash` ツールを使用して、以下のコマンドを実行します。シード値 (`<seed>`) は実際のものに置き換えてください。
   
   ```bash
   node .localllm/skills/chunkbase-screenshot/scripts/capture.js <seed>
   ```

3. スクリプトの実行が成功すると、保存先のファイルパスが出力されます。実行結果（成功・失敗・保存先パス）を要約してユーザーに報告してください。

**重要**:
このスキルでは、LLM自身が `browser_navigate` や `browser_screenshot` 等のブラウザ操作ツールを使用することは**禁止**されています。必ず `bash` ツールで上記のスクリプトを実行してください。
