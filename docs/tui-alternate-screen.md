# TUI レンダリング設計書（inline既定 / Alternate Screen明示選択）

> **ステータス**: 2026-08-13 設計 / 実装
> **関連**: `docs/repl-io-robustness.md` / `docs/interrupt-and-progress-design.md` /
> `docs/spinner-mode-response-coloring-design.md` / `docs/issues.md` (不具合 1・2・4)

---

## 1. 背景

### 1.1 現状: 全員が stdout に直接書いている

描画の所有者がいない。 あらゆる箇所が `console.log` / `process.stdout.write` で
**同じ 1 本の stdout に順次書き込む**。

| 書き手 | 書き方 |
|--------|--------|
| REPL 本体 (`repl.ts`) | `console.log` (1,000 箇所超) |
| エージェントループ | `console.log` + ストリーミングの逐次 `write` |
| スピナー (`ora`) | 行を上書きする ANSI |
| 進捗インジケータ (`progress-indicator.ts`) | `\r\x1b[2K` + 1 行 |
| インタラクティブ入力 (`interactive-input.ts`) | 入力行 + ドロップダウンをカーソル移動で描画 |
| `inquirer` プロンプト (27 箇所) | 独自のフルレンダラで行を再描画 |
| バックグラウンドのチャネル通知 / タスク完了通知 | `console.log` |

**誰もお互いの存在を知らない**。 これが不具合 1・2・4 の共通の根である。

### 1.2 不具合との対応

| 不具合 | 症状 | 直接原因 |
|--------|------|---------|
| **1** | `ask_user` の選択肢の 1 行目が大量に複製され読めない | `inquirer` が「前回描いた行数ぶん上に戻って描き直す」 前提で動くところに、 スピナー等が別の行を書き足す。 行数の前提がズレ、 カーソルが戻りきらず同じ行が積み上がる |
| **2** | 他の出力に選択肢が埋もれる。 カーソルキーを押すと見える | `inquirer` は再描画のきっかけがキー入力しかない。 割り込み出力で流れても、 自分が流されたことを知らない |
| **4** | 入力できそうなのに、 一度 Enter を押すまで操作を受け付けない | 端末が cooked (行バッファ) モードのまま。 打鍵は端末のバッファに溜まり Enter で初めてアプリに届く。 `ora` の `discardStdin` は対策済みだが、 raw mode の所有者が一元化されていないため他経路で再発する |

**1 と 2 は「割り込み出力」 が原因、 4 は「stdin の所有者不在」 が原因**。
どちらも「端末の所有者がいない」 という 1 つの構造問題の別の顔である。

### 1.3 やること

端末I/Oを1つのコンポーネントが所有し、既定はmain bufferへ追記するinline表示にする。
固定viewportが必要な利用者だけ **代替画面バッファ (Alternate Screen Buffer)** の
フルスクリーン描画 (TUI) を明示的に選択する。

- スクロールバック領域とライブ領域 (入力欄・スピナー) を **構造的に分離**する
- すべての出力を **1 箇所に集約**し、 書き込み順ではなく所有権で調停する
- 既定inline表示で端末本来のマウス選択とホイールscrollbackを同時に維持する
- `--alt-screen`または`LLLMAGENT_ENABLE_ALTERNATE_SCREEN=1`で全画面TUIを明示選択できる

---

## 2. 全体構造

```
   ┌─ Alternate Screen ────────────────────────────┐
   │                                               │
   │   スクロールバック領域 (viewport)               │  ← ScreenManager が所有
   │   ・過去の出力を行配列として保持                 │     行配列の末尾 N 行を描画
   │   ・マウスホイール / PgUp / PgDn で遡れる       │
   │                                               │
   ├───────────────────────────────────────────────┤
   │   ライブ領域 (下端 1〜数行)                      │  ← 1 人だけが所有できる
   │   入力欄 / スピナー / プロンプト                  │     (LiveRegion の排他制御)
   └───────────────────────────────────────────────┘
```

### 2.1 中心にあるのは「所有権」 であって「代替画面」 ではない

代替画面の採用は目に見える変化だが、 **本質は所有権の一元化**である。
代替画面を使わないclassic streamモード (§6) でも所有権の調停は効くようにする。
そうしないと「環境変数で戻したら不具合 1・2 が復活する」 ことになる。

---

## 3. ScreenManager

