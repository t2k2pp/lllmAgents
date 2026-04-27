# Phase 5 進捗トラッカー

> **位置づけ**: `docs/harness-engineering-phase5.md` (設計書) の対になる **進捗トラッカー**。
> 「何を試した / 試していない / リトライ結果」を明示し、ループ運用に耐えるようにする。
> 設計書 = 不変、本書 = 各イテレーションごとに更新。

---

## ステータス凡例

- ✅ 実装完了 (リトライ確認待ち)
- 🔁 リトライ中 / 効果検証中
- ⚠ 実装したが効果不十分 / 副作用あり
- ⏸ 未着手 (Phase 内で対応予定だが今ラウンドはスキップ)
- ❌ 不要と判断 (理由を残す)

---

## 第 1 ラウンド (2026-04-27)

実装範囲: 設計書の課題 A〜H に対し、段階的対応の **5-A / 5-B / 5-C / 5-D / 5-G / 5-H の最初の Phase** を一括実装。
方針: 「賢いモデルでも引っかかる箇所をすべてハーネスで吸収する」。

### 実装したもの

| 課題 | Phase | 内容 | 変更ファイル | ステータス |
|---|---|---|---|---|
| A | 5-A1 | file-read エラーで同 stem 別拡張子・親dir軽量ls・部分一致候補をサジェスト | `src/tools/definitions/file-read.ts` | ✅ |
| A | 5-A1 | file-read 成功時に「現在の表示行 / 全体行数 / 続きの offset 値」を末尾に併記 | 同上 | ✅ |
| E | 5-E1 | glob hit 0 時に起点ディレクトリの中身 + 拡張子集合検査 + 次の手のヒント併記 | `src/tools/definitions/glob.ts` | ✅ |
| E | 5-E1 | glob description に pattern 例を 4 種追加 + よくある誤用を記載 | 同上 | ✅ |
| G | 5-G1 | 主要ツール 8 種 (file_read/file_write/file_edit/bash/glob/grep/second_llm_consult/second_llm_agent) の description を **4 要素テンプレ** (機能/使う場面/使うべきでない場面/よくある誤用) に再構成 | `src/tools/definitions/*.ts` | ✅ |
| C | 5-C1 | file_write 成功時に bytes/lines/mtime/作成 or 上書き状態を併記 | `src/tools/definitions/file-write.ts` | ✅ |
| C | 5-C1 | file_edit 成功時に bytes/lines/mtime を併記 | `src/tools/definitions/file-edit.ts` | ✅ |
| C | 5-C2 | bash 成功/失敗時に exitCode/durationMs/stdoutBytes/stderrBytes を併記 | `src/tools/definitions/bash.ts` | ✅ |
| B | 5-B1 | system-prompt に「委任の3条件」「連続委任禁忌」「軽作業は委任しない」を明文化 | `src/agent/system-prompt.ts` | ✅ |
| D | 5-D1 | system-prompt の plan_mode 発動条件を「影響3ファイル以上 / 多層 / 大規模リファクタ / 明示依頼」に閾値化 | 同上 | ✅ |
| D | (新) | system-prompt に「失敗時のエスカレーション ladder」(3回連続失敗で別アプローチ強制 + ask_user) | 同上 | ✅ |
| D介入 | 5-D2 | agent-loop に **壁ドンループ検出**: 同 (toolName, 主要引数) で連続失敗 ≥2 で警告挿入 | `src/agent/agent-loop.ts` | ✅ |
| B | 5-B2 | agent-loop に **連続委任ガード**: second_llm_agent / task が直近5分で 3 回以上で警告挿入 | 同上 | ✅ |
| H | 5-H1 | **Read→Edit 契約**: file_edit 時にセッション内 file_read 履歴 (recentReads, LRU 32 件) を検査、無ければ警告 | 同上 | ✅ |

### あえてやっていないこと (理由付き)

| 課題 | やらなかったこと | 理由 |
|---|---|---|
| H | file_edit が Read してないパスへの実行を **拒否** (ハードガード) | 既存ワークフロー (新規ファイル直書きや bash sed の代替等) を壊す可能性。 まず警告のみで様子見、 効果不足なら 5-H2 でハード化 |
| F (沈黙ターン) | progressTracker (バイト変化ゼロのターン検出) | 設計書では Phase 5-F1 として残す。 まずエラー側 (5-A/D) で改善余地が大きいため、 沈黙ターン対策は 1 ラウンド後で |
| F (評価系) | scripts/eval-jsonl.js (リグレッション防止) | 1 ラウンド分の効果が出てから。 ベースラインを取るのもリトライ後の方が比較しやすい |
| C | 全ツール (web_fetch / browser_screenshot 等) の構造化レスポンス | 第1ラウンドはコード編集サイクルに直接効くものに集中。 拡張は次ラウンド |
| 委任 (5-B3) | second_llm_agent 引数に「3条件のどれを満たすか」を要求するハードガード | description で原則を伝える方を先行。 効かなければハード化 |

