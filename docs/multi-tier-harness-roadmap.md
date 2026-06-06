# lllmAgents 100 点超えロードマップ — マルチティア・ハーネス戦略

> **目的**: ローカル LLM を含むマルチプロバイダ AI エージェントとして、 Claude Code を 100 点としたとき同等以上 (目標 107 点 ※ F-1 訂正反映) を目指す改善設計。
>
> **核心原則**: ハーネス工学は LLM の能力ティアに適応する。 賢い LLM (Claude/GPT-5) のための工夫が、 弱い LLM (7B ローカル) の足枷になってはいけない。 逆に弱い LLM 向けの scaffolding が、 賢い LLM を萎縮させてもいけない。
>
> **位置づけ**: `docs/agent-loop-efficiency-review.md` (P0-P3) は「振る舞いの効率化」 を扱った。 本書はその上位レイヤとして「能力ティアに応じた harness 設計」 を扱う。
>
> **作成日**: 2026-05-07

---

## 0. エグゼクティブサマリ

| Phase | 概要 | 点数寄与 |
|---|---|---:|
| 現状 | 35 / 100 | — |
| **A** | 能力ティア基盤 (capability profile, runtime tier resolver) | +5 |
| **B** | ティア別 system-prompt + tool description (DX) | +8 |
| **C** | ティア別ループ制御 (反復上限・自己点検深度・検証粒度) | +6 |
| **D** | ローカル LLM 特有の工夫 (tool format 正規化, decision-tree, few-shot, ctx 最適化) | +18 |
| **E** | 100 点超え機能 (自己改善ハーネス, federated reasoning, auto model selection, schema-strict I/O) | +22 |
| **F** | エコシステム拡張 (MCP 周辺強化, streaming UX, テストランナ, テレメトリ) | +13 |
| **合計** | | **35 → 107** (※ F-1 訂正で -5) |

主張は次の 1 行に集約される:

> 既存の P0–P3 (前バッチで実装済み) は 35 点 → 41 点相当の効率改善。 100 点超えには、 **「ハーネスを LLM 能力ティアに適応させる」** という上位原則を導入し、 Claude Code が暗黙に持つ「ユーザは Claude を使う」 前提を、 lllmAgents は「ユーザは様々な LLM を使う」 前提として明示的に設計しなおす。

---

## 1. 現状の客観評価 (35/100) — 軸別の分解

| 軸 | 現在 | 100 点像 | gap |
|---|---:|---|---|
| 基本ループ品質 | 5 | self-healing、 stuck-loop ゼロ、 反復浪費が観測限界以下 | -5 |
| ツールの幅と深さ | 4 | MCP, IDE, plugins, ファイル/ブラウザ/DB/API の各シリーズが揃う | -6 |
| エラー回復・行動安全性 | 3 | 破壊的操作の自動 stash、 ツール側 hard gate、 状態スナップショット | -7 |
| マルチプロバイダ対応 | 8 | 7 プロバイダの parity + auto routing | -2 |
| 日本語 UX | 8 | i18n 完備で他言語 parity も確保 | -2 |
| 観測性・ログ | 7 | リアルタイム指標、 自動分析レポート | -3 |
| ドキュメント・設計書文化 | 7 | 内部設計が読める + 利用者向けガイド + プラグイン作者向けドキュメント | -3 |
| コミュニティ・エコシステム | 1 | プラグイン公開、 サンプル集、 コミュニティスキル流通 | -9 |
| 高度機能 (sub-agent / plan / evaluator) | 5 | 完全に組み込み、 ティア別最適化済 | -5 |
| ストリーミング / 対話品質 | 4 | 主要 IDE 統合、 progress UI、 中断・再開 | -6 |
| **小計 (10 軸 × 10 点満点)** | **52** | | |
| **加重平均 (UX / 機能性に倍率)** | **35** | | |

(注) 加重は「個人ユーザの体感に響くもの」 を重く取る。 機能カバレッジだけでは「使う気になるか」 は決まらないため。

---

## 2. 核心の設計原則 — Capability-Aware Harness

### 2.1 原則の言語化

