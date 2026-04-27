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

### 第 2 ラウンド: リトライ結果ログ

#### リトライ #1: 3D レースゲーム生成 (2026-04-27)
- セッションログ:
  - メイン: `~/.localllm/logs/sessions/2026-04-27T13-35-24_main.jsonl` (1.7MB)
  - セカンド: `~/.localllm/logs/sessions/2026-04-27T13-57-13_second-llm-agent.jsonl` (30KB)
  - セカンド: `~/.localllm/logs/sessions/2026-04-27T13-39-12_second-llm-agent.jsonl` (33KB)
- 成果物: `sandbox/output/games/ka2games/gemini-code-1777256314799.html` (270行)
- 仕様書: `sandbox/output/games/ka2games/gemini-code-1777256314799.txt`
- ユーザー観察: 「挙動が少し滑らかになった気もする。 ただ、 結局レースゲームを作れず地面は道路ではない色に塗りつぶされていた」

##### 効果として観察できたもの
- メインとセカンドの介入レイヤ非対称性は **形式上解消** (HarnessState/enrichToolResult/buildSubAgentStrategyPrompt がセカンドにも適用)
- セカンドの system prompt が 1 行 → Phase 5 戦略を含む形に拡張、 ハーネス警告への対応指示も明文化
- メイン側の壁ドンループ検出/連続委任ガードがログ上で機能している痕跡

##### 残った根本欠陥 (重大度順)
1. **【致命的】仕様違反の検出機構なし** — 仕様書「Z軸マイナス方向の直線道路」 を、 セカンドが path 配列で曲線実装 (x が ±8〜±12 で振れる)。 自車は A/D で自由移動できるため、 すぐ道路から外れて緑の地面が見える。 **ハーネスは「失敗パターン」 は検出できるが「仕様解釈違い」 は検出できない**
2. **【高】完了検証ステップの不在** — セカンドは 1 ターンで HTML 生成 → 終了。 file_read/grep/bash による自己検証なし。 メイン側も「ファイル存在確認」 のみで内容検証していない
3. **【高】delegate プロンプトの「Output ONLY HTML」 制約** — セカンドが「Output ONLY ```html...```」 と強制されると、 ハーネス警告を受けても応答できず無視される構造。 出力形式の縛りが介入レイヤを無効化している
4. **【中】セカンドが仕様書ファイルを自発的に読まない** — `buildSubAgentStrategyPrompt()` に「仕様書を file_read してから実装」 が無く、 delegate メッセージに頼り切る → delegate メッセージ内の矛盾 (path カーブ vs 直線指定) が仕様書の指定より優先される
5. **【中】仕様キーワードの自動検査なし** — メインが post-delegation で「直線」 「灰色」 等の仕様キーワードを成果物から確認するルーチンが存在しない

##### Phase 5 が解けない領域 (仕組みの限界)
- ハーネス介入は **観察可能なツール失敗** に対しては強い (壁ドン/盲目編集/連続委任)
- 一方、 **生成内容の意味的妥当性** (仕様違反の有無) はツール失敗として現れないため検出できない
- これは Phase 5-D 介入インテリジェンスの範囲外。 別系統の "仕様遵守チェック" (post-delegation validation) が必要

##### 副作用
- 第2ラウンド以降で目立った副作用なし。 セカンドの system prompt 拡張によるトークン消費増は許容範囲

---

## 第 3 ラウンドの設計案 (リトライ #1 結果を受けて)

> **主軸の修正**: 当初は「仕様への忠実度」 を主軸に置いたが、 ユーザー指摘で見直し。
> 真の論点は「**ユーザー依頼に対してどこまでやれば終わりかの暗黙合意**」 にある。
> Claude Code が絶妙にコントロールしているのはこの「対話レジスター」 で、
> 大半はハーネスエンジニアリング (システムプロンプト) の仕事。

### 重要な認識の更新

リトライ #1 で「直線→曲線」 を仕様違反として分析したが、 **カーブ要素はユーザー追加指示** であり、 命令違反ではなかった。 真の問題は:

> **「ラフに動けばいい」 のか「ちゃんとした成果物にしたい」 のかの粒度合意ができていない**
> → 結果として 270 行で「ファイル存在 = 完了」 と判定し、 動作検証に至らなかった