### Claude Code 原則 (P1〜P9) との対応

| 原則 | 第1ラウンドでの対応 |
|---|---|
| P1 自助情報 | file-read / glob / file-edit (既存) のエラー強化済 ✅ |
| P2 読まずに書かない | Read→Edit 契約 (警告のみ) ✅ |
| P3 同じ間違いを2度させない | 壁ドンループ検出 (汎化版) ✅ |
| P4 観察可能性 | file_write/edit/bash/file_read の副次情報同梱 ✅ |
| P5 委任の閾値設計 | system-prompt + 連続委任ガード ✅ |
| P6 エスカレーション ladder | system-prompt に明文化 ✅ |
| P7 計画は重い案件のみ | system-prompt の plan_mode 閾値 ✅ |
| P8 ツール利用目的の明示 | 主要 8 ツール description 再構成 ✅ |
| P9 ハーネス→モデルの気づき | 警告メッセージとして tool_result に挿入 ✅ |

**第1ラウンドで P1〜P9 すべてに最初の打ち手を入れた状態。 「効くかどうか」 はリトライで確認する。**

### 副作用・リスク

- file-read エラーが長くなった (親dir ls + 候補 4-5 行) — コンテキスト圧迫の可能性。 上限 8 件で抑えているが、 多発するなら短縮検討
- 壁ドンループ警告が誤報するケース: 「2 回失敗したが 3 回目で成功する」 ような正当な反復作業もある。 警告挿入のみで処理は止めないので致命的ではないが、 出過ぎなら閾値を 3 に上げる
- Read→Edit 契約で「直前のターンで Read 済み」のケースをカバーするが、 LRU 32 件を超えた古い Read は失効。 大規模セッションで誤警告の可能性あり (実用上は問題ない見込み)
- bash の副次情報 `[bash] exitCode=...` がコマンド出力末尾に常に付与される → 後続パース処理 (もし誰かが `tail -1` 等で抜き取る使い方をしているなら) 影響あり。 lllmAgents 内の用途では問題なし

### リトライ前にユーザーが確認できる動作変化

```bash
# 例1: 存在しないファイル
file_read foo.txt
# → 旧: "File not found: foo.txt"
# → 新: "File not found: foo.txt
#       [同名・別拡張子の候補あり] /path/foo.html
#       [次の手] 上記いずれかのパスで file_read を再試行。"

# 例2: glob hit 0
glob "*.txt" path=src/
# → 旧: "No matching files found."
# → 新: "No matching files for pattern: *.txt (cwd: src/)
#       [起点 src/ の浅い中身]
#         dirs: agent/  cli/  tools/
#         files: index.ts  ...
#       [警告] pattern が要求する拡張子 .txt は起点配下に存在しないかも。 実在拡張子例: ts, json, md
#       [次の手] (1) pattern の拡張子・前方一致を見直す ..."

# 例3: 同パスへの file_read 連続失敗
file_read foo.txt   # 1回目失敗
file_read foo.txt   # 2回目失敗 → ハーネスから "[壁ドンループ警告]" 挿入

# 例4: file_read してない file_edit
file_edit foo.ts ...   # → "[Read→Edit契約]" 警告挿入

# 例5: 連続委任
second_llm_agent ...   # 直近5分で3回目 → "[連続委任警告]" 挿入
```

### リトライで確認したい指標

設計書 Section 5 で定義した指標のうち、 第1ラウンドで効くと予測される範囲:

| 指標 | 期待される変化 |
|---|---|
| 同一パス連続失敗率 (file_read エラー反復) | 25% → 10% 以下 (5-A1 + 壁ドンループ検出) |
| 委任連続回数の中央値 | 4 → 2-3 (5-B1 + 連続委任ガード) |
| plan_mode 起動率 | 80% → 50% (system-prompt の閾値化) |
| ターンあたりの平均ツール呼び出し数 | 1.5 → 1.3 |
| silent failure 検出率 (検証ステップ数) | 増加 (副次情報による検証可能化) |

リトライ後、 `~/.localllm/logs/sessions/*.jsonl` から手作業で集計してこの欄を埋める。

---

## 第 2 ラウンド (2026-04-27) — メイン/セカンド非対称性の解消

実装範囲: 第 1 ラウンドの介入レイヤが **メインLLMにしか効いていなかった** 問題を全面解消。
セッションログ分析 (4/27 の Kimi-K2.6 走行) で判明した根本欠陥への対応。