新規 `src/cli/screen-manager.ts`。 端末の唯一の所有者。

### 3.1 責務

1. 代替画面バッファへの入退場 (`\x1b[?1049h` / `\x1b[?1049l`)
2. スクロールバック行配列の保持と描画
3. ライブ領域の排他制御
4. すべての出力の受け口

### 3.2 API

```ts
export interface LiveOwner {
  /** 所有者の名前 (デバッグ・ログ用) */
  name: string;
  /**
   * ライブ領域を描き直す。 これを実装できる所有者は「ソフト所有」 になり、
   * 割り込み出力があっても消えない (§4.2)。
   * 実装できない所有者 (inquirer 等) は undefined を渡して「排他所有」 になる。
   */
  redraw?: () => void;
  /** ライブ領域が今何行あるか (排他所有では使わない) */
  height?: () => number;
  /** status/progressより下端へ固定する処理中composer */
  pinned?: boolean;
}

export interface ScreenManager {
  /** 起動。 alt screen に入る (classic stream / 非TTYでは何もしない) */
  start(): void;
  /** 終了。 alt screen を抜けて内容をスクロールバックへ書き戻す */
  stop(): void;
  /** 出力を 1 つ受け取る。 console.log 相当 */
  write(text: string): void;
  /** ライブ領域を取得する。 解放関数を返す */
  acquireLive(owner: LiveOwner): () => void;
  /** 今ライブ領域を持っている所有者 (いなければ undefined) */
  currentOwner(): string | undefined;
  /** session resume用の確定stdout取得・復元（spinner/composerは除外） */
  snapshotScrollback(): ScrollbackSnapshot;
  restoreScrollback(snapshot: ScrollbackSnapshot): void;
  onCommittedOutput(listener: (text: string) => void): () => void;
  /** 代替画面が有効か */
  isAlternate(): boolean;
}
```

### 3.3 出力の集約方法 — なぜ呼び出し側を書き換えないか

`console.log` の呼び出しは repl.ts だけで 1,000 箇所を超える。
これを全部書き換えるのは、 変更量に対して得るものが釣り合わない上、
**書き換え漏れが 1 箇所でもあると画面が壊れる** (漏れた 1 行が所有権を無視して
割り込む)。

そこで **`console` と `process.stdout.write` を起動時に 1 回だけ差し替える**。

```ts
// 差し替え前の生ハンドルを捕まえておく (ScreenManager 自身はこれで書く)
const rawWrite = process.stdout.write.bind(process.stdout);

console.log = (...args) => screen.write(format(...args) + "\n");
process.stdout.write = (chunk, ...rest) => { screen.write(String(chunk)); return true; };
```

利点:
- **漏れがない**。 まだ見ぬ将来のコードも自動的に経路に乗る
- 呼び出し側の差分がゼロ = レビュー可能な変更量に収まる
- classic streamモードでは差し替えた関数が `rawWrite` に素通しするだけ

注意点:
- ScreenManager 自身の描画は必ず `rawWrite` を使う (無限再帰の防止)
- `console.error` は **stderr のまま**にする。 パイプで `2>` に落とす運用を壊さない。
  ただし、LLM呼び出し失敗などユーザー判断に必要な実行時エラーは`writeRuntimeError()`を使い、
  Alternate Screen中だけ確定scrollbackへ記録する。classic streamでは従来どおりstderrへ出す
- 外部プロセス (bash ツール) の出力は子プロセスの stdout を継承させず、
  既存どおりアプリ側で読んで `console.log` するので自動的に経路に乗る

### 3.4 スクロールバックの保持

```ts
private lines: string[] = [];     // 表示済みの全行 (ANSI 込み)
private maxLines = 10_000;        // 超えたら先頭から捨てる
private viewOffset = 0;           // 0 = 最下部に追従。 >0 で遡り中
```

- `write()` は受け取ったテキストを改行で分割して保存用の論理`lines`に追加する。
  描画時はANSIとgraphemeを保ったまま端末幅の物理行へ折り返し、画面幅より後ろの本文を切り捨てない
- 末尾が改行で終わらない書き込み (ストリーミング中の逐次出力) は
  **最終行に追記**する。 これをしないと 1 文字ごとに行が増える
- `viewOffset > 0` (遡り中) のとき新しい出力が来ても **視点を動かさない**。
  読んでいる最中に勝手にスクロールするのは最悪の体験である。
  代わりに下端に `▼ 新しい出力が N 行` を出す