### Claude Code の "対話レジスター" を内省

Claude Code のシステムプロンプトには明示的に以下のガイドがある:

| レジスター | 発動条件 | ハーネスの振る舞い |
|---|---|---|
| **explore** | "what could we do about X?" "how should we approach this?" 等の探索質問 | 2-3 文で返答、 実装しない、 redirect 余地を残す |
| **rough** | "ラフに" "とりあえず" "MVP" 等のキーワード | 最小実装 + 構文 OK で完了、 検証最小 |
| **standard** | 通常の実装依頼 | 計画 → 実装 → 検証 → 報告 |
| **production** | "ちゃんと" "品質重視" "テストまで" "本番" 等 | エッジケース、 多面的テスト、 ドキュメント |

加えて Claude Code 特有の振る舞い:
- **GUI/UI 案件は "見て確認" まで完了報告を出さない** (システムプロンプトに明示: 「For UI or frontend changes, start the dev server and use the feature in a browser before reporting the task as complete」)
- **暗黙の Acceptance Checklist を頭の中で立て、 self-review してから完了報告**
- **完了報告の質を依頼の質に合わせる** (ラフな依頼に長文 summary を返さない)

これらは **モデル賢さ依存ではなく、 ハーネスのガイドレール**。 言語化してプロンプトに刻むだけで再現できる。

---

### 課題 N: タスクの粒度合意 (対話レジスター) — Phase 5 第3ラウンドの主軸

#### 観察 (評価者)
- リトライ #1 でメインがセカンドに「Output ONLY HTML」 と委任 → セカンドは 1 ターン生成 → メイン側で動作確認なし → 完了
- 仕様書は 57 行の詳細指定があり、 通常なら **standard〜production レジスター** の対応が要る
- だがユーザーが明示せず、 ハーネスにもデフォルトの判断基準がないため「**雑に "rough" と判断される**」 構造になっている

#### あるべき姿 (設計者)
- システムプロンプトに 4 段階の "対話レジスター" を明示
- ユーザー依頼の冒頭で **LLM が自分でレジスターを宣言** してから着手 (1 行、 ユーザーは過剰なら redirect 可)
- レジスターごとの "完了基準" を併記
- 不明な時は ask_user で粒度確認

#### 実装弱点 (製造者)
- `src/agent/system-prompt.ts` に対話レジスターの概念が無い
- 既存の plan_mode (5-D) は「計画を立てるか否か」 の二値で粒度の細分化なし
- 完了基準のチェックリストは todo_write で代用できるが、 **そもそも作成されない**

#### 対応 (段階的)
- **5-N1 (短期)**: system-prompt に「対話レジスター」 セクションを追加 (4 段階、 各キーワード例示、 完了基準明示)
- **5-N2 (短期)**: 「依頼を受けたら最初にレジスターを宣言する」 を必須行動として system-prompt に明文化
- **5-N3 (中期)**: 委任時の delegate メッセージに「このタスクのレジスター」 を含める。 セカンド側もそれに従って完了基準を変える
- **5-N4 (長期)**: ハーネス側で「LLM が宣言したレジスター」 を tool_result メタ情報として保持し、 完了報告時に self-review を促す

### 課題 O: 完了の Acceptance Checklist 制度化

#### 観察
- セカンドが 270 行 HTML を生成して終了 → メイン側「ファイル存在 = 完了」 → ユーザーは「動かない」 と気付く
- 「終わった」 の定義が事後的、 LLM の独断

#### あるべき姿
- standard 以上のレジスターでは、 タスク開始時に LLM が **Acceptance Checklist を 3-5 項目で立てる**
- 例 (3D ゲーム生成):
  - [ ] HTML が file_write された
  - [ ] ブラウザで開いて main loop が動く
  - [ ] 仕様の状態機械 (READY/PLAYING/PENALTY/GOAL) が含まれる
  - [ ] 操作 (W/S/A/D/Shift/Ctrl) のキーバインドが定義されている
- 完了報告時に **全項目に ✓ が付くまで「未完了」 とする**

