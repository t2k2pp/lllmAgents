# 中断手段と進捗表示の改善 設計書

作成日: 2026-05-23
ステータス: 設計レビュー中

## 背景

直近セッション (`30de7164` / `f622ac6f` / `c0d66b13` / `23f9730a` 他) の jsonl 振り返りで、ユーザー操作体験に関する以下の問題が観測された。

| ID | 観察 | jsonl 根拠 |
|---|---|---|
| O1 | アプリが「固まった」と感じて再起動 → resume した | `30de7164` 冒頭「固まってたから再起動してresumeしたよ」 |
| O2 | 権限ダイアログで許可した後に反応がなくなる感がある | ユーザー証言 |
| O3 | 並列 tool_use (3〜7個) で連続ダイアログが出る | `23f9730a` で 7 並列 TaskCreate などを確認 |
| O4 | 中断手段が Ctrl+C しかなく、2回押すとプロセスが落ちる | `repl.ts:128-148` |

ソース精読で判明した根本要因:

1. **エージェント処理中は stdin の raw mode が外れている** ─ `interactive-input.ts:485-487` の `cleanup()` で `setRawMode(false)`。確定後の処理時間中、ユーザーのキー入力はバッファに溜まるだけで Enter まで何も反応せず、ESC や他キーで割り込めない。
2. **bash 実行の進捗が見えない** ─ `bash.ts:56` の `streamOutputEnabled = false` がデフォルト。長時間コマンドや `mcp__lllmagents__task` (subagent) で出力が一切流れず、無反応に見える。
3. **中断経路が SIGINT のみ** ─ `repl.ts:128-148` で Ctrl+C × 1 = ソフト中断、× 2 = プロセス終了。Claude Code の「ESC で止めても REPL は生きている」ような軽量中断が無い。

## 目標

| # | 目標 | 受け入れ基準 |
|---|---|---|
| G1 | エージェント処理中に **ESC キー** で現在の処理を中断できる | TTY で ESC を1回押すと、進行中の bash プロセスが kill され、エージェントが abort し、プロンプトに復帰する。アプリは終了しない |
| G2 | 長時間のツール実行中、**経過時間とコマンド要約** がリアルタイム表示される | bash 実行が 1 秒を超えたら spinner と elapsed が表示される。5 秒を超えたら「中断は ESC / Ctrl+C」案内が出る |
| G3 | Ctrl+C は **緊急脱出専用** として温存 (既存挙動を変えない) | × 1 ソフト中断、× 2 プロセス終了 (既存) |

## 非目標

- 並列 tool_use 自体の抑制 (system prompt 改修は別タスク扱い)
- ストリーミング出力 (`streamOutputEnabled = true` 相当) のデフォルト ON 化
- 非 TTY (パイプモード) での ESC 中断 ─ パイプには ESC キー概念がない
- inquirer ダイアログ表示中の挙動変更 ─ 既存の queue 直列化を維持

## 設計

### S1. エージェント処理中の raw mode 維持

`src/cli/repl.ts` の processInput 入り口で、stdin を「中断監視用 raw mode」に切り替える。新規モジュール `src/cli/interrupt-watcher.ts` を作成して責務を分離する。

```
[idle] → user enter → [busy: interrupt-watcher active] → done → [idle]
                                ↑ ESC キーで中断
```

#### interrupt-watcher.ts インターフェース
```ts
export interface InterruptWatcher {
  /** 監視開始。ESC 受信時に onInterrupt が呼ばれる */
  start(onInterrupt: () => void): void;
  /** 監視停止。raw mode は呼び出し元責任で復元 */
  stop(): void;
}
```

実装要件:
- `process.stdin.isTTY` でない場合は no-op (パイプモード)
- start 時に `stdin.setRawMode(true) + stdin.resume()` + 'data' リスナー
- 0x1b (ESC) を受信したら `onInterrupt()` を **1回だけ** 呼んで自動 stop
- それ以外のキーは受信して捨てる (バッファに溜めない)
- start を二重に呼ばれた場合は前のリスナーを掃除する

