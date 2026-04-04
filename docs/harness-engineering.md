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
   - Windows環境でgit bashを自動検出して使用。見つからない場合のみcmd.exeフォールバック
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