- マウスホイール / PgUp / PgDn は入力プロンプトだけでなく、ScreenManager が stdin を保持する
  **セッション全期間**で処理する。LLM応答中・ツール実行中も履歴を遡れることを
  実PTY smokeで保証する。明示的にmouse ONへ切り替えた時だけSGR mouse reportを有効化し、ホイールが
  入力履歴の上下キーへ変換されることを防ぐ。readlineへ分割されたreport断片は入力欄から除外する。
  inquirer等の排他プロンプト中はmouse reportを一時解除し、プロンプト側の入力契約を優先する
- 既定inline表示ではAlternate Screenにもmouse captureにも入らず、端末本来の通常ドラッグ選択と
  ホイールscrollbackを同時に使う。全画面TUIを明示した場合はmouse captureを既定OFFとし、選択を優先する。
  内部履歴をホイール移動したい場合だけ`/tui mouse on`、起動引数`--mouse`、または
  `LLLMAGENT_ENABLE_MOUSE=1`で有効化する。`--mouse`は`--alt-screen`を含意する。mouse ON中の
  native選択は`Shift+ドラッグ`、`/tui mouse off`で通常ドラッグへ戻せる。PgUp/PgDnは全画面TUIで常時有効
- 遡り中は案内表示に1行使うため、最大offsetも案内を除いたcontent heightで計算し、
  最古行まで到達できることをunit testで保証する

### 3.4.1 session resume時の復元

確定した`write()`だけをsession別の`terminalTranscript`へ最大10,000行保存する。
spinner frame、進捗上書き、編集中composerはlive表示なので保存しない。`/resume`、
`--resume`、`--continue`、明示的なRoom移動ではscrollbackを保存snapshotへ置換する。
一方、Discord/Slack runのために内部でRoomを借りるだけの切替ではCLI画面を変更しない。
旧sessionは空画面へ黙って落とさず、conversationのuser/assistant/tool履歴から可読表示を再構成する。

保存snapshotが存在しても、それだけでconversationが完全とはみなさない。1行previewはlive表示のため、
旧版で継続前の本文が確定されなかったsessionや、非TTYでuser入力を確定stdoutへechoしないsessionがある。
resume時はANSI・Markdown装飾・空白差を除いてuser/assistant本文の先頭・中央・末尾を照合し、欠けた本文だけを
`/resume: 保存stdoutから欠けていた会話を復元`セクションへ補完する。補完件数は明示し、補完後snapshotを
sessionへ引き継ぐ。保存snapshot・legacy再構成・補完本文は改行を含まない論理行へ正規化してから保持し、
端末幅に応じた折り返しは表示時だけ行う。これにより過去の診断stdoutを捨てず、canonicalなmessage履歴も
末尾まで画面で読める。

### 3.5 描画

```
1. カーソルを隠す (\x1b[?25l)
2. ライブ領域の高さ h を所有者から取得 (いなければ 0)
3. viewport 高 = rows - h
4. lines の該当範囲を上から書く (行ごとに \x1b[2K で消してから)
5. ライブ領域を所有者の redraw() で描かせる
6. カーソルを戻して表示 (\x1b[?25h)
```

全画面を毎回描き直すのは、 差分描画のバグ (= まさに不具合 1) を構造的に
避けるためである。 数十行の書き換えは現代の端末では十分速い。

ただし **描画は 16ms でまとめる** (連続する `write()` を 1 回の描画に集約)。
ストリーミング中は 1 トークンごとに `write()` が来るため、 これが無いと
描画がボトルネックになる。

---

## 4. ライブ領域の排他制御 — 不具合 1・2 の解決

### 4.1 2 種類の所有

| 種別 | 誰が | 割り込み出力が来たら |
|------|------|---------------------|
| **ソフト所有** | `InteractiveInput` (自前描画なので `redraw()` を渡せる) | スクロールバックに書き、 **ライブ領域を描き直す** |
| **排他所有** | `inquirer` プロンプト (外部ライブラリで再描画を呼べない) | **出力をキューに退避**し、 プロンプト終了後にまとめて流す |

### 4.2 ソフト所有 (入力待ち中)

入力待ちは REPL の大半の時間を占める。 ここで出力をキューに溜めると
バックグラウンドのタスク完了通知やチャネル受信が一切見えなくなる。