| | 賢い LLM 向け原則 (T1) | 弱い LLM 向け原則 (T3) |
|---|---|---|
| Trust | 信頼する。 自己判断に任せる | 構造を与える。 道を狭くする |
| Scaffolding | 最小。 邪魔しない | 厚い。 例示と分解 |
| Tool description | 簡潔。 description が単一の真実源 | 詳細。 few-shot 例を埋め込む |
| 自己点検 | 明白に壊れている時のみ発動 | 標準的に発動。 短い質問でも確認 |
| 反復上限 | 高め (Claude は深掘りが得意) | 低め (small model はドリフトが速い) |
| エラー応答 | エラー文だけで十分 | エラー文 + 取るべき手順 + 例 |

### 2.2 「足枷にならない」 ための具体策

賢い LLM 向けの工夫が弱い LLM の足を引っ張る典型例 → 回避策:

1. **長大な system prompt** → T3 では刈り込む。 T1 向けの Acceptance Criteria 規約は T3 では「タスクをこの形式で書け」 という決め打ちフォーマットに置換
2. **巧妙な暗黙ルール** (例: 「response_complete を呼んでから終わる」) → T3 では構造的 hard gate へ。 ツール側で「呼ばないと終われない」 形にする
3. **複数選択肢 (a/b/c の中から判断)** → T3 では二択化。 「やる / 中断する」 の binary
4. **メタ指示** (例: 「自己点検を発動します」) → T3 ではメタ言語をなくし、 直接「次に X を実行してください」 に変換
5. **多段階分解の暗黙化** → T3 では明示的 plan-act-verify 三段で外部から制御する

逆に弱い LLM 向けの工夫が賢い LLM の足を引っ張る典型例 → 回避策:

1. **過剰な例示** → T1 では例示を非表示に。 description の `[T3 only]` セクションは T1 で隠す
2. **強制的 plan-mode** → T1 は内省で十分。 plan-mode は user/T3 が要求した時のみ
3. **過剰な自己点検** → T1 では monitoring のみで干渉せず
4. **冗長な確認 ask_user** → T1 は必要な時だけ。 T3 は心配な時に積極的に
5. **decision-tree 的な狭い prompt** → T1 は自由形式の方が高品質

---

## 3. 能力ティアの定義と自動判定

### 3.1 3 ティア体系

| Tier | 代表モデル | 特徴 | ハーネスの基本姿勢 |
|---|---|---|---|
| **T1** | Claude 4.X, GPT-5 系, Gemini 2.5 Pro | tool-use 信頼、 暗黙ルール理解、 200K+ ctx, 強い指示追従 | 最小介入、 信頼ベース |
| **T2** | Kimi-K2, Qwen3 32B+, Llama 3.3 70B, GPT-4o | tool-use OK、 中程度のドリフト、 32K-128K ctx | 標準介入、 ガードレール |
| **T3** | Llama 7-13B, Mistral 7B, Qwen 7-14B, Phi-4 | tool-use 不安定、 短文応答が多い、 4K-32K ctx、 即ドリフト | 厚いスキャフォールド、 hard gate 中心 |

### 3.2 自動判定ロジック (`src/agent/capability-tier.ts`)

> **訂正 (2026-05-07)**: 当初設計では `CapabilityProfile.contextWindow` を tier 表で
> 持つことを提案したが、 これは既存システム (`src/index.ts` の 4 段 chain と
> `providers/utils/context-length.ts:inferContextLength`) と重複する余計な層だった。
> tier 判定と contextWindow の真値解決は直交させ、 tier テーブルは contextWindow を
> 持たない設計に修正済 (`KNOWN_MODELS.contextWindow` を全削除、 `inferContextLength` に統一)。
> 下記コードは修正後の正しい姿:

```ts
export type Tier = "T1" | "T2" | "T3";

interface CapabilityProfile {
  tier: Tier;
  contextWindow: number; // フィールドは保持 (consumers が読む)、 値の出所は外部
  supportsToolCalling: "native" | "json-mode" | "regex-fallback";
  supportsParallelTools: boolean;
  reliableInstructionFollowing: boolean;
  promptStyle: "concise" | "standard" | "verbose+examples";
  // ループ制御チューナブル (Phase C で追加)
  maxIterations: number;
  maxSelfCheckRounds: number;
  compressionThreshold: number;
  toolResultTruncateBytes: number;
  bashCumulativeWarnEnabled: boolean;
  planTodoOveruseEnabled: boolean;
  keepRecentMessages: number;
}

// tier 判定のみ。 contextWindow は持たない
const KNOWN_MODELS: Record<string, Partial<CapabilityProfile> & { tier: Tier }> = {
  "claude-opus-4-7": { tier: "T1" },
  "kimi-k2.6": { tier: "T2" },
  "llama-3.2-7b": { tier: "T3", supportsToolCalling: "regex-fallback" },
  // ...
};

export function resolveCapability(
  modelId: string,
  ctxWindow?: number, // src/index.ts の 4 段 chain で解決された値が来る
  override?: CapabilityOverride,
): CapabilityProfile {
  // contextWindow は別経路で 1 回だけ解決:
  //   引数 ctxWindow → inferContextLength(modelId) → FALLBACK_CONTEXT_WINDOW
  const resolvedCtx = resolveContextWindow(modelId, ctxWindow);
  // tier 判定: KNOWN_MODELS → PATTERN_RULES → 名前ヒューリスティック → T2 fallback
  // (tier 判定は contextWindow とは独立)
  ...
}
```

