# Discord 受信の Gateway 方式への切り替え 設計書

作成: 2026-06-13
ステータス: 実装済み

## 1. 背景と目的

`/ask` スラッシュコマンドの受信は、これまで **Interactions Endpoint URL 方式**
(Discord 側からこちらの HTTPS URL へ POST してくる) で実装されていた
(`src/discord/interaction-server.ts`、docs/channel-interaction-bridge-design.md)。

この方式は「外部から届く公開 HTTPS URL」が必須で、自宅 PC で常駐させる本ツールの
主用途では ngrok / cloudflared などのトンネルを別途立てる必要があった。

本変更では受信を **Gateway 方式** (Bot がこちらから Discord に WebSocket で接続し、
interaction をイベントとして受け取る) に切り替える。Slack 統合が採用している
Socket Mode と同じ「外向き接続」モデルであり、公開 URL・ポート開放・トンネルが
一切不要になる。

## 2. 設計判断

### 2.1 Endpoint 方式は併存させず削除する

Discord の仕様で、Developer Portal に Interactions Endpoint URL が設定されていると
interaction は Gateway には配送されない。両方式を併存させると **Portal の設定
ひとつで片方が何のエラーも出さずに沈黙する** 構成になり、「silent な欠損は禁止」の
原則に反する。受信経路は Gateway の 1 本に統一し、HTTP サーバーと Ed25519 署名検証は
削除する (git 履歴には残る)。

### 2.2 依存パッケージを追加しない (discord.js を使わない)

- WebSocket クライアントは既存の直接依存 **undici** が提供するものを使う
  (Node 22 のグローバル WebSocket と同じ実装)。新規依存ゼロ。
- discord.js は heartbeat / resume をライブラリ任せにできる利点はあるが、
  依存が大きく exe 配布 (`npm run build:deploy`) のサイズ・ビルドへの影響が
  無視できない。本ツールが使う Gateway 機能は「接続を維持して
  INTERACTION_CREATE を受け取る」だけなので、最小クライアントを自前実装する。

### 2.3 接続状態は必ず可視化する (no-silent-loss)

- 認証失敗 (close code 4004) や intent 設定エラー (4013/4014) など回復不能な
  切断は **再接続せず**、原因と対処をコンソールに表示して停止する。
- 回復可能な切断は指数バックオフで自動再接続し、その旨をログに出す。
- `/discord status` で「Bot 接続: 接続中 / 停止中」を表示する。

### 2.4 応答側 (REST) は変更しない

ボタン・Modal・follow-up・進捗報告・会話載せ替え (A-2〜A-6, B-1) のロジックは
interaction token ベースの REST API で完結しており、受信経路に依存しない。
変わるのは「interaction への初回応答」の返し方だけ:

| | Endpoint 方式 (旧) | Gateway 方式 (新) |
|---|---|---|
| 受信 | HTTP POST を受ける | WS の INTERACTION_CREATE |
| 初回応答 (3 秒以内) | HTTP レスポンスに JSON を書く | `POST /interactions/{id}/{token}/callback` |
| follow-up / ボタン / Modal | REST (変更なし) | REST (変更なし) |

interaction token が 15 分で失効する既知の制約 (channel-interaction-bridge-design.md §9)
も方式に関係なく同じ。

## 3. 構成

```
src/discord/
  gateway-client.ts      … 新規。Gateway v10 への WS 接続を維持する最小クライアント
  interaction-server.ts  … DiscordInteractionServer を Gateway 受信に書き換え
                            (クラス名・ファイル名は呼び出し側の混乱を避けるため当面維持)
  slash-commands.ts      … 変更なし (コマンド登録は元から REST)
```

### 3.1 gateway-client.ts (`DiscordGatewayClient`)

接続シーケンス (Gateway v10, encoding=json, 圧縮なし):

1. `GET /gateway/bot` (Bot Token) で接続先 URL を取得
2. `wss://.../?v=10&encoding=json` へ接続
3. Hello (op 10) を受信 → `heartbeat_interval * Math.random()` 後に初回 heartbeat、
   以後 interval ごとに op 1 (d = 直近の seq) を送信
4. Identify (op 2) を送信 — `intents: 0` (interaction の受信に intent は不要)
5. READY (t=READY) で `session_id` / `resume_gateway_url` / Bot ユーザー名を保持
6. 以後 dispatch (op 0) の `s` を seq として記録し、`t=INTERACTION_CREATE` を
   コールバックへ渡す

再接続戦略:

- **Resume**: op 7 (Reconnect)、heartbeat ACK 欠落 (ゾンビ接続)、コード 4000 系の
  一部・ネットワーク断 → `resume_gateway_url` に再接続して op 6 (Resume) を送る。
  op 9 (Invalid Session, d=false) を受けたら 1〜5 秒待って Identify からやり直す
- **バックオフ**: 再接続は 1s → 2s → 4s → … 最大 60s の指数バックオフ
- **致命的エラー (再接続しない)**: 4004 (トークン不正), 4010〜4014。原因と対処を
  表示して停止する
- `stop()`: 意図的クローズ (code 1000)。再接続しない

### 3.2 interaction-server.ts の変更

- `http.Server` / 署名検証 / PING(type 1) 応答を削除 (PING は Endpoint 方式の疎通確認)
- `start()` = GatewayClient 接続 + InteractionBridge 登録、`stop()` = 切断 + 解除
- 各ハンドラの「応答を書く」処理を `respondInteraction(interaction, payload)`
  (= callback エンドポイントへの POST) に置き換え。ペイロードは旧実装と同一

### 3.3 設定・CLI の変更

| 項目 | 変更 |
|---|---|
| `discord.publicKey` | 不要になる。型には残すが未使用 (旧設定があっても無害) |
| `discord.interactionPort` | 同上 |
| 必須設定 | applicationId + botToken の 2 つに減る |
| `/discord public-key` `/discord port` | 「Gateway 方式では不要になった」案内を表示 |
| `/discord listen start/stop` | 受信の開始/停止 (意味は同じ、中身が WS 接続に) |
| `/discord status` | Public Key / ポート行を削除し「Bot 接続」行を表示 |
| `--background` モード | publicKey 必須チェックを botToken 必須チェックに変更 |

セットアップ手順 (新):

1. Developer Portal でアプリ作成 → applicationId / botToken を設定
2. 招待 URL (`scope=bot+applications.commands`) で Bot をサーバーに招待
3. `/discord register [サーバーID]` で /ask を登録
4. `/discord listen start` で受信開始 (Portal の Interactions Endpoint URL は **空にしておく**)

※ 旧方式から移行する場合、Portal に Endpoint URL を設定済みだと Gateway に
interaction が流れないため、**Portal の Interactions Endpoint URL を空欄に戻す**
必要がある。listen start 時にこの注意を表示する。

## 4. 既知の制約

- WS 接続が切れている間に送られた /ask は受信できない (Discord 側には
  「アプリケーションが応答しませんでした」と表示される)。旧方式でもプロセス停止中は
  同じであり、運用上の差はない
- 外向き WebSocket (443) が遮断されるネットワークでは使えない (Slack Socket Mode と同条件)
- interaction token の 15 分失効、長時間タスク中の確認不可は従来どおり

## 5. テスト

- `npx tsc --noEmit`
- 実トークンで listen start → READY 受信 (接続成功) まで自動確認
- /ask 実応答・ボタン・Modal は Bot 招待後に手動確認 (TTY)