`InteractiveInput.question()` の中でライブ領域を取り、
自身の入力行 + ドロップダウン描画関数を `redraw` として渡す。
割り込み出力が来たら ScreenManager が「スクロールバック更新 → `redraw()`」
の順で描き直すので、 **入力中の文字列が消えない**。

cycle 20ではsoft ownerを二段にした。通常のspinner/status/progressを上段、
`pinned: true`の処理中composerを最下段へ予約する。これによりLLM/tool出力が続いても
入力欄が消えず、`[処理中・追加入力]`と編集中の文字を常に確認できる。

### 4.3 排他所有 (プロンプト表示中) — ここが不具合 1・2 の直接の修正

`inquirer` を呼ぶ 27 箇所すべてを、 共通ラッパ経由にする。

```ts
// src/cli/prompt-gate.ts
export async function withPrompt<T>(fn: () => Promise<T>): Promise<T> {
  const release = screen.acquireLive({ name: "inquirer" });  // redraw なし = 排他
  try {
    return await fn();
  } finally {
    release();   // キューに溜まった出力をここでフラッシュ
  }
}
```

排他所有の間、 ScreenManager は:

1. `write()` された内容を **キューに積むだけ**で画面に出さない
2. 自身の再描画を止める (`inquirer` が画面を完全に持つ)
3. スピナー / 進捗インジケータを止める (§5)

これで **プロンプト表示中に他の誰も stdout に書かない**状態が保証される。
`inquirer` の「前回描いた行数ぶん戻る」 という前提が崩れなくなり、
不具合 1 (行の複製) と不具合 2 (選択肢が埋もれる) が同時に消える。

#### `inquirer` 自身の描画は素通しさせる (重要)

§3.3 で `process.stdout.write` を差し替えているため、 **`inquirer` 自身の描画も
ScreenManager に流れる**。 排他所有中はそれがキューへ落ちるので、 素直に包むと
**プロンプトが 1 文字も表示されない**。

そこで `inquirer` には「差し替えを受けない生 stdout」 を渡す。
`src/cli/prompt-gate.ts` は以下を一体で提供する:

```ts
// 出力だけを生ハンドルに固定した stdout ビュー (columns / on 等は本物へ委譲)
const promptStreams = { input: process.stdin, output: getRawStdout() };

// 呼び出し側は import 元を差し替えるだけでよい drop-in 置換
export const inquirer = { prompt: inquirerDefault.createPromptModule(promptStreams) };
export const select = gate(rawSelect);   // @inquirer/prompts 系も同様にくるむ
```

呼び出し側は `import inquirer from "inquirer"` を
`import { inquirer, withPrompt } from ".../prompt-gate.js"` に替える。
**生の `inquirer` を import している箇所が 1 つも残っていないこと**を
`grep -rn 'from "inquirer"' src/` で保証する (残っていればそこだけ画面が壊れる)。

### 4.4 なぜ inquirer を置き換えないのか

自前のリストプロンプトを書けば所有権を完全に握れるが、
チェックボックス・パスワード入力・入力補完など既存 27 箇所の要件を
再実装することになり、 **不具合を直す変更としては大きすぎる**。
排他ゲートで包めば原因は断てるので、 まずこちらを取る。

---

## 5. スピナー・進捗インジケータの扱い

スピナーは「一定間隔で勝手に書く」 という、 所有権にとって最も厄介な存在である。

| 対象 | 変更 |
|------|------|
| `progress-indicator.ts` | ライブ領域の**ソフト所有者**にする。 自前描画なので `redraw()` を渡せる |
| `ora` (`utils/spinner.ts`) | 排他所有中は `start()` しても描画しない。 `createSpinner()` のラッパで ScreenManager の状態を見る |

`ora` はライブラリ内部で `stdout.write` するが、 §3.3 の差し替えにより
その出力も ScreenManager 経由になる。 **排他所有中は自動的にキューへ落ちる**ので、
プロンプトを壊すことはなくなる。 ただしキューに大量のスピナーフレームが
溜まっても意味が無いので、 スピナー由来の出力は **キューに積まず捨てる**
(フレームは一過性の表示であり、 記録する価値がない)。

---

## 6. Inline main-bufferモード（既定）

### 6.1 有効になる条件

以下は独立した対応モードとしてAlternate Screenを使わない。

