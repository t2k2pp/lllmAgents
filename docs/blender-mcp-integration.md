# Blender MCP 連携 — 改修ポイント整理

> **作成日**: 2026-05-03

---

## 結論: セットアップのみで利用可能（コード改修不要）

本アプリ（LocalLLM Agent）は汎用的な **MCP (Model Context Protocol) クライアント機構**（`src/mcp/`）を既に実装済みであり、Blender MCP サーバーは **設定ファイルの追加のみ** で接続・利用可能です。アプリケーションコードの改修は不要です。

---

## 1. アーキテクチャ適合性の分析

### 1.1 Blender MCP の通信方式

| 項目 | Blender MCP の仕様 | 本アプリの対応状況 |
|:---|:---|:---|
| **プロトコル** | JSON-RPC 2.0 (MCP準拠) | ✅ `MCPClient` が完全対応 |
| **トランスポート** | stdio (`uvx blender-mcp` を子プロセスとして起動) | ✅ `connectStdio()` で対応済み |
| **初期化フロー** | `initialize` → `notifications/initialized` → `tools/list` | ✅ `MCPClient.connect()` で実装済み |
| **ツール呼び出し** | `tools/call` | ✅ `MCPClient.callTool()` で対応済み |
| **ツール自動登録** | MCPサーバーが公開するツールを動的に取得 | ✅ `MCPManager.createToolHandlers()` → `ToolRegistry.register()` |

### 1.2 Blender MCP が提供するツール（代表例）

Blender MCP サーバーは `tools/list` で以下のようなツールを公開します:

- `get_scene_info` — シーン全体の情報取得
- `create_object` — 3Dオブジェクト作成
- `modify_object` — オブジェクト変更
- `delete_object` — オブジェクト削除
- `set_material` — マテリアル適用
- `execute_blender_code` — 任意のPythonコード実行
- `get_polyhaven_categories` — Poly Haven アセット検索
- `download_polyhaven_asset` — Poly Haven アセットダウンロード
- `get_hyper3d_rodin_status` — Hyper3D 3Dモデル生成

これらは自動的に `mcp__blender__get_scene_info` のようにプレフィックス付きでToolRegistryに登録され、LLMから呼び出し可能になります。

---

## 2. セットアップ手順

### 2.1 前提条件

- **Blender 3.0以上** がインストール済みであること
- **Python 3.10以上** がインストール済みであること
- **uv パッケージマネージャー** がインストール済みであること

```bash
# macOS
brew install uv
```

### 2.2 Blender アドオンのインストール

