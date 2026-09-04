# 設計書: モデルパス対応の能力Tier解決および起動時例外可視化

- 作成日: 2026-09-04
- 課題: `sandbox/run.sh` 実行時に MCP / Skills スキップログの直後にアプリが何のエラーも表示せず終了してしまう問題の是正

---

## 1. 背景と根本原因の分析

### 1.1 事象
ユーザーが `sandbox` ディレクトリで `./run.sh` を実行したところ、以下の出力が行われて即座にプロセスが終了した。
```
  MCP: 2 server(s) skipped by config.disabledMcpServers
  ○ MCP: blender skipped (runtime skip)
  ○ MCP: drawdot skipped (runtime skip)
  MCP: 2 server(s) skipped by configuration
  Skills: 16 skill(s) skipped by config.disabledSkills
```
ターミナルには何のエラーメッセージも表示されない。

### 1.2 原因1: Alternate Screen によるエラー表示の消失（サイレント終了）
- `src/index.ts` では起動直後に `installOutputRouter()` と `screen.start()` が呼ばれ、ターミナルが TUI の Alternate Screen（代替画面バッファ）に切り替わる。
- 初期化中（`new AgentLoop` 内など）に例外が発生すると、`main().catch((e) => { console.error("Fatal error:", e); process.exit(1); })` に渡る。
- この時点では Alternate Screen 内のままであり、`console.error` は Alternate Screen に出力される。
- その直後の `process.exit(1)` により `process.on("exit", restoreOutput)` が走り、`screen.stop()` で通常の画面に戻る。
- Alternate Screen 内の出力内容は画面復元時に破棄されるため、通常画面には `screen.start()` 前のログのみが残り、エラーメッセージが一切見えずに静かに終了したように見える。

### 1.3 原因2: パス付きモデル名および Qwen Flash-Next 系の能力 Tier 自動判定失敗
- ユーザーの `~/.localllm/config.json` では以下のようにローカルモデルが設定されている:
  `"model": "/home/osia/llama.cpp/models/Qwen3.8-Flash-Next/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf"`
- `src/agent/capability-tier.ts` の `resolveCapability` では:
  1. `KNOWN_MODELS` は完全一致のみ（パスが付いていると一致しない）。
  2. `PATTERN_RULES` は `^qwen3` など前方一致（`^` アンカー）を前提としており、`/home/osia/...` から始まるパスでは一致しない。
  3. パスを剥がしたとしても、`Qwen3.8-Flash-Next` はパラメータ数表記（`\d+b`）を含まないため `inferTierFromName` にも既存パターン（`32b|35b|...`）にも一致しない。
  4. その結果、「未知モデル ... の能力tierを自動判定できません」という例外がスローされ、起動が中断していた。

---

## 2. 設計方針

### 2.1 起動時例外ハンドリングの改善
- `main()` のエラー捕捉時（`main().catch` または `try...catch`）において、まず確実に `restoreOutput()`（`screen.stop()` と `uninstallOutputRouter()`）を実行して通常画面に戻し、標準エラー出力の差し替えを解除してから `console.error` でエラー内容を出力する。
- 未捕捉例外時と同様に `writeCrashLog` も活用し、クラッシュログの保存先も提示して診断性を最大化する。

### 2.2 パス付きモデル名の階層的解決
- `resolveCapability(modelId, ...)` において、`modelId` にパス区切り文字（`/` または `\`）が含まれる場合、以下の候補を生成して判定を試みる:
  1. 指定されたそのままの `modelId`
  2. ファイル名（basename）: `Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf`
  3. 拡張子（`.gguf` 等）を取り除いたファイル名: `Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003`
  4. 分割接尾辞等を取り除いたモデル名または親ディレクトリ名: `Qwen3.8-Flash-Next`
- いずれかの候補で `KNOWN_MODELS`、`PATTERN_RULES`、`inferTierFromName` にマッチすれば、その結果を採用する。

### 2.3 Qwen Flash / Next / Turbo 系の Tier 判定の追加
- `PATTERN_RULES` に以下を追加:
  - `{ pattern: /^qwen3.*-?(flash|next|turbo)/i, tier: "T2", reason: "Qwen3 Flash/Next/Turbo 系 (中堅)" }`
- Qwen3.8-Flash-Next などの Flash/Next 系モデルは、高性能な MoE/軽量推論モデルであり、native function calling / parallel tools を備えた中堅（T2）クラスとして分類する。

### 2.4 `getCapabilityOverride` の basename / 短縮名サポート
- `AgentLoop.getCapabilityOverride` において、`config.json` の `modelCapabilities` のキーがフルパスだけでなく、basename（例: `Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf`）や親ディレクトリ名（`Qwen3.8-Flash-Next`）で指定されている場合もマッチするように柔軟化する。

### 2.5 ビルドとデプロイの同期
- `sandbox/run.sh` は `deploy/localllm` を実行するため、修正後は `npm run build` および `npm run build:deploy` を実行してバイナリを更新し、`sandbox/run.sh` が正常に起動することを確認する。

---

## 3. 影響範囲
- `src/index.ts`: 起動時例外処理の順序変更（画面復元後にエラー出力）
- `src/agent/capability-tier.ts`: パス付きモデル名の basename 抽出と Qwen Flash/Next パターン追加
- `src/agent/agent-loop.ts`: override 検索時の basename / 短縮名マッチ対応
- `tests/agent/capability-tier.test.ts`: 新規パターンの単体テスト
- `deploy/localllm`: ビルド生成物更新