1. 通常のTTY起動（既定）
2. `--no-alt-screen`、または環境変数 `LLLMAGENT_DISABLE_ALTERNATE_SCREEN=1` が設定されている
3. `process.stdout.isTTY` が false (パイプ・リダイレクト・CI)

全画面TUIは`--alt-screen`または`LLLMAGENT_ENABLE_ALTERNATE_SCREEN=1`で明示した場合だけ使う。
明示時に`TERM=dumb`、`TERM`未設定、Windows端末能力の印が無い場合は、黙ってinlineへ
落とさない。原因と対処を示してfail-fastする。raw modeを取得できない場合も同様に停止する。

### 6.2 inline表示での挙動

| 機能 | 挙動 |
|------|------|
| 代替画面 | 使わない。 **ネイティブのスクロールバックに追記**する従来どおりの表示 |
| 出力の集約 | 差し替えた `console.log` は `rawWrite` に素通し |
| ライブ領域の排他制御 | **有効のまま**。 排他所有中のキューイングは動く |
| スクロール操作 (PgUp 等) | 端末自身のスクロールバックに任せる |

**排他制御だけはinline表示でも残す**。 §2.1 のとおり、 不具合 1・2 の修正は
代替画面とは独立しているためである。 「環境変数で戻したらバグも戻る」 では
明示モードによって再発しない。

---

## 7. stdin の一元化 — 不具合 4 の解決

### 7.1 現状の問題

raw mode の設定・解除を、 `InteractiveInput` / `interrupt-watcher` /
`inquirer` / `ora` (対策済み) がそれぞれ行っている。 誰かが `setRawMode(false)`
したまま制御が戻ると、 端末が cooked のまま入力待ちになり、
**Enter を押すまで打鍵がアプリに届かない**。

### 7.2 対策

ライブ領域の取得・解放に **stdin の状態遷移を結び付ける**。

```
acquireLive() →  stdin.resume()  +  setRawMode(true)   (排他所有時は inquirer に委ねる)
release()     →  所有者がいなくなったら raw mode を解除
```

さらに `acquireLive` の直後に **溜まっている入力を読み捨てない**
(捨てるとユーザーが先に打った文字が消える) 代わりに、
所有者に引き渡してから描画する。

### 7.3 raw mode の監視

現状 `interactive-input.ts` に `rawModeWatchdog` (定期的に raw mode を
確認して戻す) があるが、 これは**症状に対する当て木**である。
所有権が一元化されれば不要になるが、 いきなり外すと退行が怖いので
**1 リリースの間は残す**。 ウォッチドッグが実際に発火したらログに残し、
発火しなくなったことを確認してから外す。

---

## 8. 終了処理

代替画面を使うと、 **異常終了で画面が戻らない**のが最大の運用リスクである。
以下すべてで `stop()` を確実に呼ぶ。

| 経路 | 対応 |
|------|------|
| 正常終了 (`/quit`) | 明示的に `stop()` |
| `process.on("exit")` | 同期的に `\x1b[?1049l` を書く |
| `SIGINT` / `SIGTERM` | ハンドラで `stop()` → 既定動作 |
| 未捕捉例外 / unhandledRejection | `stop()` してからスタックを出す (**代替画面の中でスタックを出すと消える**) |

`stop()` では代替画面を抜ける前に、 **スクロールバックの内容を通常画面へ
書き戻す**。 これをしないと「セッション終了後にログが何も残らない」 という、
現行方式にはない退行が起きる。 直近 `maxLines` 行を素通しで出力する。

---

## 9. 変更ファイル一覧

| ファイル | 変更 |
|----------|------|
| `src/cli/screen-manager.ts` | **新規**。 §3 の本体 |
| `src/cli/prompt-gate.ts` | **新規**。 `withPrompt()` (§4.3) |
| `src/cli/output-router.ts` | **新規**。 `console` / `stdout.write` の差し替え (§3.3) |
| `src/index.ts` | 起動直後に router を仕込み `screen.start()`。 終了処理 (§8) |
| `src/cli/interactive-input.ts` | ソフト所有者として `acquireLive` (§4.2)。描画は `writeLive` 経由。mouse report断片は入力文字へ混ぜない |
| `src/cli/terminal-input.ts` | PageUp/PageDown・SGR/X10 mouse reportの復元とreadline入力filter |
| `src/cli/progress-indicator.ts` | ソフト所有者化 |
| `src/utils/spinner.ts` | 排他所有中は描かない。 代替画面では出力先を ScreenManager へ |
| `src/utils/display-width.ts` | **新規**。 幅計算の共通化 (§11) |
| `src/utils/crash-handler.ts` | 未捕捉例外でスタックを出す前に代替画面から抜ける (§8) |
| `src/tools/definitions/ask-user.ts` | `withPrompt()` で包む |
| `src/security/permission-manager.ts` | 同上 |
| `src/agent/plan-mode.ts` / `goal-promotion.ts` / `agent-loop.ts` | 同上 |
| `src/config/setup-wizard.ts` / `src/cli/repl.ts` | 同上 |
| `tests/cli/screen-manager.test.ts` | **新規**。 行分割 / 追記 / キューイング / 所有権 |