repl.ts 側の連携 (`processInput` 内):
```ts
let interrupted = false;
this.interruptWatcher.start(() => {
  interrupted = true;
  console.log(chalk.yellow("\n  (ESC) 処理を中断中..."));
  this.agent.abort();
  bashTool.killRunningProcess();
});
try {
  await this.agent.processInput(...);
} finally {
  this.interruptWatcher.stop();
}
if (interrupted) {
  console.log(chalk.dim("  プロンプトに戻ります"));
}
```

#### 既知のリスク
- inquirer ダイアログ表示中は inquirer が stdin を奪う。inquirer の `prompt` 呼び出しが終わるまで interrupt-watcher の data リスナーには届かない。これは**意図通り** (ダイアログ操作中は ESC = メニューキャンセル相当が inquirer 側で動く)
- ターミナルが ANSI シーケンス (例: 矢印キー `\x1b[A`) を送る場合、先頭バイトが ESC。これと区別するため、1バイトのみで ESC 終端、または ESC 後 50ms 以内に追加バイトが来なければ中断確定、というデバウンスを入れる
- agent 処理が極短時間で終わる場合、start → stop が一瞬で走る。raw mode の付け外しは TTY 状態を一瞬乱すが、出力には影響しない

### S2. ツール実行進捗インジケータ

`src/cli/progress-indicator.ts` を新規作成。bash と subagent (mcp__lllmagents__task) の実行を共通フックで監視する。

#### progress-indicator.ts インターフェース
```ts
export interface ProgressIndicator {
  /** ツール実行開始 */
  begin(toolName: string, summary: string): void;
  /** ツール実行完了 */
  end(): void;
}
```

