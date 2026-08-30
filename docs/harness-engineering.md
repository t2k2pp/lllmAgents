# ハーネスエンジニアリング改善設計書

> **実装状況**: Phase 1-4 全項目完了 (2026-03-31)

## 実装変更ログ

### 設計からの変更点

1. **PostToolHookではなくツール本体に直接実装**
   - file_edit失敗時のファイル内容添付 → `file-edit.ts` に直接実装（Hook経由より直接的）
   - file_write構文チェック → `file-write.ts` に直接実装
   - 理由: Hookは外部コマンド実行型で、ファイル内容の読み取り・構文解析に向かない

2. **bash.ts: cmd.exe → git bash に変更**
   - 設計書では「文字化け対策」だけだったが、根本原因（cmd.exeで実行していた）を修正
   - Windows環境でgit bashを自動検出して使用。見つからない場合は意味の異なるcmd.exeへ置換せず、導入手順付きで実行前に失敗
   - これにより `cat`, `head`, `grep` 等のUnixコマンドがWindowsでも動作するようになった

3. **file_edit連続失敗追跡 → agent-loop.ts に実装**
   - 設計では「C3: tool-executor.tsで」としていたが、tool_resultへの追記が必要なためagent-loop内に
   - `fileEditFailCounts` Mapでファイルパスごとの連続失敗を追跡

4. **スキル: /project を新規作成（/game-development と別）**
   - game-developmentは「単一HTMLファイル」前提の既存スキル
   - /project はマルチファイル一般のオーケストレーション手順書として新規作成

5. **Autorunモード追加（設計書範囲外）**
   - ユーザー要望「ファイル削除じゃなきゃガンガンやってほしい。確認が多い」に対応
   - `permission-manager.ts` にautorunMode追加。非破壊操作(file_write/edit, bash非破壊, web/browser)を自動許可
   - `/autorun` コマンドでトグル。プロンプトに `[autorun]` 表示

6. **並列ツール実行数の制御（設計書範囲外）**
   - vLLM KVキャッシュの制約（同時3コールが限界）に対応
   - `agent-loop.ts` の `executeToolsParallel()` にセマフォ（acquire/release）パターン実装
   - `Config.maxParallelTools` (デフォルト3) で設定、`/parallel` コマンドで実行時変更可能

7. **`</think>` タグ表示修正（設計書範囲外）**
   - ストリーミング表示にthinkタグが漏れる問題を修正
   - ステートフルクロージャでpending bufferを持ち、チャンク境界を跨ぐタグを処理

---

## 背景

テトリス作成セッション（41ターン/6時間）のログ分析から、現在のシステムには
「27Bクラスのモデルを正しく動かすためのハーネス」が決定的に不足していることが判明した。

2026年の27Bモデルは十分な能力を持つが、**ハーネスが適切なコンテキスト・戦略・フィードバックを
提供しなければ、能力を発揮できない**。問題はモデルではなくハーネスにある。

## ログから判明した問題の構造

### 問題1: システムプロンプトが「禁止事項リスト」でしかない

現在のプロンプトは「何をするな」「何を使え」の羅列。
「どう仕事を進めるか」の戦略・手順が一切ない。

**具体的な欠落:**
- マルチファイルプロジェクト作成時の手順（依存順に生成、インターフェース先行等）
- file_edit失敗時のリカバリ戦略（file_readで確認→file_writeで全体書き直し）
- ツール選択の判断基準（ファイル内容確認にはbashではなくfile_readを使う等）
- Windows環境でのbash使用時の注意（cmd構文ではなくgit bash構文を使う等）

### 問題2: ツールのフィードバックが貧弱

- `file_edit`失敗時: `"old_string not found in file"` だけ返す → モデルはファイルの現在の内容が分からず、
  再度file_readするか、また間違ったold_stringで試すしかない
- `file_write`成功時: `"File written: /path/to/file.js"` だけ返す → 構文エラーがあっても
  モデルにフィードバックされない。20ターン後にfile_readで気づく
- `bash`失敗時: Windows文字化けしたSTDERR → モデルは何が起きたか理解できない

### 問題3: エージェントループに「仕事の進め方」の知能がない

- テキストのみ応答の検出は「150文字未満」というヒューリスティック → 400文字の計画テキストは検出されない
- 自動リプロンプト「ツールを呼び出して実装を開始してください」が25回蓄積 → コンテキストを汚染するだけ
- ツール呼び出し後の検証がゼロ → file_writeで壊れたJSを書いても次に進む
- file_edit連続失敗の検出なし → 同じファイルに何度もedit失敗を繰り返す