---

## 10. 段階的実装

各段階で単体で意味があり、 途中で止めても壊れない。

| 段階 | 内容 | これだけで得られるもの |
|------|------|----------------------|
| **1** ✅ | `output-router` + `prompt-gate` + 排他キューイング (代替画面なし) | **不具合 1・2 が直る** |
| **2** ✅ | `ScreenManager` + 代替画面 + スクロールバック描画 | TUI 化。 環境変数で戻せる |
| **3** ✅ | ソフト所有 (`InteractiveInput` / 進捗インジケータ) | 入力中の割り込み出力が壊さない |
| **4** ✅ | stdin 一元化 | **不具合 4 が直る** |

段階 1 を先に置くのは、 **不具合の修正を代替画面の完成に人質に取らない**ため。

### 10.1 実装で設計から足したもの (段階 2〜4)

いずれも本文の意図を満たすために必要になった追加であり、 方針の変更ではない。

| 追加 | 場所 | 理由 |
|------|------|------|
| `LiveOwner.clear?()` | §3.2 の API に 1 つ追加 | classic streamでは全画面再描画が無いので、 割り込み出力を差し込む前に所有者自身に描画を消させる必要がある。 これが無いと §4.2 の「入力中の文字列が消えない」 が代替画面でしか成立しない |
| `ScreenManager.writeLive()` | 同上 | ライブ領域の所有者の描画をスクロールバックに記録しないための入口。 所有者が `process.stdout.write` を使うと、 自分の描画が履歴に混ざり、 代替画面では再描画が自分を呼び返して無限再帰する |
| `ScreenManager.refreshLive()` / `scrollUp` / `scrollDown` / `scrollToBottom` | 同上 | ライブ領域の高さ変化の通知 (§3.5 の再確保) と PgUp/PgDn (§3.4) |
| スピナーの「状態行」 | §5 の補足 | `ora` の既定の出力先は **stderr** であり OutputRouter を素通りする。 代替画面ではそのままだと画面が壊れ、 捨てると「考え中...」 が消える。 代替画面のときだけ出力先を ScreenManager に向け、 最新フレームをライブ領域の 1 行として描く。 素通しモードでは既定の stderr のまま (パイプ実行に ANSI を混ぜないため) |
| 確定した入力のスクロールバックへの転記 | `interactive-input.ts` | 代替画面では入力欄はライブ領域にしか無く、 確定しても履歴に残らない。 「何を打ったか」 が消えるのは現行方式に無い退行なので、 確定時に 1 度だけ書き出す |
| 幅計算の共通化 (`src/utils/display-width.ts`) | §11 の対策の実体 | `interactive-input.ts` にあった実装をそのまま移設し、 ScreenManager と共用する。 新規に書き直していない |

---

## 11. リスク

| リスク | 対策 |
|--------|------|
| 異常終了で端末が代替画面に取り残される | §8 の全経路で `stop()`。 加えて `reset` 相当の案内を README に記載 |
| セッション終了後にログが残らない (現行からの退行) | `stop()` でスクロールバックを通常画面へ書き戻す (§8) |
| `console.log` 差し替えが外部ライブラリと衝突する | 差し替えは 1 箇所・起動直後のみ。 元の関数を保持し `stop()` で復元 |
| 全画面再描画が遅い | 16ms のフレーム集約 (§3.5)。 実測で問題が出たら差分描画は**入れない**で描画頻度を下げる (差分描画は不具合 1 の再来を招く) |
| Windows conhost で ANSI が効かない | 全画面TUIの明示時に`TERM`/`WT_SESSION`/ConPTYの印が無ければ原因と`--no-alt-screen`を示してfail-fastする。能力不明を黙って別表示へ落とさない |
| 日本語入力が右端到達後に1文字ごと改行される | 最終列はDECAWMの折返し待ちを生むため常に1桁空ける。`Intl.Segmenter`で結合文字・ZWJ絵文字を分割せず、端末soft wrapへ依存しない |
| パイプモードでの検証しかできず TTY 実機の退行に気付けない | 段階ごとに手動 TTY 確認を必須とする。 `CLAUDE.md` の「対話品質はパイプモードで検証できない」 に従う |

