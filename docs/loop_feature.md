# Loop Feature 設計書

## 概要

`/loop` コマンドは、プロンプトまたはスラッシュコマンドを一定間隔で繰り返し実行する機能。
Claude Code の `/loop` スキルと同等の UX を提供する。

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
```

### LoopManager クラス

```typescript
interface LoopEntry {
  id: string;
  prompt: string;
  intervalMs: number;
  intervalStr: string;         // 表示用: "5m"
  timerId: ReturnType<typeof setInterval>;
  createdAt: Date;
  lastRunAt?: Date;
  runCount: number;
}

type LoopRunner = (prompt: string) => Promise<void>;

class LoopManager {
  start(prompt, intervalMs, intervalStr, runner): string  // ループ開始、ID返却
  stop(id): boolean                                       // 指定ID停止
  stopAll(): number                                       // 全停止、件数返却
  list(): LoopEntry[]                                     // 一覧取得
  get count(): number                                     // アクティブ数
}
```

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
- 実行中のループをまとめてキャンセルする場合は `/loop status` で全選択 → Enter、 または旧形式の `/loop stop all` (alias) を使う
- CLAUDE.md の「絶対パス使用」ルールは本機能には非該当（パス操作なし）
