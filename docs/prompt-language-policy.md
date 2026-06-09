# プロンプト言語ポリシー（モデル向けは英語ベース）

作成: 2026-06-09 / ステータス: Phase 1 実装済み（system-prompt + shared-principles + rules header + browser reason）

## 決定

**モデルに渡る文字列は英語を正本とする。ユーザーとの対話（応答）と UI（REPL/help/エラー表示）は日本語のまま。**

過去のシステムプロンプトは日本語で書かれていたが、これを英語ベースへ移行する。日本語版は
出荷せず `docs/prompt-ja-reference.md` に参照スナップショットとして退避する（同期しない）。

### 根拠

1. **トークン削減は確定利益**。CJK は BPE で概ね 1 文字 ≈ 1 トークン、英語は約 4 文字/トークン。
   同じ意味を英語で書くと概ね 3〜4 倍密。ローカル LLM は文脈窓が 32k 級のことも多く、削減の
   相対インパクトが大きい。`shared-principles` はサブエージェント起動のたびに再課金されるため
   特に効く。
2. **モデル整合の可能性**。ターゲットの Qwen3.5-27B-**Claude-Distilled** は蒸留元が英語推論
   ヘビーで、英語指示の方が素直に効く可能性が高い。最近の Claude 系も内部推論を英語で行い
   ユーザー言語で出力する構成に見える。
3. **品質改善は「たぶんプラス、要検証」**。「このモデルが英語指示を日本語指示より良く守る」は
   実測しないと断言できない。トークン削減は確定、品質効果は A/B 対象。ユーザーがモデルを
   握っているので検証可能。

## 境界（どれを英語化し、どれを日本語のまま残すか）

| 区分 | 言語 | 例 |
|---|---|---|
| モデルに届くスキャフォールド | **英語** | system-prompt の core identity / shared-principles / 環境 / 各種見出し / 委任説明 / rules ヘッダ / builtin rules |
| モデルに届く診断文字列（dual-use） | **英語** | browser-capability の reason（プロンプト注入 + CLI 表示） |
| ユーザーとの対話（私の応答） | 日本語 | エージェントのユーザー向け返答（プロンプト内で「日本語入力には日本語で返す」と指示） |
| UI 文字列 | 日本語 | REPL メッセージ / help / エラー表示 / スピナー |
| ユーザー由来の注入内容 | 原文のまま | project 指示（CLAUDE.md 等）/ メモ / user-global・project rules |

### 「日本語で応答」の担保
英語プロンプト内に各 tier で `Reply in Japanese to Japanese input.`（T1: `Japanese for Japanese
input.` / T3: `answer in Japanese to Japanese input.`）を明示。Claude 方式（英語システム
プロンプト + ユーザー言語出力）。

## 未解決（次フェーズ）: dual-use マーカーの分離

`[自己点検 N/M]` と `[ハーネス]` マーカーは **3 箇所で結合**している:
1. モデルへの注入文（self-check-messages.ts `formatSelfCheck` / agent-loop.ts の各 nudge）
2. ターミナル表示（agent-loop.ts の `chalk.dim`/`chalk.yellow` — **ユーザー可視**）
3. パーサのキー（progress-judge.ts:121 `content.startsWith("[ハーネス") || startsWith("[自己点検")`）

英語化すると「モデル向け（英語にしたい）」と「コンソール可視（日本語のまま）」が衝突する。
マーカー文字列を変える場合は **3 箇所すべてを同時に**直さないと事故る（特にパーサのキー）。

→ **Phase 1 では触らない**。system-prompt の T2 は現状の日本語マーカー `[自己点検 N/M]` を
リテラルで参照したまま残す（モデルが実際に注入される文字列を認識できるよう、整合を優先）。
分離設計（注入文=英語 / コンソール=日本語、パーサキーは安定 ID に）は Phase 3 で扱う。

## パーサ互換の確認

完了レベル検出 `detectRegisterFromText`（agent-loop.ts:1796-1799）は元々
`task is standard` / `register: production` 等の**英語表現も拾う**。レベル名
（explore/rough/standard/production）自体が英語。よって英語プロンプトで
`This task is **standard**` と宣言させても検出できる（英語化前から対応済み）。

## フェーズ

- **Phase 1（済 2026-06-09）**: system-prompt.ts（behavioral 全 tier + 環境 + 見出し + LLM
  プロフィール + obsidian）/ shared-principles.ts（全 builder 全 tier）/ rule-loader ヘッダ /
  browser-capability reason。検証: typecheck OK、vitest 678 passed（既存 Windows 系 4 失敗は無関係）、
  全 tier でスキャフォールド日本語残留 0。
- **Phase 2（予定）**: tool-guides.ts（GUIDE_TEXTS / few-shots / failure guides）/ 各ツール定義
  description（src/tools/definitions/*）/ harness-intervention.ts のサブ戦略。
- **Phase 3（予定）**: self-check / `[ハーネス]` 系メッセージ。dual-use マーカーの分離設計を伴う。

## 検証方法（残留チェック）

`buildSystemPrompt(..., { projectInstructions:"", memory:"" })` でユーザー注入を空にしてレンダリングし、
`# Rules` 以降（user-global ルール）と `自己点検` を除いて CJK 行を grep する。0 ならスキャフォールドは
英語化済み。
