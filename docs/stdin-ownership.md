# stdin 所有権の一元化 (不具合 4 の残存分)

> **ステータス**: 2026-08-14 設計 / 実装
> **前提**: `docs/tui-alternate-screen.md` 段階 1〜4 が実装済み (コミット 3f6f509 / 066b2be)
> **関連**: `docs/repl-io-robustness.md` / `docs/interrupt-and-progress-design.md`

---

## 1. 残っている症状

> テキスト入力できそうな状態、 上下カーソルが選べそうな状態で、
> 実際は一度改行キーを押さないと操作を受け付けない時がある。

`docs/tui-alternate-screen.md` 段階 4 で raw mode の取得・解放を
ライブ領域の所有権に結び付けたが、 **所有者と所有者の「あいだ」 が塞がっていない**。

---

## 2. 原因: 誰も所有していない一瞬に cooked へ落ちる

端末が cooked (行バッファ) モードのとき、 打鍵は **OS の行バッファに溜まり、
Enter を押すまでアプリに届かない**。 これが症状そのものである。

現状、 raw mode の担い手は 3 人いて、 **それぞれが自分の仕事の前後で付け外し**する。

| 担い手 | raw にする時 | cooked に戻す時 |
|--------|-------------|----------------|
| `InteractiveInput` (入力待ち) | `acquireLive()` | `release()` で所有者が 0 になった時 |
| `InterruptWatcher` (エージェント実行中) | `start()` | `stop()` (元が raw でなければ) |
| `inquirer` (プロンプト) | 内部で自前に設定 | 内部で自前に解除 |

問題が起きるのは **担い手の切り替わり**である。

```
エージェント応答が終わる
  → InterruptWatcher.stop()      … ここで cooked に落ちる
  → 出力のフラッシュ・表示処理
  → ユーザーが「もう入力できる」 と判断して打ち始める   ★ ここが cooked
  → InteractiveInput.question() → acquireLive() → raw に戻す
```

★ の間に打った文字は OS の行バッファに入っており、 **Enter を押すまで出てこない**。
ユーザーから見ると「入力できそうなのに反応しない。 Enter を押すと動く」 になる。

`inquirer` のプロンプト (上下カーソルで選ぶ画面) でも同じことが起きる。
プロンプトが描かれるより先にユーザーが ↓ を押していると、 その ↓ は cooked
バッファ行きで、 Enter まで届かない。

### 2.1 なぜ per-owner の付け外しが間違いなのか

raw mode は **端末というプロセス全体で 1 つしかない資源**である。
それを「使う人が来たら on、 帰ったら off」 で回すと、 誰もいない一瞬が必ずできる。
実際の TUI アプリは **セッションの間ずっと raw を保持**し、
終了時と子プロセスに端末を渡す時だけ戻す。

`interactive-input.ts` の `rawModeWatchdog` と `interrupt-watcher.ts` の
自己修復ハートビートは、 どちらもこの穴を **定期的に埋め直している当て木**である。
穴そのものを塞げば両方とも要らなくなる。

---

## 3. 設計: セッション単位の raw 保持

### 3.1 ScreenManager が raw を持ち続ける

```
start()      … TTY なら raw mode を取得し、以後 **保持し続ける**
acquireLive()… 保持を再確認する (誰かが外していたら戻す)。所有者の種別を問わない
release()    … 何もしない (cooked に戻さない)
stop()       … ここで初めて cooked に戻す
```

**排他所有者 (inquirer) でも raw を確認する**点が現状からの変更である。
現在の実装は `if (!owner.redraw) return;` で inquirer をスキップしている。
inquirer は自分で raw にするので「任せてよい」 という判断だが、
**問題は inquirer が raw にする前の一瞬**なので、 スキップしてはいけない。

### 3.2 他の担い手は「解除しない」 に変える

| 担い手 | 変更 |
|--------|------|
| `InterruptWatcher.stop()` | ScreenManager が raw を保持している間は `setRawMode(false)` しない |
| `InteractiveInput` の cleanup | 同上 |
| `inquirer` | ライブラリなので触れない。 **release 後に ScreenManager が raw を確認し直す** |

`inquirer` は終了時に自前で cooked へ戻す。 これは外部ライブラリなので防げない。
`withPrompt()` の finally (= `release()`) で **必ず raw を再確認**することで塞ぐ。

### 3.3 Ctrl+C の保険

raw mode では Ctrl+C が SIGINT にならず、 `\x03` というバイトとして届く。
これを誰も読んでいない一瞬があると **Ctrl+C が効かなくなる**。
今までは cooked に落ちる瞬間があったので偶然救われていたが、
raw を保持し続けるなら明示的に受ける必要がある。

ScreenManager が **最下位の `\x03` 監視**を常設する。

- 他の所有者 (`InteractiveInput` / `InterruptWatcher` / `inquirer`) がいる間は何もしない
  (それぞれが自分で Ctrl+C を処理する)