#### 対応
- **5-O1 (短期)**: system-prompt に「standard 以上のレジスターでは Acceptance Checklist を todo_write で立てる」 を明文化
- **5-O2 (中期)**: response_complete ツールに「checklist で全項目 ✓ か」 を確認するゲート
- **5-O3 (長期)**: ハーネスが Acceptance Checklist と完了報告を照合し、 不一致時は警告挿入

### 課題 P: GUI/UI 案件の動作検証ルール

#### 観察
- 第 1 ラウンドの system-prompt 改訂で「コード変更後は bash で構文確認」 は明文化したが、 **GUI/HTML/Three.js は構文チェックだけでは不十分**
- file_read で生成内容を見ることすらしないケースがある

#### あるべき姿
- Claude Code 同様、 「GUI/UI 案件は dev サーバ起動 + ブラウザ操作 まで完了報告を出さない」 を原則化
- 自動でできない場合 (browser_screenshot 不可等) は **明示的に「動作確認できない」 と申告**

#### 対応
- **5-P1 (短期)**: system-prompt に「GUI/UI/HTML 生成タスクは file_read + browser_screenshot で見る、 不可なら未完了として申告」 を明文化
- **5-P2 (中期)**: file_write で .html 生成時、 ハーネスが自動で「次に何で確認すべきか」 のサジェストを tool_result に挿入

---

### 第3ラウンドの実装優先順 (案)

| 優先 | 項目 | 実装規模 | 期待効果 |
|---|---|---|---|
| 1 | 5-N1, 5-N2: 対話レジスター明文化 + 開始時宣言 | 小 (system-prompt 30-50 行追加) | レジスターずれによる「ラフ判定」 を防ぐ |
| 2 | 5-O1: Acceptance Checklist の制度化 | 小 (system-prompt + todo_write 既存) | 完了基準の事前合意 |
| 3 | 5-P1: GUI 案件の動作検証ルール | 小 (system-prompt 5-10 行) | UI silent failure の防止 |
| 4 | 5-N3: 委任時のレジスター継承 | 中 | セカンドも同じ粒度で動く |
| 5 | 5-O2: response_complete ゲート化 | 中 | 完了報告の真偽チェック |

### Claude Code 原則の追加: P10「対話レジスターの明示合意」

設計書 (`harness-engineering-phase5.md` Section 2) に追加すべき新原則:

> **P10 対話レジスターの明示合意**
> ユーザー依頼の "粒度" (explore/rough/standard/production) を LLM が冒頭で宣言し、
> ハーネスがその粒度に応じた完了基準を保持する。 完了報告は宣言したレジスターと
> 整合する形でなければならない (rough なら短報告、 production なら詳細報告)。
> これがないと、 同じ依頼を「ファイル存在で完了」 と判定する場合と「動作確認まで」
> やる場合がランダムに混在する。

### 旧課題 I-M との関係 (整理)

旧課題 I-M ( Post-Delegation Validation 系) は **依然として有効** だが、 主軸は N-O-P に変更:
- N (粒度合意) があれば、 production レジスターでは O (Checklist) に「仕様キーワード遵守」 が含まれ、 旧 I が実質達成される
- 旧 K (仕様ファイル明示) は N の一部として吸収可能 (production レジスターでは仕様ファイル必読)
- 旧 J (Output ONLY 緩和) は委任メッセージ作成の戦略として system-prompt で扱える

つまり **N-O-P は I-M を包含する上位概念** となる。 第3ラウンドは N-O-P を主軸に進める。

### 課題I: Post-Delegation Validation (新規 — 第3ラウンドの主軸)

- **観察**: セカンドが委任タスクを完了して return した後、 メインが内容検証していない
- **設計**: メイン側で `second_llm_agent` の戻り値+生成ファイルに対し:
  - delegate プロンプトから「重要キーワード」 を機械抽出 (例: 「直線」 「灰色」 「Z軸マイナス」)
  - 成果物ファイル (HTML 等) を file_read + grep でキーワード遵守を検査
  - 違反検出時に「[システム][仕様違反警告]」 を tool_result に挿入してメインに気づかせる
- **段階**:
  - 5-I1 (短期): メインの system-prompt に「委任完了後は成果物を file_read で検証」を明記
  - 5-I2 (中期): `second_llm_agent` ツールの返り値ラッパーで「成果物パス + 重要キーワード」を要求 (構造化)
  - 5-I3 (長期): キーワード自動抽出 (NLP) によるオートチェック