1. [blender-mcp リポジトリ](https://github.com/ahujasid/blender-mcp) から `addon.py` をダウンロード
2. Blender を起動
3. **Edit > Preferences > Add-ons** を開く
4. **Install...** をクリックし、ダウンロードした `addon.py` を選択
5. **Interface: Blender MCP** の横のチェックボックスを有効化

### 2.3 MCP サーバー設定ファイルの作成

以下の **いずれか** のパスに `mcp-servers.json` を配置します（読み込み優先度順）:

| 優先度 | パス | 用途 |
|:---:|:---|:---|
| 1 | `~/.localllm/mcp-servers.json` | ユーザーグローバル（推奨） |
| 2 | `{プロジェクト}/.localllm/mcp-servers.json` | プロジェクト固有 |
| 3 | `{プロジェクト}/.claude/mcp-servers.json` | Claude Code 互換 |

#### 基本設定（推奨）

```json
{
  "mcpServers": {
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"],
      "transport": "stdio"
    }
  }
}
```

#### テレメトリ無効化設定

```json
{
  "mcpServers": {
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"],
      "transport": "stdio",
      "env": {
        "DISABLE_TELEMETRY": "true"
      }
    }
  }
}
```

#### リモートBlender接続設定

Blenderが別マシンで動作している場合:

```json
{
  "mcpServers": {
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"],
      "transport": "stdio",
      "env": {
        "BLENDER_HOST": "192.168.1.100",
        "BLENDER_PORT": "9876"
      }
    }
  }
}
```

### 2.4 使用開始

1. **Blender** を起動し、サイドバー（Nキー）の **BlenderMCP** タブで **Connect to Claude** をクリック
2. **LocalLLM Agent** を起動（`npm run start`）
3. 起動ログに `✓ MCP: blender (N tools)` と表示されれば接続成功
4. 自然言語で3Dモデリング指示を行う

---

## 3. セキュリティに関する注意事項

**⚠️ 重要**: Blender MCP の `execute_blender_code` ツールは **Blender内で任意のPythonコードを実行** します。
本アプリの `PermissionManager` による権限確認が適用されるため、初回実行時にユーザー承認が求められますが、
`autoApproveTools` に追加した場合は無確認で実行されるため注意が必要です。

### 推奨セキュリティ設定

MCPツールに対する権限レベルを `mcp-servers.json` 内で制御できます:

```json
{
  "mcpServers": {
    "blender": {
      "command": "uvx",
      "args": ["blender-mcp"],
      "transport": "stdio",
      "permissionLevel": "ask"
    }
  }
}
```

- `"ask"` (デフォルト): 毎回ユーザー確認を求める
- `"auto"`: 自動許可（信頼できる環境のみ推奨）

---

## 4. コード改修が不要である根拠

| 機能 | 実装箇所 | 対応状況 |
|:---|:---|:---|
| MCP設定ファイルの読み込み | `MCPManager.loadConfig()` | ✅ 3つのパスから自動検索 |
| stdio子プロセスの起動・管理 | `MCPClient.connectStdio()` | ✅ `spawn()` + stdin/stdout管理 |
| JSON-RPC 2.0 通信 | `MCPClient.sendRequest()` | ✅ リクエスト/レスポンスの非同期管理 |
| ツールの動的発見・登録 | `MCPManager.connectAll()` | ✅ `tools/list` → ToolHandler変換 → ToolRegistry登録 |
| ツール名の名前空間分離 | `mcpToolName()` | ✅ `mcp__blender__<tool>` 形式 |
| 権限管理との統合 | `PermissionManager` | ✅ MCPツールにも同一ポリシー適用 |
| フックとの統合 | `HookManager` | ✅ MCPツールにも PreToolUse/PostToolUse 適用 |
| タイムアウト | `REQUEST_TIMEOUT_MS` | ✅ 5分（長時間の3D処理にも対応可能） |
| コンテンツブロック処理 | `extractText()` | ✅ text/image/resource 型対応 |
| クリーンアップ | `MCPManager.disconnectAll()` | ✅ 終了時に子プロセス SIGTERM → SIGKILL |

---

## 5. Skillで拡張する場合（オプション）

Blender操作のワークフローを定型化したい場合、**Skill**を作成して効率化できます。ただし、これは必須ではなくオプションです。

### 例: Blender 3Dシーン作成スキル

`.localllm/skills/blender-scene.md`:

```markdown
---
name: blender-scene
description: Blender 3Dシーン作成ワークフロー
trigger: /blender-scene
---
# Blender 3D シーン作成

## When to Use
ユーザーが Blender で3Dシーンを作成したいとき

## How It Works
1. `mcp__blender__get_scene_info` で現在のシーン情報を確認
2. ユーザーの要望に基づきオブジェクトを作成・配置
3. マテリアルを適用
4. ライティングとカメラの設定
5. 完成したシーンの情報をユーザーに報告

## Rules
- 既存のオブジェクトを削除する前に必ずユーザーに確認する
- 複雑な操作は `execute_blender_code` ではなく個別ツールを優先使用する
- Poly Haven のアセットが利用可能な場合は積極的に提案する
```

---

## 6. トラブルシューティング

| 症状 | 対処法 |
|:---|:---|
| `⚠ MCP: blender 接続失敗` | `uv` がインストール済みか確認: `which uvx` |
| ツール呼び出しでタイムアウト | Blender側のアドオンが **Connect to Claude** されているか確認 |
| `Connection refused` | BlenderのソケットサーバーがポートL9876でlistenしているか確認 |
| 起動時にMCPツールが0個 | Blenderアドオンが未起動の場合、サーバー起動成功でもツール0個になることがある。Blender側で接続後にアプリを再起動 |

---

## 7. まとめ

| 項目 | 結論 |
|:---|:---|
| **アプリコード改修** | **不要** |
| **必要な作業** | ① Blenderアドオン導入 ② `mcp-servers.json` 設定 ③ Blender側で接続 |
| **Skill作成** | オプション（ワークフロー定型化したい場合のみ） |
| **セキュリティリスク** | `execute_blender_code` による任意コード実行に注意 |