### 第 1 ラウンドで明らかになった本質的欠陥

リトライログ (`~/.localllm/logs/sessions/2026-04-27T*.jsonl`) と Explore agent の分析により、
**メインLLMとセカンドLLM (second_llm_agent / consult / runAsEvaluator) が「別世界」** であることが判明:

| 項目 | メインLLM | セカンドLLM (第1ラウンド時点) |
|------|-----------|---------------------------------|
| System Prompt | Phase 5 戦略 (委任3条件 / エスカレーション / plan_mode 閾値) 満載 | 1 行のみ "You are an expert AI sub-agent..." |
| tool_result 拡張 | 壁ドン警告 / Read→Edit 警告 / 連続委任警告 / 旧エラーガイダンス | **何もなし** (output/error 素のまま) |
| 連続委任ガード | agent-loop で追跡・警告 | なし |
| Read→Edit 契約 | recentReads (LRU 32 件) で検査 | なし |
| 壁ドンループ検出 | wallHitFailCounts で検出 | なし |

→ 「賢いモデル (Kimi) を使うとはっきり問題が浮き彫りになる」 のは、 セカンド側にハーネスが
皆無で、 ツール試行錯誤に陥り 15 イテレーション上限に到達しやすい構造のため。

### 第 2 ラウンドで実装したもの

| Phase | 内容 | 変更ファイル | ステータス |
|---|---|---|---|
| (基盤) | 共通モジュール `src/agent/harness-intervention.ts` 新規作成。 `HarnessState` クラス (recentReads / wallHitFailCounts / fileEditFailCounts / recentDelegations) と `enrichToolResult()` / `wallHitKey()` / `buildSubAgentStrategyPrompt()` を集約 | `src/agent/harness-intervention.ts` (新規) | ✅ |
| (リファクタ) | agent-loop.ts のインライン介入を共通モジュール委譲に書き換え。 旧版 `enrichToolResult` (エラーガイダンス) も新版にマージ。 並列実行ルートにも適用 (これまで抜けていた) | `src/agent/agent-loop.ts` | ✅ |
| (新) | セカンドLLM の `runAsAgent()` の system prompt を **Phase 5 戦略を含む** 形に再構成 (メインと同じ原則を継承)。 ツール使用 / 失敗エスカレーション / ハーネス警告への対応 / 完成までの完結 を明文化 | `src/second-llm/second-llm-manager.ts` | ✅ |
| (新) | セカンドLLM の `runAsAgent()` のツール実行ループに `enrichToolResult()` を適用。 セカンド独自の `HarnessState` を持ち、 セカンド内での壁ドンループ・盲目編集・連続委任を検出 | 同上 | ✅ |
| (新) | `runAsEvaluator()` にも同様の介入レイヤを適用。 評価フェーズも壁ドン検出が効く | 同上 | ✅ |
| (新) | `consult()` の system prompt をコンパクト戦略版に変更 (ツール無し単発質問用) | 同上 | ✅ |

### 結果として実現する対称性

| 項目 | メインLLM | セカンドLLM (第2ラウンド後) |
|------|-----------|---------------------------|
| System Prompt | Phase 5 戦略満載 | `buildSubAgentStrategyPrompt()` で **同等の原則を継承** ✅ |
| tool_result 拡張 | enrichToolResult 適用 | **同じ enrichToolResult 適用** ✅ |
| 連続委任ガード | あり | あり (セカンド内で task 呼び出しがあれば検出) ✅ |
| Read→Edit 契約 | recentReads 検査 | セカンド独自 recentReads で検査 ✅ |
| 壁ドンループ検出 | wallHitFailCounts | セカンド独自 wallHitFailCounts ✅ |

### あえてやっていないこと (第2ラウンドでも)

| 項目 | やらなかった理由 |
|---|---|
| HarnessState のメイン↔セカンド共有 (recentReads 等) | セッション境界をまたぐと意図しない警告 (例: メインで Read 済みのファイルをセカンドで Edit する場合) が増えるリスク。 まず独立 state で動かして、 必要なら次ラウンドで共有 |
| セカンド側で second_llm_agent / task の禁止強化 | EXCLUDED_TOOLS で task は許可中 (再入リスクあり)。 緊急性低いので次ラウンドへ |
| 進捗ゼロターン検出 (5-F1) | 第1ラウンドと同様、 まずエラーレイヤの効果を見る |

### Claude Code 原則 (P1〜P9) との対応 — 第2ラウンドで強化された点