**設計原則**: 同じ情報の出所は 1 つに統一する。 `contextWindow` の真値は provider
が知っており、 知らなければヒューリスティック (`inferContextLength`) → fallback の順。
tier テーブルが独自の数値を持つと矛盾と保守負担を生む。

### 3.3 ユーザによる手動 override

```jsonc
// ~/.localllm/config.json
{
  "models": {
    "my-custom-llama": {
      "tier": "T3",
      "promptStyle": "verbose+examples",
      "contextWindow": 8192
    }
  }
}
```

ヒューリスティックで誤判定が出るケース (fine-tune モデル、 自社運用 vLLM 等) のための手動 override。

### 3.4 起動時にティアをユーザに通知

```
[capability] model=qwen3.6-35b-a3b → tier=T2 (verbose tool descriptions, 30 iter soft cap, plan-mode hint enabled)
```

ブラックボックス化を避ける。 認識が誤っているなら `/capability set` で訂正できるようにする。

---

## 4. ティア別ハーネス挙動マトリクス

凡例: ✅= 既定で発動 / 🟡= 軽量版 / ⬜= 抑制 / ❌= 無効化

| 機能 (実装場所) | T1 | T2 | T3 | 備考 |
|---|:-:|:-:|:-:|---|
| **既存機能 (P0-P3 含む)** | | | | |
| MAX_TOOL_ITERATIONS hard cap | 100 | 80 | 50 | T3 はドリフト早い |
| レジスター宣言 (`このタスクは X として`) | 🟡推奨 | ✅必須 | ❌自動推論 | T3 は user 入力分類で代替 |
| Acceptance Checklist | ✅ | ✅ | 🟡簡略版 | T3 は 3 項目以下 |
| sliding-window 失敗検知 (P0-A) | ✅ | ✅ | ✅+簡素な助言 | 助言文を短く |
| file_edit ±20 行スニペット (P0-B) | ✅ | ✅ | ✅ | Tier 関係なく有用 |
| edit 直後 file_read 禁止ルール | 🟡prompt 1 行 | ✅prompt 明示 | ❌ハード拒否 | tool 側で reject |
| bash 累積警告 (P1-A) | ❌ | ❌ | ❌ | 2026-05-09 全 tier OFF (誤発火 + T1 で作業中断副作用を観測) |
| plan/todo 過多検知 (P1-B) | 🟡 | ✅ | ❌ | T3 は plan-mode 自体を抑制 |
| browser_snapshot キャッシュ (P2-A) | ✅ | ✅ | ✅ | Tier 非依存 |
| 圧縮閾値 0.7 (P2-B) | 0.7 | 0.6 | 0.5 | T3 は ctx 狭いため早めに |
| 大 tool_result 要約 (P2-B) | >20KB | >12KB | >6KB | T3 はノイズ感受性高い |
| レジスター別ソフトキャップ (P3-A) | ✅ | ✅ | ❌→ 4.x の hard cap | T3 は単に hard cap で打ち切る |
| 破壊的 bash の git status 添付 (P3-B) | ✅短文 | ✅標準 | ✅+復旧手順例 | T3 は手順を例示 |
| **新規機能 (本ロードマップで追加)** | | | | |
| Tool description verbose 版 | ❌短い | 🟡中 | ✅長 + 例 | description tier 切替 |
| Few-shot 自動注入 (B-1) | ❌ | 🟡初回のみ | ✅初回 + 失敗時 | `~/.localllm/few-shots/` から |
| Decision-tree mode (D-2) | ❌ | ❌ | ✅曖昧時 | binary 二択化 |
| Tool-call format 正規化 (D-1) | 🟡fallback | 🟡fallback | ✅必須 | regex 抽出 → 構造化。 2026-05-13 に T1 でも有効化 (gpt-5.x reasoning が thinking に <tool_call> を吐く事例)。 `toolCalls.length===0` のときのみ発火し native function calling と非競合 |
| Federated reasoning (E-2) | ✅監督役 | 中継 | ✅作業役 | T1 が T3 を率いる |
| Auto model selection (E-3) | ✅ | ✅ | ✅ | タスクから tier を推定 |
| Schema-strict tool I/O (E-4) | ❌不要 | 🟡 | ✅ | json-schema validation |
| 自己改善ハーネス (E-1) | ✅メタ分析対象 | ✅ | ✅ | 全 tier のログを集約 |