### 問題4: コンテキスト管理が甘い

- 設計書を書いた後、設計書の内容はコンテキストにない（tool_resultとして1回見えるだけ）
- 過去のエラーメッセージがすべてコンテキストに残り続ける（Turn 41で113KB）
- ファイルを書いた内容もtool_resultとして全文が残る → 必要なのはインターフェース情報だけ

---

## 改善設計

### A. システムプロンプトの再設計

#### A1. コアアイデンティティの刷新

Before:
```
あなたはLocalLLM Agent - ローカルLLMで動作するCLIベースのAIアシスタントです。
ユーザーのPC上でソフトウェアエンジニアリングタスクを支援します。
```

After:
```
あなたはソフトウェアエンジニアです。ツールを使ってコードを書き、ファイルを操作し、タスクを完遂します。
考えたら即座にツールを呼び出してください。テキストで計画や説明を書くのではなく、行動してください。
```

ポイント: 「AIアシスタント」→「エンジニア」。情報量ゼロの自己紹介を排除し、行動指針を直接埋め込む。

#### A2. 作業戦略セクションの追加

```markdown
# 作業の進め方

## ファイル操作の原則
- ファイルの内容を確認するには file_read を使う。bash (cat/type/head) は使わない
- file_edit の old_string が見つからなかったら、file_read で現在の内容を確認し、
  正しい old_string で再試行する。2回失敗したら file_write でファイル全体を書き直す
- 新規ファイル作成には file_write を使う。コードをテキスト応答に含めない

## マルチファイルプロジェクト作成
1. まずファイル一覧と各ファイルの責務を整理する（todo_write）
2. 依存される側のファイルから順に作成する（定数→ユーティリティ→コアロジック→UI→エントリポイント）
3. 1つのファイルを書いたら、そのファイルの export を次のファイル作成時の文脈として意識する
4. 独立した複数ファイルは1回のレスポンスで並列に file_write する
5. 全ファイル作成後、エントリポイントから各ファイルへの参照が正しいか file_read で検証する

## エラー回復
- file_edit 失敗 → file_read → 正しい old_string で再試行 or file_write で全体書き直し
- bash エラー → エラーメッセージを読んでコマンドを修正。Windows では git bash 構文を使う
- 同じ操作が2回失敗したら別のアプローチに切り替える
```

#### A3. 環境情報の強化

```
- シェル: git bash（Unix構文を使用。cmd.exe/PowerShell構文は使わない）
```

現在は `cmd.exe/PowerShell` と書いてあるが、実際は git bash で実行されている。これがモデルを混乱させている。

### B. ツールフィードバックの強化

#### B1. file_edit 失敗時にファイルの先頭と周辺を返す

```typescript
// file-edit.ts: old_string not found の場合
if (occurrences === 0) {
  // ファイルの内容を添付してモデルの次の判断を助ける
  const preview = content.slice(0, 1000);
  const lineCount = content.split("\n").length;
  return {
    success: false,
    output: `ファイルの現在の内容 (${lineCount}行, 先頭1000文字):\n${preview}`,
    error: "old_string not found in file. file_writeでファイル全体を書き直すことを検討してください。",
  };
}
```

効果: モデルがfile_readを別途呼ぶ1ターンを省略。正しいold_stringの構成を助ける。

#### B2. file_write 後の構文チェック（PostToolHook）

```typescript
// file_write の PostToolHook として実装
// .js/.ts/.json ファイルの場合、構文チェックを自動実行
async function validateAfterWrite(filePath: string): Promise<string | null> {
  const ext = path.extname(filePath);
  if (ext === ".js" || ext === ".mjs") {
    // node --check で構文チェック
    const result = execSync(`node --check "${filePath}"`, { encoding: "utf-8", timeout: 5000 });
    // エラーがあれば返す
  }
  if (ext === ".json") {
    // JSON.parse で検証
  }
  if (ext === ".html") {
    // 基本的なタグ整合性チェック
  }
  return null; // 問題なし
}
```

効果: 構文エラーのあるファイルを書いた直後にモデルにフィードバック。20ターン後の気づきを即座に。

#### B3. bash エラーの文字化け対策

Windowsの文字化けSTDERR（Shift-JIS）をUTF-8にデコードしてから返す。
さらに、よくあるWindows特有エラー（'cat'は認識されていません等）には
「file_readツールの使用を推奨します」を自動付与。

