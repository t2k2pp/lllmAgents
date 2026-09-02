# PC再起動を跨ぐ durable run resume 設計候補

- 候補ID: `GAP-DURABLE-RUN-01`
- 優先度: P1
- 想定cycle: 18
- 状態: **設計候補（未実装）**
- 起点: cycle 17の`/run pause`がプロセス内だけで、PC再起動後は会話しか復元できないという利用者確認

## 1. 目標

`/run pause --durable`が安全境界へ到達したことを永続化し、アプリ・PC再起動後に次の操作で同じrunを継続できるようにする。

1. `/resume <session-id>`または`--resume <session-id>`で会話とdurable checkpointを復元する。
2. `/run status`で`durable_paused`、保存時刻、停止境界、接続先差分を表示する。
3. `/run resume`を明示実行すると、未実行処理だけを同じrunとして継続する。

cycle 17の`/run pause`は高速なプロセス内pauseとして維持する。通常pauseをdurableへ黙って置換しない。

## 2. 現行資産と不足

| 資産 | 現在できること | durable runに不足するもの |
|---|---|---|
| session JSON | messages、todo、goalをatomic保存し`/resume`で復元 | run反復位置、pending response/tool、追加入力、境界状態 |
| crash handler | 例外終了時に会話を緊急保存 | 安全境界到達の保証、実行中toolの結果確定 |
| shadow Git checkpoint | 成果物をsession ID名前空間で復元 | AgentLoopの制御状態。名称が同じでも別機能 |
| `RunApiGate` | main APIと新規toolをプロセス内で停止 | 永続schema、起動時rehydrate、消費journal |

## 3. 安全契約

- `durable_paused`を表示してよいのは、main LLM APIとtoolがともに実行中0件で、tool call/result pairingを保存できた時だけ。
- 保存はsession IDに結び付け、schema version付きのatomic writeとする。途中書き込みを復元対象にしない。
- background task、second LLM、外部MCP serverは自動停止しない。残存時はdurable到達を`blocked`にし、対象と停止方法を表示する。
- cwdのrealpath、model/provider endpoint fingerprint、permission modeが保存時と異なる場合は黙って継続しない。差分を表示し、明示選択を求める。
- toolが`started`だが結果未記録のcheckpointは、外部副作用の有無を判定できないため自動再実行しない。`blocked_unknown_tool_outcome`としてinspect/discard/明示再実行だけを許す。
- thinkingや秘密値を新たに保存対象へ広げない。pending tool argumentsは既存sessionと同じ保護境界で扱い、診断表示ではmaskする。

## 4. 永続schema案

`SessionData`へoptionalな`runCheckpoint`を追加する。旧sessionはフィールド無しのまま読める。

```ts
type DurableRunCheckpoint = {
  schemaVersion: 1;
  checkpointId: string;
  state: "durable_paused" | "resuming" | "blocked_unknown_tool_outcome";
  savedAt: string;
  sessionId: string;
  source: "cli";
  cwdRealpath: string;
  modelBinding: { provider: string; endpointFingerprint: string; model: string };
  iteration: number;
  boundary: "before_tool_group" | "before_llm_request";
  pendingAssistant?: { text: string; toolCalls: ToolCall[]; thinking?: never };
  pendingSteering: string[];
  toolJournal: Array<{ callId: string; name: string; state: "pending" | "started" | "completed" }>;
};
```

checkpointは通常のconversation messagesへ未完了tool pairを混ぜず、復元専用フィールドへ分離する。

## 5. 状態遷移とCLI

```text
running
  └─ /run pause --durable
       → durable_pause_requested
       → API/tool実行中0 + atomic保存
       → durable_paused
       → アプリ・PC停止可

起動 → /resume <id> → durable_pausedを可視化
  ├─ /run resume  → compatibility検査 → resuming → running
  ├─ /run inspect → pending処理と差分をmask表示
  └─ /run discard → checkpointだけ破棄、conversationは保持
```

既存`/resume`はsession選択、`/run resume`は選択済みsession内のrun継続という役割分離を維持する。

## 6. 実装境界

1. `RunApiGate`へactive tool数とdurable request状態を追加する。
2. AgentLoopのAPI完了・tool開始・tool結果記録をjournal化し、pairingが確定した境界でcheckpoint builderを呼ぶ。
3. session managerへversioned checkpointのvalidate/save/load/consumeを追加する。
4. `restoreSession()`はcheckpointを実行せずrehydrateだけ行い、状態を可視化する。
5. `/run resume|inspect|discard`で明示的に継続・確認・破棄する。
6. crash handlerは安全な既存checkpointを保持するが、実行中状態を成功扱いへ昇格しない。

## 7. 受け入れ条件

- durable到達表示後にプロセスをkillし、PC再起動相当の新規processで`/resume`→`/run resume`すると、停止前に未実行だった次APIまたはtoolだけが1回開始される。
- pause前に完了したtoolを再実行しない。pending toolはcall IDと順序を維持する。
- tool started/result未記録のfixtureは自動再実行されず、診断可能なblocked状態になる。
- cwd/model/provider差分、破損schema、旧schema、別Room、別surfaceを明示判定する。
- session JSONに秘密値の追加漏えいがなく、診断出力はmaskされる。
- Windows/Linux/macOSでatomic保存、kill/restart、SEA配布のE2Eを通す。
- 最新push SHAの全test、実PTY、Windows deploy / exe smokeが成功する。

## 8. 評価上の注意

これは会話の`/resume`や成果物の`/checkpoint restore`とは別の、実行制御checkpointである。外部tool副作用に一般的なexactly-once保証は作れないため、不明状態を自動再試行せず止めることを商品要件とする。