**重要観察**: T3 でだけ発動する scaffolding (few-shot, decision-tree, format 正規化) と、 T1 でだけ発動する trust (verbose 抑制, plan-mode 任意, hard gate 緩和) を厳密に分けることで、 「賢いLLM の足枷」 と「弱いLLM の不足支援」 の両立を実現する。

---

## 5. ロードマップ Phase A–F

### Phase A: 能力ティア基盤 (foundation, +5 点)

**目的**: ティア概念を実装し、 既存ハーネスから参照できるようにする。

**実装内容**:
- `src/agent/capability-tier.ts` 新設 — `resolveCapability(modelId, ctxWindow)` を export
- `~/.localllm/config.json` に `models.<modelId>.tier` 等の override スキーマを追加 (`config-manager.ts` 拡張)
- `AgentLoop` クラスに `private capability: CapabilityProfile` を持たせ、 model 切替時に再解決
- 起動時 / `/model` 切替時にティアをログ出力 (透明性)
- 既存の P0-P3 機能を `if (tier === ...)` で分岐できるよう、 各 helper を `capability` 受け取りに改修

**完了条件**:
- gpt-5.4 → T1 / kimi-k2.6 → T2 / llama-3.2-7b → T3 と判定できる
- `/capability` slash command で現在のティアと profile を表示できる
- 既存テストが全て通る + 新たに `capability-tier.test.ts` で 30+ モデル名の判定をカバー

**期待効果**: ここ単体ではユーザ体験は変わらない。 後続 Phase B-E の前提になる。

---

### Phase B: ティア別 system-prompt + tool description (+8 点)

**目的**: T1 では簡潔・T3 では verbose な指示を出し分け、 「賢いには軽く、 弱いには厚く」 を実現。

**実装内容**:
- **system prompt**: `buildSystemPrompt(capability, ...)` に変更。 ティアに応じて以下を切替:
  - T1: 「対話レジスター」 規約を 3 行で要約。 self-check の発動は最小化を明記
  - T2: 現行の system prompt を維持
  - T3: register/Acceptance/verification を**簡素なテンプレート**に置換。 「タスク開始時にこの 3 行で answer を書け: (a) 何を作るか (b) どのファイルに書くか (c) 検証方法」
- **tool description**: `tier`-aware description を返す `buildToolDescription(toolName, capability)` を追加
  - T1: 現行の 3 行版 (使うべき場面 / 使うべきでない / よくある誤用)
  - T2: 同上 + `[副次情報]` 1 行
  - T3: 同上 + `[例]` セクションで few-shot を 1-2 件埋め込む
- **shared-principles.ts** をティア対応に分割: `buildRegisterRules(tier)`, `buildVerificationRules(tier)` 等

**完了条件**:
- T3 で system prompt サイズが T1 比で 30% 以上短くなる (ctx 節約)
- T1 で system prompt の冗長な scaffolding が消えている
- 各 tier で実モデル動作確認: T3 が「タスクを 3 行で書く」 形式を守れる

**期待効果**: T3 ではドリフト減少 (検証文化が定着)。 T1 では応答品質向上 (指示が邪魔しない)。

---

### Phase C: ティア別ループ制御 (+6 点)

**目的**: 反復上限・自己点検・圧縮閾値・検証深度を tier ごとに最適化。 既存の hard-coded 値を可変化。

**実装内容**:
- `MAX_TOOL_ITERATIONS` を `capability.maxIterations` に置換 (T1=100, T2=80, T3=50)
- `MAX_SELF_CHECK_ROUNDS` も tier 別 (T1=3, T2=2, T3=1)
- ContextManager `threshold` を tier 別 (T1=0.7, T2=0.6, T3=0.5)
- 大 tool_result の truncate 閾値を tier 別 (T1=20KB, T2=12KB, T3=6KB)
- Plan-mode 突入の hard gate 化 (T3 のみ): `enter_plan_mode` を tool-level で reject し、 「T3 ではプランは外部から与える」 ポリシーを実現

