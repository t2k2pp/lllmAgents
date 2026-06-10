# REPL I/O 堅牢化 設計書 (raw mode 自己修復)

作成日: 2026-06-10
ステータス: 実装済み
関連: `docs/interrupt-and-progress-design.md` (ESC 中断 / 進捗表示の元設計)

## 背景 (ユーザー報告)

| ID | 症状 |
|---|---|
| R1 | プロンプトが出て入力できそうなのに、一度 Enter (改行) を押すまで文字入力が反映されない |
| R2 | エージェント処理中の Ctrl+C が効かない (何度押しても中断されない) ことがある |
| R3 | ESC による処理中断が効かないことがある (特に権限確認ダイアログの後) |

## 根本原因

stdin の raw mode の所有者が複数いて、状態がずれる経路が 3 つあった。

### C1. libuv の setRawMode キャッシュずれ → R1

libuv は `uv_tty_set_mode` で要求モードが内部キャッシュと一致すると **何もしない**。
子プロセスや inquirer が実コンソールのモードを変えた後だと「Node は raw のつもりだが
実コンソールは cooked」という不整合が起き、`setRawMode(true)` を呼んでも no-op に
なって復旧できない。cooked のままだと端末が行バッファリングするため、Enter を押す
まで keypress が一切届かない = R1 の症状。

### C2. raw mode 中は端末が SIGINT を生成しない → R2

エージェント処理中は `interrupt-watcher` が ESC 監視のため raw mode を保持する。
raw mode では ISIG (Unix) / ENABLE_PROCESSED_INPUT (Windows) が無効になり、
Ctrl+C は SIGINT ではなく **0x03 バイト** として stdin に届く。従来の watcher は
ESC しか見ておらず、interactive-input の keypress ハンドラも処理中は外れているため、
Ctrl+C がどこにも届かず完全に無視されていた。

### C3. inquirer の後始末が raw mode を外し stdin を pause する → R3

権限確認 (`permission-manager`) と ask_user は inquirer を使う。inquirer はプロンプトを
閉じる際に `setRawMode(false)` + `stdin.pause()` を行う。watcher は動作中のままなので、
以降の ESC / Ctrl+C バイトは Enter まで届かない (cooked + paused)。
権限ダイアログを 1 回でも通ると、残りのエージェント実行中の中断手段が死ぬ。

## 対策 (自己修復アプローチ)

「raw mode を壊す経路を全部塞ぐ」のは不可能 (外部プロセス・ライブラリ内部・将来の
追加コード) なので、**所有者が定期的に自分の期待状態へ復旧する** 方針を取る。

### S1. interactive-input: 強制再適用 + ウォッチドッグ (`src/cli/interactive-input.ts`)

- `question()` 開始時に `setRawMode(false)` → `setRawMode(true)` のトグルで強制再適用。
  libuv キャッシュと実モードを確実に同期させる (C1 対策)。
- 入力待ち中は 500ms 間隔のウォッチドッグで `!isRaw` / `isPaused()` を検査して自動復旧。
  バックグラウンド処理 (Discord/Slack/ループ経由の processInput) が裏で raw mode を
  外すケースに対応。`cleanup()` で必ず clearInterval。
- おまけ: メニュー非表示時の ESC は入力バッファ破棄 (Claude Code と同じ操作感)。

### S2. interrupt-watcher: Ctrl+C 合成 + ハートビート (`src/cli/interrupt-watcher.ts`)

- data リスナーで 0x03 を検知したら `process.emit("SIGINT")` を呼び、repl.ts の既存
  SIGINT ハンドラ (1回=ソフト中断 / 2回=プロセス終了) に合流させる (C2 対策)。
  raw mode が外れている場合は端末が本物の SIGINT を生成し 0x03 は届かないため、
  二重発火しない。
- 監視中は 500ms 間隔のハートビートで raw mode 再適用 + `stdin.resume()` (C3 対策)。
  inquirer プロンプト表示中は inquirer 自身が raw mode を立てるため干渉しない。
  ハートビートは `unref()` してプロセス終了を妨げない。

## 役割分担 (raw mode の所有者)

| 状態 | 所有者 | 復旧責務 |
|---|---|---|
| プロンプト入力待ち | interactive-input | question() 開始時トグル + 500ms ウォッチドッグ |
| エージェント実行中 | interrupt-watcher | 500ms ハートビート |
| inquirer ダイアログ表示中 | inquirer | (干渉しない — raw を立てるのは inquirer 自身) |
| 非 TTY (パイプ) | なし | raw mode 概念なし、全機構 no-op |

## 影響範囲

| ファイル | 変更内容 |
|---|---|
| `src/cli/interactive-input.ts` | raw mode 強制再適用、ウォッチドッグ、ESC で入力クリア |
| `src/cli/interrupt-watcher.ts` | 0x03 → SIGINT 合成、ハートビート自己修復 |
| `src/cli/repl.ts` | コメント更新のみ (SIGINT 経路の説明) |
| `tests/cli/interrupt-watcher.test.ts` | 新規 (フェイク stdin で 5 ケース) |

## テスト

### 自動テスト
`tests/cli/interrupt-watcher.test.ts` — ESC デバウンス発火 / シーケンス除外 /
0x03 → SIGINT 合成 / ハートビート復旧 / stop 後の停止。

### 手動 TTY テスト (パイプモードでは検証不可)
1. `npm run start` → 長い処理を投げて Ctrl+C × 1 → 「処理を中断中...」が出てプロンプト復帰
2. 同上で ESC → 中断してプロンプト復帰
3. 権限確認ダイアログを「許可 (今回のみ)」で通した**後**に ESC / Ctrl+C → 中断が効く
4. 処理完了後のプロンプトで、Enter を押さなくても1文字目から入力が反映される
5. 入力途中で ESC → 入力がクリアされる (メニュー表示中はメニューだけ閉じる)