### C. エージェントループの改善

#### C1. テキストのみ応答の検出を賢くする

現在: `textContent.trim().length < 150` → 400文字の計画テキストは検出されない

改善: ツール呼び出しなし + 特定パターン（「次は〜します」「残りのファイル:」等）を検出

```typescript
function isImplementationPlan(text: string): boolean {
  // 実際にツールを呼ばずに計画だけ述べているパターン
  const planPatterns = [
    /次[はに].{2,20}(します|実装|作成|修正)/,
    /残[りっ].{2,20}(ファイル|タスク)/,
    /以下.{2,20}(作成|実装|修正)/,
    /まず.{2,20}(から|必要)/,
  ];
  return planPatterns.some(p => p.test(text));
}
```

#### C2. 自動リプロンプトの改善

現在の問題:
- 同じメッセージが25回コンテキストに蓄積
- ユーザーメッセージとして追加される → モデルは「ユーザーが何度も催促している」と解釈

改善:
1. 自動リプロンプトは**前回のものを上書き**する（蓄積しない）
2. 3回連続でテキストのみ応答 → テキスト応答を**履歴から削除**して
   「あなたの前の応答は実行されませんでした。テキストではなくツール呼び出しだけを返してください。」
3. 5回連続 → ユーザーに報告して中断

```typescript
if (consecutiveTextOnlyCount >= 3) {
  // 前回のテキスト応答を履歴から削除
  this.history.removeLastAssistantMessage();
  this.history.addUserMessage(
    "あなたの前の応答はテキストのみでした。テキストは不要です。" +
    "次のアクションとして必要なツールを呼び出してください。"
  );
}
if (consecutiveTextOnlyCount >= 5) {
  console.log(chalk.yellow("\n  モデルがツール呼び出しを行えません。プロンプトを変えて再度お試しください。"));
  return;
}
```

#### C3. file_edit 連続失敗のエスカレーション

同一ファイルへの file_edit が2回連続失敗 → tool_result に
「file_writeでファイル全体を書き直してください」を自動付加。

```typescript
// executeSingleTool 内
if (toolCall.function.name === "file_edit" && !result.success) {
  this.fileEditFailCounts.set(filePath, (this.fileEditFailCounts.get(filePath) ?? 0) + 1);
  if (this.fileEditFailCounts.get(filePath)! >= 2) {
    resultContent += "\n\n[システム] このファイルへのfile_editが連続で失敗しています。" +
      "file_readで内容を確認し、file_writeでファイル全体を書き直すことを推奨します。";
  }
}
```

### D. コンテキスト管理の改善

#### D1. 設計書の常駐注入

ユーザーが設計書を作成させた場合（file_writeで*.mdを作成 + 設計/design等のキーワード）、
その内容をシステムプロンプトの動的セクションとして注入する。

#### D2. file_write の tool_result 軽量化

現在: `"File written: /path/to/file.js"` のみ
モデルが後で参照するためにはfile_readが必要。

改善: file_write 成功時に、ファイルの export/関数定義の要約を自動生成して返す。
```
File written: /path/to/Board.js (71 lines)
Exports: class Board { constructor(width, height), addPiece(piece), clearLines(), isGameOver() }
```
これにより後続のファイル生成時に前のファイルのインターフェースを参照できる。

#### D3. ツール結果の経年劣化圧縮

5ターン以上前のtool_resultで、かつ後続のターンで同じファイルが再操作されている場合、
古いtool_resultを要約に置換する。

---

## 実装優先度

| Phase | 内容 | 効果 | 工数 |
|-------|------|------|------|
| **Phase 1** | A1+A2+A3: システムプロンプト再設計 | 全タスクで効果。即効性高い | 小 |
| **Phase 2** | B1: file_edit失敗時のファイル内容添付 | edit失敗ループ解消 | 小 |
| **Phase 2** | C2: 自動リプロンプト改善（蓄積防止+エスカレーション） | テキストのみループ解消 | 小 |
| **Phase 2** | C3: file_edit連続失敗のfile_write推奨 | 修正ループ短縮 | 小 |
| **Phase 3** | B2: file_write後の構文チェック | バグの早期発見 | 中 |
| **Phase 3** | B3: bash Windows文字化け対策 | エラー理解向上 | 小 |
| **Phase 3** | C1: テキストのみ応答の検出改善 | 計画テキスト検出 | 小 |
| **Phase 4** | D2: file_write結果のインターフェース要約 | ファイル間整合性向上 | 中 |
| **Phase 4** | D1: 設計書のコンテキスト常駐 | 設計との整合性向上 | 中 |
| **Phase 5** | D3: ツール結果の経年劣化圧縮 | コンテキスト効率化 | 大 |