**完了条件**:
- 同じ問題を T1/T2/T3 で解かせ、 各 tier で適切な反復数 / ctx 使用率に収まる
- 既存 P0-P3 機能と齟齬がない (P3-A のソフトキャップ表は capability 参照に統合)

**期待効果**: T3 でドリフト早期発見 → ユーザに早く戻る。 T1 で過度な圧縮を回避し品質維持。

---

### Phase D: ローカル LLM 特有の工夫 (+18 点)

最も差別化できる Phase。 賢い LLM 向け Agent では不要だが、 弱い LLM では必須の機能群。

#### D-1: Tool-call format 正規化 (+4)

問題: 7B モデルは OpenAI tool-calling 形式を完全に守らない。 vLLM は Mistral 形式 (`[TOOL_CALLS]...`) を OpenAI 形式に変換できないことがある。

実装:
- `src/agent/tool-call-normalizer.ts` 新設
- T2/T3 のレスポンスから regex で tool 呼び出しを抽出 (Mistral 形式、 ChatML、 ReAct 形式の 3 種に対応)
- 既存の `isGarbageResponse()` (agent-loop.ts:63) を拡張して**正常化を試みる**フォールバックを追加
- T3 で response_complete のような meta tool 呼び出しが守れない場合、 「end of work」 マーカー文字列を抽出して同等扱い

#### D-2: Decision-tree mode (+6)

問題: T3 は曖昧な状況で延々と grind する (例: 「old_string が 2 箇所一致 → どうする?」 で 3 回失敗)。

実装:
- `src/agent/decision-tree.ts` 新設
- Tier T3 で stuck-loop 検出時 (P0-A 既存) に自由形式の self-check ではなく、 binary 質問を発する:
  ```
  [decision] 同じエラーが 2 回続きました。 次にどちらを選びますか?
  A) replace_all=true で再実行
  B) ask_user で人間に確認
  選択を 1 行 (A or B) で答えてください。
  ```
- ツール側で A/B のレスポンスを parse → 直接対応する tool call を生成
- T1/T2 では既存の自由形式 self-check を維持

#### D-3: Few-shot 自動注入 (+4)

問題: T3 は tool description だけでは形式を守れない (引数名を間違える、 path を相対にする等)。

実装:
- `~/.localllm/few-shots/<toolName>.json` に few-shot 集を持つ
- T3 で「初回利用」 または「失敗 1 回後」 にだけ description 末尾に `[例]` で 1-2 件挿入
- few-shots は ops チームが GitHub から download 可能な形に整備

#### D-4: 短ctx ウィンドウ最適化 (+4)

問題: 8K ctx の T3 モデルでは 1 ターン分の I/O ですぐ溢れる。

実装:
- T3 でだけ発動する**aggressive context manager**:
  - keepRecentMessages = 5 (現行 10 から)
  - tool_result を 4KB で truncate (現行 20KB)
  - system prompt を 1500 token 上限で再構築 (現行は CLAUDE.md 込みで 5K+)
  - 階層圧縮を**毎ターン発動** (現行は閾値到達時のみ)
- 失敗例の記録: ctx あふれによる 400 を起こしたら自動で keepRecentMessages を 1 段下げる

**完了条件 (Phase D 全体)**:
- T3 (Llama 3.2 7B + 8K ctx) で「米国株アプリの 1 機能追加」 を 1 ターン以内で完走できる
- T1 では何も劣化しない (T3 専用機能が T1 に漏れない)

**期待効果**: ローカル LLM 利用が現実的になる。 これが「lllmAgents の Claude Code に対する差別化点」。

---

### Phase E: 100 点超え機能 (+22 点)

#### E-1: 自己改善ハーネス (+6)

ハーネスが自身のログから学習する。 既存 `~/.localllm/logs/sessions/` の jsonl を毎晩 / 毎週バッチ分析し:
- stuck-loop 上位の (toolName, errorMsg) を発見
- 該当ツールの description / few-shot を自動更新提案
- レポートを `~/.localllm/reports/weekly-<date>.md` に生成

実装:
- `scripts/analyze-loop.mjs` (既存改善レビューの定式化)
- 毎週 cron で起動可能 (`/loop` 機能と統合)
- 提案は PR にする (人間 review)、 自動 merge はしない