実装要件:
- begin 後 1 秒経過したら spinner (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` の braille アニメ) と `[toolName] summary... (Xs)` を表示
- 5 秒経過で `  (ESC で中断 / Ctrl+C で強制)` を1度だけ追記
- end で1行クリア + 改行
- 非 TTY では何も描画しない (jsonl にゴミを残さない)

`tool-executor.ts` で begin/end を挟むのが自然:
```ts
this.progress.begin(toolName, formatSummary(toolName, params));
try {
  return await handler.execute(params);
} finally {
  this.progress.end();
}
```

`formatSummary` は `permission-manager.ts:561` の `formatToolSummary` と同じロジックを共有 (リファクタしてエクスポート)。

### S3. 既存中断経路 (Ctrl+C) の温存

変更しない。既存テストが残っている場合はそのままパスすべき。

ESC と Ctrl+C の役割:

| キー | 状態 | 動作 |
|---|---|---|
| ESC | エージェント実行中 | ソフト中断 (新規, S1) |
| ESC | 入力中 | メニュー閉じ (既存) |
| ESC | アイドル | 無視 (新規) |
| Ctrl+C × 1 | 実行中 | ソフト中断 (既存) |
| Ctrl+C × 2 | 実行中 | プロセス終了 (既存) |
| Ctrl+C × 1 | アイドル | 案内表示 (既存) |
| Ctrl+C × 2 | アイドル | プロセス終了 (既存) |

## 影響範囲

| ファイル | 変更内容 |
|---|---|
| `src/cli/interrupt-watcher.ts` | 新規作成 |
| `src/cli/progress-indicator.ts` | 新規作成 |
| `src/cli/repl.ts` | processInput 周辺で watcher start/stop 呼び出し |
| `src/tools/tool-executor.ts` | progress begin/end フック追加 |
| `src/security/permission-manager.ts` | `formatToolSummary` を export (progress と共用) |
| `docs/internal_design.md` | §中断と進捗 を追記 |

`bash.ts` は変更しない (`streamOutputEnabled` の既存仕様を温存)。

## 後方互換性

- 非 TTY (パイプモード) 動作は完全に変わらない
- 既存の SIGINT 経路は維持
- API シグネチャ変更なし → プロバイダや mcp client への影響なし

## テスト計画

### 自動テスト
- `interrupt-watcher.test.ts`: TTY シミュレートで ESC 受信 → コールバック発火を検証
- `progress-indicator.test.ts`: タイマー進行で 1s/5s 境界の出力切替を検証

### 手動 TTY テスト (CLAUDE.md ルール「対話品質はパイプモードでは検証できない」に従う)
1. `npm run start` で起動 → 適当なプロンプトを投げる
2. 長時間 bash (`sleep 10`) を実行 → ESC で中断、プロンプトに戻ることを確認
3. ESC 連打してもアプリが落ちないことを確認
4. Ctrl+C × 1 がソフト中断、× 2 がプロセス終了で動作することを確認 (既存仕様)
5. 進捗表示が 1 秒境界で出始め、5 秒で案内が追加されることを確認
6. 短時間で終わるコマンド (`ls`) では進捗が表示されないこと
7. inquirer 権限ダイアログ表示中に ESC を押した時、ダイアログがキャンセルされる動作 (既存) が壊れていないこと

## 実装順序

1. interrupt-watcher.ts 単体 + テスト
2. repl.ts への組み込み + 手動 TTY 確認 (ここで G1 達成)
3. progress-indicator.ts 単体 + テスト
4. tool-executor.ts への組み込み + 手動 TTY 確認 (ここで G2 達成)
5. ドキュメント更新

## 未確定事項 / 後続課題

- 並列 tool_use の抑制 (system prompt or agent-loop での直列化) → 別設計書
- subagent (mcp__lllmagents__task) の途中経過をストリームする仕組み → 別設計書
- inquirer の代わりに自前 raw mode ダイアログを使うか → 中断統合のため将来検討

## 追補 S4. 中断の HTTP 層への伝播 (実装済 2026-06-12)

### 観測された実害

`2026-06-12T13-50-48` セッションで、Esc 中断後に再送信したリクエストの応答が **557 秒** かかる事象が発生
(通常 20〜90 秒)。ユーザー目線では「入力しても無反応 → Esc → 再送信 → さらに無反応」の悪循環。

### 根本原因

`agent.abort()` はフラグを立てるだけで、`abortableIterator` は **イテレータの消費をやめるだけ** だった:

1. `gen.return()` を呼ばないため provider generator の finally が走らない
2. finally も `reader.releaseLock()` のみで、ストリームを cancel しない
3. → HTTP 接続が開いたままになり、llama.cpp サーバは中断済み生成を完走するまで占有される
4. → 再送信したリクエストはサーバ側キューで待たされ「固まった」ように見える (シングルスロット直列処理)

### 修正 (3 層で伝播)

| 層 | ファイル | 変更 |
|---|---|---|
| agent-loop | `src/agent/agent-loop.ts` | LLM 呼び出しごとに `AbortController` を生成し `ChatParams.signal` で渡す。`abort()` が `controller.abort()` も呼ぶ。`abortableIterator` は中断時に `gen.return()` で generator の finally を走らせる |
| provider | `src/providers/base-provider.ts` / `openai-compat.ts` | `ChatParams.signal?: AbortSignal` 追加。`httpPostStream` へ引き渡し。finally は `releaseLock` → `reader.cancel()` に変更。ユーザー中断時 (`signal.aborted`) はエラー chunk を出さず静かに終了 |
| HTTP | `src/utils/http-client.ts` | `httpPostStream` に `externalSignal` 引数を追加し内部 controller に連動。`wrapWithIdleTimeout` の cancel で `abortController.abort()` も実行し undici に確実に接続を切断させる |

llama.cpp / vLLM はクライアント切断を検知すると生成スロットを解放するため、Esc の瞬間にサーバ側の生成も止まる。

注: `signal` 未対応の provider (gemini / azure-gpt 等の独自実装) は従来挙動のまま (後続課題)。
OpenAI 互換系 (llamacpp / vllm / lmstudio / ollama の openai-compat 経由) は本修正でカバーされる。

関連: 中断された span の履歴可視化 (中断マーカー) と表示済みテキストの保全は
`docs/ephemeral-context-design.md` §8 を参照。