---

## Phase 6: スコープ越境とループ対策 (2026-04-19 追記)

### 契機となった事故

**セッション**: `Issue_実行ログ.txt` (2026-04-19)

**経緯**:
1. ユーザーが `@output/flutter/saleslogger/PriceLoggerApp.html` を添付し「Flutter（Android）向けに作成してほしい」と明示スコープを与えた
2. LLMは添付済みファイルを **再 file_read**（無確認・autoApprove済み）
3. `enter_plan_mode` 突入
4. `bash $ ls -R C:\...\lllmAgents\sandbox` を「bashをセッション中常に許可」で承認
5. 約1200行のファイル一覧（大半がタスク無関係なminecraftスクリーンショット等）がコンテキストに投入
6. さらに類似スキャンを繰り返し、ユーザーがCTRL+Cで強制中断

**ユーザーからの指摘（本質）**:
- ① カレントフォルダ配下以外を参照するbashは、session-allowでも確認を挟むべき
- ② ハーネスの「自動リプロンプト」が **ユーザーが言ってもないセリフを history に注入** し、LLMに「ユーザーが不満を言っている」誤解を与えて自己批判ループを誘発している

### 問題5: bash権限の粒度がCWDスコープに沿っていない

現在 `checkAutorunPermission()` は `AUTORUN_DESTRUCTIVE_PATTERNS`（`rm` `rmdir` `dd` 等）のみチェック。
非破壊であれば sandbox 内のどこでも読める。結果:

- `ls -R sandbox全体` のような**コンテキスト爆撃級**のスキャンがフリーパス
- sandbox は広い（sandbox/output/games/minecraft2d/*.png 等が無関係に混入）
- ユーザーが期待するスコープは「タスクで触るCWDとその配下」であり、sandbox ≠ タスクスコープ

### 問題6: 自動リプロンプトが「偽ユーザーメッセージ」として注入されている

`agent-loop.ts` で LLM応答後に `history.addUserMessage(...)` で user ロールのメッセージを注入する箇所が5つ存在する:

| 箇所 | 注入内容 |
|---|---|
| L656 verification retry | "動作確認が完了していません。bashで検証コマンドを実行してください" |
| L686 Evaluator review | "critical問題があります、修正してください" |
| L738 textOnly reprompt (3回目〜) | "テキストで説明する必要はありません。ツールを呼び出してください" |
| L746 textOnly reprompt (1-2回目) | "説明は不要です。最初のアクションとしてツールを実行してください" |
| L760 codeBlock retry | "実際にファイルを作成してください。file_writeを使ってください" |

これらは**ローカルLLMに粘り強く思考させる**ための仕組みとして設計されたもので、削除はできない（弱モデル補助のため必要）。
問題は **ユーザー発話として混ぜている** 点。LLMから見ると「今後気を付けますと言ったのに、ユーザーがさらに詰めてきた」状況に見え:

- 元のタスクスコープを見失い、焦って雑なツール呼び出しをする
- 履歴内で真のユーザー意図が偽の苛立ちに埋もれる
- 自己批判ループに入り、類似ツールを繰り返し呼び出す（上記事故のリピート行動）

---

## 設計

### E1. CWD外bashの確認必須化 (問題5対応)

**方針**: `checkAutorunPermission()` の bash 判定に **CWD スコープチェック** を追加する。

**実装**:
```typescript
// permission-manager.ts: checkAutorunPermission() のbash分岐
if (toolName === "bash") {
  const command = (params.command as string) ?? "";
  if (AUTORUN_DESTRUCTIVE_PATTERNS.some((p) => p.test(command))) return null;
  const dangerousRule = checkCommand(command);
  if (dangerousRule?.action === "block") {
    return { allowed: false, reason: dangerousRule.message };
  }
  // 【追加】コマンド本文に CWD 外のパスが含まれるか検査
  if (referencesOutsideCwd(command, this.cwd)) {
    return null; // 通常確認フローへフォールバック
  }
  return { allowed: true };
}
```

**`referencesOutsideCwd()` の判定**:
- コマンド文字列から絶対パス・`..` 含みパスを抽出
- 抽出したパスを `path.resolve(cwd, ...)` で解決し、CWD 配下か確認
- 再帰スキャン系（`ls -R`, `find`, `tree -R`）は CWD 配下でも出力量が爆発するため別途 warning
- 対象外（CWDのみ言及 or 相対パスで配下のみ）→ 自動承認

**セッション許可の粒度変更**（副次）:
- 現在: 「bash をセッション中常に許可」で全bashがフリー
- 将来: `bash:cwd-only` と `bash:any-path` を分離し、「bash:cwd-only をセッション中常に許可」を提供

### E2. 自己点検フェーズと `response_complete` ツール (問題6対応)

**方針**: 「偽ユーザーメッセージで詰める」をやめ、「**自己点検メッセージ**として明示し、LLM側に `response_complete` ツールで完了宣言させる」設計に切り替える。

**新規ツール `response_complete`**:
```typescript
{
  name: "response_complete",
  description: "ユーザーの依頼を完了した、または追加作業が不要と判断した場合に必ず呼ぶ。このツールを呼ぶまでハーネスは自己点検を要求する。",
  parameters: {
    summary: { type: "string", description: "今回のターンで行った作業の要約" }
  }
}
```

**自己点検メッセージの形（例）**:
```
[自己点検 N/3] 今の応答を確認してください:
  ・ユーザーの依頼「<元の依頼>」に応えていますか？
  ・必要なツール（file_write、検証コマンド等）は全て実行しましたか？
  ・追加作業が不要なら response_complete ツールを呼んでください
  ・作業が残っているなら該当ツールを呼んでください
```

**重要な設計決定**:
- **role は `user` 維持**（ChatMLモデル互換性のため）だが、本文先頭に `[自己点検 N/3]` マーカーで**明示的に識別可能**に
- ユーザーが実際に発した文字列は混ぜない（偽装の排除）
- ハーネス通知であることをLLMが認識できるため、「詰められている」誤解が消える

**既存5箇所のリプロンプトを統合**:
現状の5つの個別リプロンプトは、以下の共通パターンに統合できる:

```
[自己点検 N/3] <具体的な懸念>。
response_complete で完了宣言するか、必要なツールを呼んでください。
```

| 旧リプロンプト | 新・自己点検の具体的懸念 |
|---|---|
| verification retry | "以下のファイルの動作確認が未完了です: <list>。node --check 等で検証してください" |
| Evaluator review | Evaluator出力を「第三者レビューから以下の指摘があります」として提示 |
| textOnly reprompt | "テキスト応答のみでツール呼び出しがありません。ユーザー依頼の遂行に必要なツールを実行してください" |
| codeBlock retry | "コードがテキストで返されました。file_writeで保存してください" |

**無限ループ対策**:
- `MAX_SELF_CHECK_ROUNDS = 3` で打ち止め
- 自己点検メッセージに **残回数を明示** (`[自己点検 2/3]`) → LLMが「あと1回で打ち切り」を把握しサボりにくい
- 上限到達時: ユーザーに「3回の自己点検で response_complete が呼ばれませんでした」と報告し turn 終了
- 既存 `MAX_TEXT_ONLY_RETRIES` 等のカウンタは廃止し、`selfCheckRounds` 1本に統一

**自己点検のスキップ条件**:
- `plan mode` 中はユーザー承認待ちなので自己点検しない
- LLMが `response_complete` を呼んだ直後は当然スキップ
- 会話的入力（挨拶等、`intentClassifier` が "task" と判定しないもの）はスキップ

### E3. 実装順序と依存

E1 と E2 は独立。ただしユーザー体感としては **E2 が最優先**（本質的な行動改善）。

**推奨順序**:
1. E1 先行（小工数・即効性・事故の直接再発防止）
2. E2 本体（設計合意後。既存5リプロンプトを段階的に `response_complete` 方式へ移行）
3. E2 移行完了後、旧リプロンプトの dead code を削除

---

## Phase 6 実装優先度

| Phase | 内容 | 効果 | 工数 |
|-------|------|------|------|
| **Phase 6-A** | E1: CWD外bash確認必須化 | スコープ越境事故の直接防止 | 小 |
| **Phase 6-B** | E2: response_complete ツール新設 + 自己点検メッセージ導入 | 偽ユーザー発言除去、ループ誘発の根本解消 | 中 |
| **Phase 6-C** | E2: 既存5リプロンプトを自己点検へ段階統合 + 旧コード削除 | ハーネスロジック単純化 | 中 |