#### E-2: Federated reasoning — supervisor + worker (+8)

賢い LLM (T1) を supervisor に、 ローカル LLM (T3) を worker にする協調パターン。 既存の sub-agent 機構を発展させる。

実装:
- `second_llm_consult` を supervisor 専用に再設計 (今は同等扱い)
- `federated_delegate` 新ツール: T1 が「これは T3 でできる単純作業」 と判断したら T3 へ tool 呼び出しレベルで委譲
- T3 のレスポンスを T1 が validate → fail なら自分でやり直す
- ユーザは T1 のコストを払いつつ T3 の速度・低コストの恩恵を得る

例: コード探索 (T3) → 設計判断 (T1) → 実装 (T3 が雛形 → T1 が仕上げ)

#### E-3: Auto model selection per task (+5)

問題: ユーザが「すべて T1」 で設定すると コスト・遅延が嵩む。

実装:
- タスク受領時に user message を register classifier (既存 IntentClassifier) に通す
- explore → 安いモデル (T2 ローカル)、 production → T1
- 結果: 同じ user 入力で問題に応じてモデルを切替
- ユーザは「複雑なタスクは Claude、 ファイル探索は Qwen」 と書くだけで運用可能

#### E-4: Schema-strict tool I/O (+3)

問題: T3 は引数 JSON が壊れがち。 現状はパースエラーで握りつぶし。

実装:
- 各ツールの引数 JSON Schema をモデルへの function-calling spec として渡す (既存)
- 加えて、 ツール側で**実行前の strict validation**: schema 違反を「ツール呼び出し」 として model に返す (`success=false, error=schema mismatch: ...`)
- これにより T3 も「ツールは引数違いで呼ぶと怒られる」 を学習する

---

### Phase F: エコシステム拡張 (+18 点)

これらは Claude Code の現在価値の主な部分でもある。 lllmAgents が同等になるための機能群。

#### F-1: MCP (Model Context Protocol) 周辺強化 (+2)

> **訂正 (2026-05-07)**: 当初「MCP 統合を新設 +7 点」 と書いたが、 実装確認を怠った
> 認識誤り。 MCP は既に実装済 (`src/mcp/{mcp-manager,mcp-client,types}.ts` + `tests/mcp/`)、
> stdio + SSE 両対応、 `~/.localllm/mcp-servers.json` 設定、 ToolRegistry 自動登録、
> `mcp__<server>__<tool>` プレフィックス命名まで揃っている。 寄与点数も大幅下方修正。

実装済 (確認):
- `src/mcp/mcp-client.ts` (381 行) — JSON-RPC 2.0 over stdio + SSE
- `src/mcp/mcp-manager.ts` (189 行) — ライフサイクル管理 + ToolRegistry 統合
- 設定パス: `~/.localllm/mcp-servers.json` / `.localllm/mcp-servers.json` / `.claude/mcp-servers.json`

残せる差分 (= 周辺強化):
- 接続失敗時のリトライ UX 改善 (現状: warning 1 行で諦め)
- `/mcp status` / `/mcp reload` slash command
- セッション分析レポート (E-1) で MCP ツール由来の失敗を分離して可視化
- (将来) 公開 MCP server カタログから 1 コマンドで追加

#### F-2: Streaming UX / IDE 統合 (+5)

VSCode 拡張機能 / Cursor 統合 / Web UI のいずれかを実装。 最低限の MVP として VSCode コマンド経由起動 + diff プレビュー。

#### F-3: Built-in テストランナと安全な破壊操作 (+3)

`run_tests` ツール (jest/vitest/pytest 自動検出)、 destructive 操作前の自動 stash 機構。

#### F-4: テレメトリ自動可視化 (+3)

`/status` コマンドで現在セッションの反復・ トークン・bash 累積時間・stuck-loop 検出回数を表示。 過去セッションの傾向グラフも (E-1 のレポートと統合)。

> 2026-05-28 更新: 当初は `/metrics` コマンドとして単独実装された。 Phase optimize #4 で `/status` ダッシュボードに集約された (`/metrics` `/cost` `/capability` は alias を作らず完全削除)。

---

## 6. 点数寄与の見積もり詳細