| 原則 | 第1ラウンド | 第2ラウンド追加 |
|---|---|---|
| P1 自助情報 | メイン側のみ | **セカンド側 tool_result にも適用** ✅ |
| P2 読まずに書かない | メイン側のみ警告 | **セカンド側でも警告** ✅ |
| P3 同じ間違いを2度させない | メイン側のみ壁ドン検出 | **セカンド側でも壁ドン検出** ✅ |
| P5 委任の閾値設計 | メインのプロンプトのみ | **セカンドにも継承** ✅ |
| P6 エスカレーション ladder | メインのプロンプトのみ | **セカンドにも継承** ✅ |
| P9 ハーネス→モデルの気づき | メインのみ | **セカンドにも届く** ✅ |

### 副作用・リスク

- セカンドの system prompt が長くなった (1 行 → 約 30 行)。 1500-2500 トークン分のコンテキスト消費増。 ただし戦略原則は必須なので妥当
- セカンド側の `HarnessState` はインスタンス内で完結 (セッションをまたがない)。 同一タスクで複数回 second_llm_agent が呼ばれるなら別インスタンスが立ち上がる → state がリセットされる。 メインからの連続委任警告がカバーする領域なので問題なし
- `buildSubAgentStrategyPrompt()` は静的文字列。 メインの `buildSystemPrompt()` の戦略節とずれる可能性あり (将来的にメイン側を変えた時)。 単体テスト追加は次ラウンドで検討

### 動作変化のサンプル (第2ラウンド)

```
# 例1: セカンドが file_read を 2 回連続失敗
[第1ラウンド時点]
  → セカンドは "File not found" の素エラーを 2 回見て、 さらに 3 回目を試行

[第2ラウンド以降]
  → セカンドの tool_result に
     "File not found: foo.txt
     [同名・別拡張子の候補あり] /path/foo.html
     [次の手] 上記いずれかのパスで file_read を再試行。"
     と Phase 5-A1 の自助情報が届き、 さらに 2 回目失敗時に
     "[システム][壁ドンループ警告] 同じツール×同じ引数で 2 回連続失敗..."
     も挿入される

# 例2: セカンドが Read してない file を Edit
[第1ラウンド時点]
  → 何の警告も出ず、 old_string 不一致で失敗するまでわからない

[第2ラウンド以降]
  → "[システム][Read→Edit契約] このセッションで file_read していないパスに file_edit..."
     が tool_result に挿入

# 例3: メインが連続委任
[第1ラウンド時点]
  → 警告は出るが、 セカンドはそれを見ない (メインの tool_result にしか届かない)

[第2ラウンド以降]
  → セカンド側でも自分が複数回連続して呼ばれていることを検出 (ただし state は独立なので、
     同一 second_llm_agent インスタンス内で task を 3 回呼んだ場合に作動)
```

### 第 2 ラウンド: リトライ結果ログ (随時追記)

#### リトライ #1
- 日時: (未実施)
- セッションログ:
- 観察:
- 残課題:
- 副作用:

---

## 第 3 ラウンド以降の予定 (未着手)

第 2 ラウンドのリトライ結果を見てから決める。 候補:

- **5-A2**: 全ツールに `selfHelpHints()` 共通インターフェース化
- **5-A3**: ハーネス側のエラー分類器 + 連続失敗時の自動 `find` 実行
- **5-B3**: second_llm_agent 引数に「委任理由 (3条件)」を要求するハードガード
- **5-C3**: web_fetch / browser_screenshot 等への副次情報追加
- **5-D3**: plan_mode 起動後の TaskWrite 強制
- **5-F1**: progressTracker (進捗ゼロターン検出)
- **5-F (評価系)**: `scripts/eval-jsonl.js` でログから自動集計
- **5-H2**: Read→Edit 契約のハードガード化 (新規ファイル例外を扱える設計で)

---

## ループ運用ルール

1. ユーザーが `npm run build:deploy` で再ビルド → 起動 → タスク実行
2. ユーザーがログ (`~/.localllm/logs/sessions/*.jsonl`) を観察し、 残課題 / 副作用を本書「リトライ結果」セクションに追記
3. 開発側 (Claude Code) が次ラウンドの実装方針を決める。 設計書 (`docs/harness-engineering-phase5.md`) の Phase 番号で参照
4. 実装後、 本書に新ラウンドのセクションを追加 (旧ラウンドは履歴として残す)
5. リグレッションが見つかったら本書の「副作用」 にメモし、 必要なら巻き戻し or 修正

**重要**: 「効果が薄い」 と判断する前に **少なくとも 2-3 セッション** 試す。 1 セッションで結論を出さない (ノイズが多すぎるため)。

---

## リトライ結果ログ (随時追記)

### 第 1 ラウンド: リトライ #1
- 日時: (未実施)
- セッションログ:
- 観察:
- 残課題:
- 副作用:

### 第 1 ラウンド: リトライ #2
- 日時:
- セッションログ:
- 観察:
- 残課題:
- 副作用:
