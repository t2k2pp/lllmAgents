# Loop Feature 設計書

## 概要

`/loop` コマンドは、プロンプトまたはスラッシュコマンドを一定間隔で繰り返し実行する機能。
同じsession-scoped managerをモデル向け `schedule_create` / `schedule_list` / `schedule_delete` toolsからも操作できる。
Claude Code の `/loop` と `CronCreate/List/Delete` に相当する、ユーザー操作面とモデル操作面を提供する。

## ユースケース

- PR の状態を5分ごとに確認する
- デプロイログを30分ごとにチェックする
- 定期的なステータスレポートを生成する

## コマンド仕様

```
/loop [interval] <prompt>   新しいループを開始する
/loop status                アクティブなループ一覧 + 停止 picker (checkbox 複数選択)
```

### 旧コマンドとの互換 (dispatcher 経由でのみ動作、 補完候補からは外れる)

```
/loop list                  アクティブなループ一覧のみ表示 (picker は出ない)
/loop stop <id>             指定 ID のループを停止 (スクリプト用)
/loop stop all              全ループを停止 (スクリプト用)
```

`/loop status` は一覧表示の直後に停止対象を checkbox で複数選択できるため、 通常の運用ではこちらが推奨。 `/loop list` と `/loop stop` は旧仕様との互換のため残されている。

### 間隔指定フォーマット

| 表記例 | 意味         |
|--------|--------------|
| `10s`  | 10秒（テスト用）|
| `5m`   | 5分          |
| `30m`  | 30分         |
| `2h`   | 2時間        |
| `1d`   | 1日          |

- 省略時: デフォルト `10m`
- 単位の大文字・小文字は問わない
- 小数点あり（例: `1.5h`）も可

## アーキテクチャ

### コンポーネント構成

```
src/loop/
  loop-manager.ts    LoopManager クラス + parseInterval 関数

src/tools/definitions/
  schedule.ts        モデル向け create/list/delete tools
```

### LoopManager クラス

```typescript
interface LoopEntry {
  id: string;
  prompt: string;
  intervalMs: number;
  intervalStr: string;         // 表示用: "5m"
  recurring: boolean;
  timerId: ReturnType<typeof setTimeout>;
  createdAt: Date;
  nextRunAt: Date;
  lastRunAt?: Date;
  runCount: number;
  skippedRuns: number;
  failureCount: number;
  lastError?: string;
}

type LoopRunner = (prompt: string) => Promise<void>;

class LoopManager {
  start(prompt, intervalMs, intervalStr, runner, options?): string // 反復/one-shot開始、ID返却
  stop(id): boolean                                       // 指定ID停止
  stopAll(): number                                       // 全停止、件数返却
  list(): LoopEntry[]                                     // 一覧取得
  get count(): number                                     // アクティブ数
}
```

同じentryのrunnerは同時実行しない。runnerのrejectは未処理例外へ流さずentryの診断へ記録する。
REPL busy時、反復はその回をskipし、一回限りのscheduleは1秒後へ延期して依頼を失わない。
active上限は50件。

### モデル向けtools

| Tool | 入力 | 動作 |
|---|---|---|
| `schedule_create` | `prompt`, `delay`, `recurring?` | 10秒〜7日の一回／反復scheduleを作成。promptは最大4000文字 |
| `schedule_list` | なし | active scheduleと実行・skip・失敗診断をJSONで返す |
| `schedule_delete` | `id` または `all: true` | scheduleを取消 |

toolsはメインREPLだけへ登録し、Discord/Slack headless面とsubagentには公開しない。将来promptが実行する
個別toolは従来のpermission / sandboxを通る。

### REPL 統合

`src/cli/repl.ts` の `handleCommand()` に `/loop` ケースを追加。
スキルトリガーより先に処理されるよう、switch 文で直接ハンドリング。

スキルレジストリによるトリガーマッチを回避するため、`handleCommand()` の
先頭の `skillRegistry.getByPrefix()` チェックより前に `/loop` を処理する。

### 実行フロー

1. ユーザーが `/loop 5m /pr-check` を入力
2. REPL が間隔 `5m` = 300,000ms、プロンプト `/pr-check` をパース
3. `LoopManager.start()` でタイマーを登録、ID を返却
4. 起動メッセージを表示してユーザー入力に戻る
5. 300,000ms 後、`setInterval` コールバックが発火
6. `processInput("/pr-check")` を呼び出し、エージェントを実行
7. 以降、指定間隔で繰り返す

### 並行制御

Node.js は単一スレッドのため、エージェント実行中（`await agent.run()`）は
`setInterval` コールバックは発火しない（イベントループがビジー状態）。
エージェントが応答待ち（`readline.question()` のような非同期待機）の間に
タイマーが発火した場合は、そのまま実行する。

エージェントが処理中かどうかの状態を REPL 側で管理し、タイマー発火時に
実行中であれば「スキップ」ログを出力して次のインターバルを待つ。

## 実装の制約・注意事項

- `/loop` はスキルシステムを経由しない（REPL の switch 文で直接処理）
- ループは REPL セッション内のみ有効（セッション終了時に全タイマーをクリア）
- モデル向けscheduleも同じくsession内だけで、プロセス再起動後へ永続化しない
- 実行中のループをまとめてキャンセルする場合は `/loop status` で全選択 → Enter、 または旧形式の `/loop stop all` (alias) を使う
- CLAUDE.md の「絶対パス使用」ルールは本機能には非該当（パス操作なし）