### 課題J: 委任プロンプトの「Output ONLY」 緩和

- **観察**: 「Output ONLY ```html...```」 のような固い指定が、 ハーネス警告への応答を阻害
- **設計**: ユーザー入力プロンプトを修正できないため、 メインが委任時に prompt を調整する戦略を system-prompt に明文化
  - 委任先がハーネス警告を受けたら **応答内に `<!-- HARNESS-NOTICE: ... -->` のような形で報告できる** ように、 委任時のプロンプトに 1 行追加することを推奨
  - または、 メインが委任プロンプトを構築する際に「Output ONLY」 系の固縛を「主要部分は HTML、 補足コメントは末尾に」 へ緩める

### 課題K: 委任前の仕様ファイル明示

- **観察**: セカンドが仕様書ファイルを読まない
- **設計**:
  - `buildSubAgentStrategyPrompt()` に「与えられた仕様ファイルパスがあれば必ず file_read してから実装開始」 を明文化
  - メインの system-prompt に「委任時は仕様ファイルパスを delegate メッセージに含め、 内容コピーは避ける」 を追記 (delegate メッセージの矛盾回避)

### 課題L: 委任前の自己整合性チェック

- **観察**: メイン側で delegate メッセージを組み立てるとき、 仕様書とメッセージ内容に矛盾があっても検出できない (path 配列を勝手に挿入したのは メイン or ユーザー指示か不明だが、 仕様書の「直線」 と矛盾)
- **設計**: メインが委任前に「delegate メッセージと仕様書の矛盾」 を簡易セルフチェックする戦略を system-prompt で促す (1 行ヒント、 最初は LLM の自律性に委ねる)

### 課題M: GUI/HTML/Three.js の動作検証

- **観察**: HTML/Three.js は構文チェック対象外 (file_write の構文チェックは js/json のみ)。 仕様遵守チェックがメインの効果的な検証手段
- **設計**:
  - 5-M1: file_write の構文チェック対象に **HTML script ブロック内の JS** も追加 (HTML 抽出 → Node.js --check)
  - 5-M2: browser_screenshot を「成果物検証ステップ」 として system-prompt で推奨 (Playwright が利用可能な場合)

---

## 第 3 ラウンド (2026-04-27 夜) — 対話レジスター + Acceptance Checklist

実装範囲: 第3ラウンドの 1〜5 を一括実装。 主軸は P10「対話レジスターの明示合意」。

### 実装したもの

| Phase | 内容 | 変更ファイル | ステータス |
|---|---|---|---|
| 5-N1+N2 | system-prompt に **対話レジスター 4 段階** (explore/rough/standard/production) を表形式で明文化。 完了基準もレジスターごとに明示 | `src/agent/system-prompt.ts` | ✅ |
| 5-N2 | **粒度判定の原則** を必須化: ①ユーザー明示優先、②**迷ったら過剰品質寄り**、③単純雑談は explore で短答 | 同上 | ✅ |
| 5-N2 | **開始時のレジスター宣言** を必須行動として明文化 ("このタスクは <レジスター> として進めます" を 1 行で宣言) | 同上 | ✅ |
| 5-O1 | **Acceptance Checklist** を standard 以上で必須化 (todo_write で 3-5 項目)。 全項目 ✓ になるまで response_complete を呼ばないルール | 同上 | ✅ |
| 5-P1 | **検証ルールをレジスター連動の表に再構成**。 GUI/HTML は構文だけでなく file_read で主要要素確認、 production では browser_screenshot を推奨 | 同上 | ✅ |
| 5-N3 | **委任時のレジスター継承** を必須化: delegate メッセージに ①レジスター ②Acceptance Criteria ③仕様ファイルパス を含める。 「Output ONLY」 のような形式縛りは禁止 | 同上 | ✅ |
| 5-N3 | セカンドLLM 用プロンプト (`buildSubAgentStrategyPrompt`) にもレジスター/Criteria/仕様ファイル作法/ハーネス警告応答ルールを継承 | `src/agent/harness-intervention.ts` | ✅ |
| 5-O2 | **response_complete のゲート化** — todo_write で立てた Acceptance Checklist に未完了項目があれば response_complete はエラーを返す (force=true で部分完成許容) | `src/tools/definitions/response-complete.ts` | ✅ |

