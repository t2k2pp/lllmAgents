# LLMプロファイル説明機能

## 目的

メインLLMとセカンドLLMそれぞれに「モデル特性」の自由記述フィールド（100〜300文字推奨）を持たせ、システムプロンプトに注入する。メインLLMが `task` / `second_llm_agent` / `second_llm_consult` のどれで委任すべきかを、両モデルの特性を比較して判断できるようにする。

## 背景

- `task` ツール（サブエージェント） = メインLLM で実行
- `second_llm_agent` / `second_llm_consult` = セカンドLLM で実行
- 従来はシステムプロンプトに「セカンドLLMツール利用可能」の1行しかなく、メインLLMが「このタスクはどちらのLLMに委任すれば良いか」を判断する材料がなかった
- 実際の運用では「メインがMoEで日本語堅牢・中速」「セカンドがDenseでコーディング特化・高速・日本語苦手」など特性差がある。それを明示することで適切なルーティングが可能になる

## 設計

### 1. Config スキーマ拡張 (`src/config/types.ts`)
```ts
interface LLMEndpoint {       // メインLLM
  ...
  description?: string;        // 追加: モデル特性の自由記述
}

interface SecondLLMEndpoint {  // セカンドLLM
  ...
  description?: string;        // 追加
}
```
既存 config.json との後方互換を保つため optional。

### 2. システムプロンプト注入 (`src/agent/system-prompt.ts`)

`buildSystemPrompt(skills, hasSecondLLM, hasObsidian, llmProfiles)` に第4引数 `llmProfiles: LLMProfiles` を追加。`LLMProfiles` は以下を含む:
- `main: { model, providerType, baseUrl?, description? }`
- `second?: { ... }` — セカンドLLMが有効なときのみ
- `parallelCapable?: boolean` — メインとセカンドが異なるマシンで動作しているか

出力形式:
```
# 利用可能なLLMモデル
あなた (メインLLM): <model> (<provider> @ <url>)
特性: <description> または (未設定 — ユーザーが /model description <text> で設定可能)

セカンドLLM: <model> (<provider> @ <url>)  ← 別マシン / 同一マシン
特性: <description>

サブタスク委任時の選択指針:
- task ツール → メインLLM (あなた自身) を別コンテキストで起動
- second_llm_agent ツール → セカンドLLMをツール付きエージェントとして起動
- second_llm_consult ツール → セカンドLLMに単発質問
両モデルの特性を見て、タスクの性質に合う方を選ぶこと。
独立した複数タスクがあるときは task と second_llm_agent を並列起動することで総所要時間を短縮できる。  ← parallelCapable=true のみ
```

### 3. 並列判定 (`src/agent/llm-profiles.ts`)

`buildLLMProfiles(config, hasSecondLLM)` が `parallelCapable` を以下で判定:
- セカンドLLMがクラウド（vertex-ai / azure-*） → 常に `true`（別マシン確定）
- ローカル同士 → `baseUrl` のホスト+ポートが異なれば `true`、同じなら `false`
- 同じマシンでの並列は GPU KV キャッシュを取り合うため、システムプロンプトでは「逐次実行推奨」と注意を出す

### 4. REPL コマンド (`src/cli/repl.ts`)

- `/model description` — 現在値表示＋使い方＋記載例
- `/model description <text>` — 設定
- `/model description clear` — クリア
- `/second description` / `/second description <text>` / `/second description clear` — 同上
- `/model info` と `/second status` の出力に特性を表示
- 設定直後 `REPL.refreshLLMProfiles()` が `AgentLoop.updateLLMProfiles()` を呼び、次ターン以降のシステムプロンプトに反映

### 5. Setup ウィザード (`src/config/setup-wizard.ts`)

メインLLM選択後に任意で description を入力するプロンプトを追加（空のままEnterでスキップ可、後から `/model description` で設定可能）。

セカンドLLM の description はウィザード対象外。REPL の `/second setup` → `/second description <text>` の流れで設定する。

## 動作確認

`sandbox/test_llm_profile_prompt.ts` で4ケース検証:
1. メインのみ、description 未設定 → 「未設定」ヒント表示
2. 同一マシン (parallelCapable=false) → 並列非推奨メッセージ
3. 別マシン (parallelCapable=true) → 並列推奨行が追加
4. クラウドセカンド (parallelCapable=true) → baseUrl 無しでも並列可能と判定

## 将来拡張余地

- `task` ツールに `use_model: "main" | "second"` パラメータを追加して、メインLLM側から明示的にどちらで実行するか指定できるようにする（現状は「task=メイン固定」「second_llm_agent=セカンド固定」で十分、descriptions で誘導）
- visionLLM にも description を付ける（今回スコープ外）