- **誰もいない間に `\x03` が来たら `process.emit("SIGINT")` を発火**する

ESC単独中断は50ms debounceでescape sequenceと区別する。`Shift+Tab`の`ESC [ Z`や
矢印keyがstdin chunk境界で分割されても、debounce中に後続byteが届けば単独ESC予約を解除する。

「誰もいない間」 だけ働く保険なので、 既存の Ctrl+C 処理と競合しない。

#### `InterruptWatcher` をどう数えるか

`InteractiveInput` と `inquirer` は `acquireLive()` を通るので `owners` で数えられるが、
**`InterruptWatcher` はライブ領域を取らずに生 stdin を直接読む**ため数に入らない。
かといって screen-manager から interrupt-watcher を import すると循環参照になる。

そこで ScreenManager 側に汎用の「生 stdin の担い手」 カウンタを置き、
`registerStdinConsumer(name)` で登録させる。 発火条件は次の 3 つすべてである。

```
stdinRawHeld && !stdinSuspended     // raw を保持中
owners.length === 0                 // ライブ領域の所有者がいない
stdinConsumers === 0                // 生 stdin の担い手がいない
```

数え漏らすと **Ctrl+C が二重発火**し、 repl の「2 回で終了」 判定が
1 回の Ctrl+C で成立してしまう。 保険が本体を壊してはいけない。

### 3.4 子プロセスへの影響はない

`bash` ツールは `stdio: ["ignore", ...]` で **stdin を子に渡していない** (3 箇所とも)。
したがって raw を保持し続けても子プロセスの入力を壊さない。
将来 stdin を継承する実行経路を足すときは、 その前後で
`screen.suspendStdin()` / `resumeStdin()` を挟むこと。

### 3.5 型ずれ入力 (type-ahead) の扱い

raw を保持し続けるので、 応答表示中に打った文字は **cooked バッファに溜まらず、
そのままアプリに届く**。cycle 20以降はraw byteを裏で集めるだけでなく、通常時と同じ
`InteractiveInput`を`[処理中・追加入力]`の固定composerとして表示する。編集中の本文、
折返し、`Shift+Enter`、`Shift+Tab`のmode循環を目視できる。

通常メッセージはforeground steering FIFOが受け、次のLLM reply／tool完了境界で
同じturnへ渡す。slash commandはturn後FIFOが受け、`/run`の状態操作は即時に処理する。
run終了時はAbortSignalでcomposerを解放し、未確定の編集中bufferを別turnとして誤送信しない。

つまりこの変更は「打鍵が消える / 遅れて出る」 のを直すだけでなく、
**打鍵が正しく先読みキューに入るようになる**。 黙って捨てられる経路が減る。

---

## 4. ウォッチドッグの扱い

`interactive-input.ts` の `rawModeWatchdog` と `interrupt-watcher.ts` の
ハートビートは **残す**。 いきなり外すと、 想定漏れの経路で穴が開いたときに
無防備になる。

ただし **発火したら ops ログに WARN を出す** (段階 4 で実装済み)。
発火しなくなったことを実運用で確認してから外す、 という順序を守る。
「当て木を外すのは、 当て木が不要だと実データで示せてから」。

---

## 5. 変更ファイル一覧

| ファイル | 変更 |
|----------|------|
| `src/cli/screen-manager.ts` | セッション単位の raw 保持、 全所有者での再確認、 `release()` 後の再確認、 `\x03` 保険、 `suspendStdin()`/`resumeStdin()` |
| `src/cli/interrupt-watcher.ts` | ScreenManager が保持中なら `stop()` で cooked に戻さない |
| `src/cli/interactive-input.ts` | cleanup で cooked に戻さない。処理中composerの外部abortと`Shift+Tab`再描画 |
| `src/cli/repl.ts` | 処理中固定composerからsteering/commandへ振り分け |
| `tests/cli/screen-manager.test.ts` | raw 保持 / 解放しない / `\x03` 保険の単体テスト |

---

## 6. リスク

| リスク | 対策 |
|--------|------|
| Ctrl+C が効かない瞬間ができる | §3.3 の最下位 `\x03` 監視。 誰も所有していない時だけ働く |
| 異常終了で端末が raw のまま残る | `stop()` は `docs/tui-alternate-screen.md` §8 の全経路 (exit / SIGINT / SIGTERM / 未捕捉例外) で呼ばれる。 そこで cooked に戻す |
| 子プロセスの入力を奪う | 現状 stdin を継承する経路は無い (§3.4)。 将来のために suspend/resume を用意する |
| 非 TTY で raw 操作を試みて落ちる | `isTTY` を必ず確認。 try/catch で囲む (既存踏襲) |
| TTY 実機でしか検証できない | パイプモードの E2E は通ることを必須とし、 実機確認項目は `docs/tui-alternate-screen.md` §12 に集約する |