---

## 12. 検証項目 (TTY 実機で確認すべきこと)

パイプモードでは確認できないため、 手動確認のチェックリストとして残す。

1. 既定起動 → main bufferへ追記され、通常ドラッグ選択と端末ホイールscrollbackを同時に使える
2. `--alt-screen`起動 → 代替バッファへ切替。終了 → 元の画面に戻り、ログが残っている
3. `ask_user` の選択肢が **1 行目の複製なしに**表示される (不具合 1)
4. LLM 応答のストリーミング中に `ask_user` が出ても選択肢が埋もれない (不具合 2)
5. 応答完了直後にすぐタイプできる (Enter を先に押す必要がない) (不具合 4)
6. 入力中にバックグラウンド通知が来ても、 入力中の文字列が消えない
7. inlineでは端末ホイール、全画面TUIではPgUp/PgDnとmouse ON時のホイールで履歴を遡れる。遡り中に新出力が来ても視点が飛ばず、mouse reportが入力文字へ化けない
8. Ctrl+C 2 回・未捕捉例外で終了しても端末が壊れない
9. 日本語・結合文字・ZWJ絵文字混じりの入力が右端へ達しても、1文字ごとの余計な改行や文字分割が起きない
10. LLM 思考中のスピナー (「考え中...」) が画面下端に 1 行で出て、 応答が始まると消える

### 12.1 段階 2〜4 実装時点の確認状況 (2026-08-13)

| # | 状況 |
|---|------|
| 1 | **未確認** (TTY 実機のみ)。 代替画面への入退場と書き戻しの ANSI 列は自動テストで確認済み |
| 2 | 確認済み (パイプモードで起動→終了、 exit 0) |
| 3・4 | **未確認** (TTY 実機のみ)。 段階 1 の排他キューイングは自動テストで確認済み |
| 5 | **未確認** (TTY 実機のみ) |
| 6 | **未確認** (TTY 実機のみ)。 所有権・再描画の呼び出し順は自動テストで確認済み |
| 7 | **未確認** (TTY 実機のみ)。 `viewOffset` の算術と案内表示は自動テストで確認済み |
| 8 | 未捕捉例外は擬似 TTY で確認済み (代替画面を抜けてから stderr にスタック)。 Ctrl+C 2 回は**未確認** |
| 9 | **未確認** (TTY 実機のみ)。 全角の桁計算と切り詰めは自動テストで確認済み |
| 10 | **未確認** (TTY 実機のみ)。 stderr が TTY でないと `ora` が非対話表示へ切り替わるため、 擬似 TTY では検証できない |

### 12.2 stdin 所有権の一元化 (`docs/stdin-ownership.md`) 実装時点 (2026-08-14)

セッション単位の raw 保持に変更した。 パイプモードの E2E スモーク 3 件と
ScreenManager の単体テストは通っているが、 以下は **TTY 実機でしか確認できない**。

| # | 確認すること | 状況 |
|---|-------------|------|
| 5 | 応答完了直後にすぐタイプできる (担い手の切り替わりで cooked に落ちない) | **未確認**。 raw の保持・再確認は自動テストで確認済み |
| 8 | Ctrl+C が **どの局面でも**効く (入力待ち / エージェント実行中 / プロンプト中 / 誰もいない間) | **未確認**。 「誰もいない間」 の `\x03` 保険と、 担い手がいる間の非発火は自動テストで確認済み |
| — | `inquirer` プロンプトが閉じた直後に上下カーソルが即反応する | **未確認**。 `release()` での raw 再確認は自動テストで確認済み |
| — | `rawModeWatchdog` / interrupt-watcher のハートビートが発火しなくなったか (ops ログの WARN) | **未確認**。 発火しないことを実運用で確認してから当て木を外す (§4 の順序) |