| 項目 | T1 への寄与 | T3 への寄与 | 全体寄与 |
|---|---:|---:|---:|
| Phase A: 能力ティア基盤 | +1 | +2 | +5 (両方が動く前提を作る) |
| Phase B: ティア別 prompt/desc | +3 | +4 | +8 |
| Phase C: ティア別ループ制御 | +2 | +3 | +6 |
| Phase D-1: tool format 正規化 | +0 | +4 | +4 |
| Phase D-2: decision-tree mode | -1 (誤発動防止に注意) | +6 | +6 |
| Phase D-3: few-shot 自動注入 | +0 | +4 | +4 |
| Phase D-4: 短 ctx 最適化 | +0 | +5 | +4 (T3 救済の効果大) |
| Phase E-1: 自己改善ハーネス | +2 | +3 | +6 |
| Phase E-2: federated reasoning | +4 | +4 | +8 (新しい価値領域) |
| Phase E-3: auto model selection | +3 | +2 | +5 |
| Phase E-4: schema-strict I/O | +0 | +3 | +3 |
| Phase F-1: MCP 周辺強化 (既存実装の確認後、 寄与下方修正) | +1 | +1 | +2 |
| Phase F-2: IDE 統合 | +3 | +3 | +5 |
| Phase F-3: テストランナ + 安全 destructive | +1 | +1 | +3 |
| Phase F-4: テレメトリ可視化 | +1 | +2 | +3 |
| **合計** | | | **+72 → 35 + 72 = 107** (※ F-1 訂正で当初予測 -5) |

100 点超え (107) の根拠:
- Claude Code が前提とする「ユーザは Claude を使う」 を超えて、 「ユーザは適材適所のモデル群を使う」 という新しい設計領域を切り拓く (E-2, E-3)
- ローカル LLM の実用化 (Phase D 群) は Claude Code に存在しない価値領域
- 賢い LLM の足枷にならない原則 (Phase B-C) で、 同時に T1 ユーザの体験も Claude Code と同等以上に磨ける

---

## 7. リスクと「やらないこと」 リスト

### 7.1 主要リスク

1. **ティア判定誤り**: Fine-tune モデルやカスタムモデルで T3 のはずが T1 と判定 → 賢い指示なのに守れず壊れる
   - 緩和: ユーザ override + 起動時通知で誤認を可視化
2. **ティア機能の依存爆発**: 既存 helper が `capability` 引数を全て要求するようになり改修が肥大
   - 緩和: AgentLoop 内に limited な `this.capability` 経由で参照、 関数シグネチャ変更を最小化
3. **Decision-tree mode の T3 萎縮**: 自由意志を奪い過ぎて単純作業しかできなくなる
   - 緩和: 発動条件を「stuck-loop 検出後」 に限定、 通常時は自由形式
4. **Federated reasoning の責任分担曖昧化**: 失敗時にどちらの LLM のせいか分かりにくい
   - 緩和: ログに `delegated_by` / `executed_by` を必須記録
5. **Phase F-1 (MCP) のセキュリティ**: 任意の MCP サーバを許す = 任意のコード実行に近い
   - 緩和: 既存の権限 UI と統合、 デフォルト deny

### 7.2 やらないこと (out of scope)

- Claude Code と機能 1:1 完全同等化 (= 模倣だけしてもエコシステム差で勝てない)
- Web UI / クラウド SaaS 化 (= ローカル/CLI 中心という強みを薄める)
- 過剰な動的型付け (TypeScript の static 型を弱めない範囲で)
- 自社製 LLM の開発 (= プロバイダ中立性を保つ)
- E-2 federated を「自動で全部やる」 にする (= 暴走リスク)。 supervisor は明示的に呼ぶ

---

## 8. 既存 P0-P3 との関係 (回顧的整理)

P0-P3 は本ロードマップに統合される。 各機能の Phase 配属:

| P0-P3 機能 | 本ロードマップでの位置 | 改修必要性 |
|---|---|---|
| MAX_TOOL_ITERATIONS=100 (前提コミット) | Phase C で tier 別に分解 | hard-code → capability 参照 |
| sliding-window 失敗検知 (P0-A) | Phase A 後の tier-aware 化 | T3 は助言文を短縮 |
| file_edit ±20 行スニペット (P0-B) | tier 非依存 | 改修不要 |
| edit 直後 file_read 禁止ルール (P0-B) | Phase B (T3 では tool 側 hard reject) | T3 で tool 側拒否を実装 |
| bash 累積警告 (P1-A) | **2026-05-09 全 tier OFF に降格** | 全 tier `bashCumulativeWarnEnabled=false`。 単発長 bash で誤発火し T1 が response_complete を即時呼ぶ副作用を観測。 必要なら user override で個別 ON |
| plan/todo 過多検知 (P1-B) | T3 は plan-mode 自体を制限 | tier 分岐 + tool 側 reject |
| browser_snapshot キャッシュ (P2-A) | tier 非依存 | 改修不要 |
| 圧縮閾値 0.7 (P2-B) | Phase C で tier 別 | capability 参照 |
| 大 tool_result 要約 (P2-B) | Phase C で tier 別閾値 | capability 参照 |
| レジスター別ソフトキャップ (P3-A) | Phase B + C に統合 | capability 由来の値で上書き |
| 破壊的 bash の git status (P3-B) | tier 非依存 (T3 は手順例追加) | 改修最小 |

P0-P3 は正しい方向への第一歩だったが、 **すべて T1/T2 を暗黙の対象としていた**。 Phase A の能力ティア基盤を入れることで、 これらが T3 でも適切に動く (= 邪魔しない、 必要なところだけ強化する) ようになる。

---

## 9. 観測と継続評価 — 100 点を保つ仕組み

実装後も 100 点を維持するための定量化:

### 9.1 KPI

| 指標 | 目標 | 計測方法 |
|---|---|---|
| user span あたり中央値反復数 | T1: 12 / T2: 18 / T3: 25 | jsonl ログ集計 (E-1) |
| stuck-loop 検出率 | < 2% | P0-A の発動回数 / total spans |
| 同一引数 file_edit 失敗の 2 回目発生率 | < 0.5% | P0-A 検出ログ |
| ctx あふれ 400 エラー / 1000 セッション | T3 < 1 件 | provider error ログ |
| ローカル LLM での完走率 | T3 で 60% 以上 | ユーザ「タスク完了」 報告 |

### 9.2 自動レポート (Phase E-1 で実装)

`~/.localllm/reports/weekly-<date>.md` に毎週生成:
- KPI トレンド (前週比)
- 上位 stuck-loop パターン
- ティア別の使用比率
- 改善提案 (description 改修候補、 few-shot 追加候補)

レポートを human review → 必要なら PR 化 → main に取り込み。

### 9.3 ベンチマークスイート

`tests/benchmark/` 配下に「典型タスク 20 種」 を定義:
- 各 tier × 各タスクで反復数 / トークン / 完走率を測定
- リグレッションを CI で検出

---

## 10. 実装順序の推奨

**MVP (Phase A + 最小 B)**: 4 週間
- Phase A 完成 + tier 概念の導入
- system prompt の T1/T3 分岐だけ
- これで `lllmAgents は tier 概念を持つ` という核心が立つ

**Beta (Phase B + C + D-1)**: 追加 4 週間
- tool description 切替、 ループ制御、 tool format 正規化
- ローカル LLM の実用化が開始

**v1.0 (Phase D-2..D-4 + E)**: 追加 8 週間
- decision-tree mode、 few-shot、 短 ctx 最適化、 自己改善、 federated
- 100 点に到達

**v1.1 (Phase F)**: 追加 4 週間
- MCP, IDE, テストランナ、 テレメトリ
- 100 点超えを安定化

合計 5 ヶ月の追加開発で 35 → 107 点の見込み (F-1 訂正で当初 112 点予測から下方)。

---

## 11. 結語

lllmAgents は「ローカル LLM 一級市民・日本語 UX・設計書文化」 という三本柱を既に持っている。 これは Claude Code が容易に追随できない領域である。

100 点超えのカギは「賢い LLM と弱い LLM の両方を、 同じハーネスで第一級にサポートする」 こと。 そのために必要な唯一の上位原則が **capability-aware harness** であり、 これを Phase A で導入し Phase B-F で展開する。

P0-P3 は改善の最初のラウンド (35 → 41) として正しい方向だった。 しかし暗黙に T1/T2 だけを対象としていた。 本ロードマップを実行することで、 P0-P3 を含む全機能が**全ティアで適切に振る舞う**ようになり、 さらに「Claude Code に存在しない価値領域 (E-2 federated, D 群)」 を切り開くことで 100 点を超える価値を持つエージェントになる。

設計と実装は段階的に。 各 Phase の完了時に benchmark を取り、 想定通りの効果が出ているか測定して次へ進む。 「動かない 100 点」 より「動く 50 点」 を積み上げる方が遠回りに見えて確実に到達できる。