### Claude Code 原則 (P1〜P10) との対応 — 第3ラウンドで埋まった点

| 原則 | 第3ラウンドで強化 |
|---|---|
| **P10 対話レジスターの明示合意** | system-prompt 主軸として導入。 セカンドにも継承 ✅ |
| P5 委任の閾値設計 | 委任時のレジスター継承で完了基準が伝わるようになった ✅ |
| P7 計画は重い案件のみ | Acceptance Checklist が plan_mode の事実上の置き換え (より軽量) ✅ |

### 動作変化のサンプル (第3ラウンド)

```
# 例1: ユーザーが「3D ゲーム作って」 と依頼
[第2ラウンド時点]
  → 1 ターン HTML 生成 → ファイル存在で完了 → 動かないことに気付かない

[第3ラウンド以降]
  → "このタスクは standard として進めます" 宣言
  → todo_write で Checklist 立てる
    [ ] HTML が file_write される
    [ ] 主要状態機械 (READY/PLAYING/PENALTY/GOAL) が含まれる
    [ ] 道路 + 自車 + 障害物 + アイテム + ゴールが描画される
    [ ] 構文 OK (HTML 内 JS を node --check)
    [ ] 仕様キーワード (灰色 / 直線 等) が成果物に反映
  → 各項目を消化しながら進める
  → response_complete 呼んでも todo 残ってればエラー → 再考促す

# 例2: ユーザーが「ちょっと聞きたい」 と依頼
[第3ラウンド以降]
  → "このタスクは explore として進めます" 宣言
  → 2-3 文で答えて response_complete (Checklist 不要)

# 例3: 委任
[第2ラウンド時点]
  → "Output ONLY HTML" と委任 → セカンドはハーネス警告も無視

[第3ラウンド以降]
  → メインがレジスター/Acceptance Criteria/仕様ファイルパスを delegate メッセージに含める
  → セカンドは buildSubAgentStrategyPrompt で受け取った原則に従い、
     仕様ファイルを file_read してから着手、 ハーネス警告は末尾コメントで報告
```

### 副作用・リスク

- system-prompt が大幅に長くなった (約 80 行追加)。 トークン消費増は許容範囲だが、 監視は必要
- 短い挨拶や explore でも「レジスター宣言」 が要求されるため、 1 行余分なテキストが出る (ユーザー体験はやや冗長)。 必要なら次ラウンドで「explore は宣言省略可」 緩和
- response_complete のゲートは強い介入。 todo_write を立てなければゲートは効かないが、 todo を立てた後にユーザーが方針変更した場合に「force」 を毎回付けるのは煩雑。 改善余地あり
- セカンド側は委任メッセージに レジスター/Criteria が含まれていないと standard デフォルト → 旧クライアント互換性を保つ意図、 ただし「迷ったら過剰品質」 の原則と整合する

### 第 3 ラウンド: リトライ結果ログ

#### リトライ #1
- 日時: (未実施)
- セッションログ:
- 観察:
- 残課題:
- 副作用:

---

## 第 4 ラウンド以降の予定 (未着手)

第 3 ラウンドのリトライ結果を見てから決める。 候補:

- **5-A2**: 全ツールに `selfHelpHints()` 共通インターフェース化
- **5-A3**: ハーネス側のエラー分類器 + 連続失敗時の自動 `find` 実行
- **5-B3**: second_llm_agent 引数に「委任理由 (3条件)」を要求するハードガード
- **5-C3**: web_fetch / browser_screenshot 等への副次情報追加
- **5-D3**: plan_mode 起動後の TaskWrite 強制
- **5-F1**: progressTracker (進捗ゼロターン検出)
- **5-F (評価系)**: `scripts/eval-jsonl.js` でログから自動集計
- **5-H2**: Read→Edit 契約のハードガード化 (新規ファイル例外を扱える設計で)
- **5-N4**: ハーネスが宣言レジスターを保持し、 完了報告時に self-review を促す
- **5-O3**: ハーネスが Acceptance Checklist と完了報告を照合し、 不一致時は警告挿入
- **5-P2**: file_write で .html 生成時、 ハーネスが自動で動作確認手順を tool_result に挿入

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
