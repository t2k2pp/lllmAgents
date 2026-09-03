# PC再起動を跨ぐ durable run resume 設計

- 課題ID: `GAP-DURABLE-RUN-01`
- 優先度: P1
- 実装cycle: 18
- 状態: 実装・対象回帰済み

## 目的

`/run pause --durable`が安全境界へ到達したことをatomic保存し、アプリ・PC再起動後に次の操作で同じforeground runを続ける。

```text
/run pause --durable
  → durable_paused表示を待つ
  → アプリ・PC停止
  → アプリ起動
  → /resume <session-id>
  → /run inspect
  → /run resume
```

既存の`/resume`は会話sessionの選択・復元、`/run resume`は選択済みsession内の実行継続であり、役割を混ぜない。従来の`/run pause`も高速なプロセス内pauseとして維持し、durableへ暗黙変換しない。

## 比較から確認した境界

- OpenAI Codexの公式CLIリファレンスは`codex resume`と`/resume`を保存chatの復元として説明している。cwdが異なる場合は選択を求めるため、復元時の作業フォルダ差分を無視しない設計が必要である。
- Claude Codeの公式CLIリファレンスも`--resume`/`-r`をsession復元として提供し、background sessionには`stop`/`respawn`を別操作として提供している。
- いずれも「local LLMの保守窓として、foreground agent loopを次API直前で永続停止する」契約そのものではない。本アプリではconversation resumeとrun checkpointを二段階に分ける。

参照:

- [OpenAI Codex CLI reference](https://developers.openai.com/codex/cli/reference)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-usage)

## 安全境界

durable pauseは、要求時点ですぐ`durable_paused`にしない。進行中のmain LLM応答を受け取り、その応答が要求したtool群を完了してtool call/result pairingを履歴へ確定した後、次のmain LLM APIを始める直前で保存する。

この限定によりcheckpointは未実行のtool callや開始済みtoolを保持しない。再起動後は確定済み履歴を入力として次のLLM APIから再開するため、pause前に終わったtoolを二重実行しない。要求後にrunが次APIを必要とせず完了した場合はcheckpointを偽造せず、予約終了を表示する。

対象はCLI foreground main AgentLoopだけである。background task、second LLM、外部MCP serverは自動停止しない。これらが同じlocal serverを使う場合は、利用者が各ライフサイクル操作で止める。

## 永続schema

`SessionData.runCheckpoint`へversion 1のcheckpointを追加する。session本体と同じatomic writeを使い、旧sessionはoptional fieldとしてそのまま読める。fork sessionへcheckpointは複製しない。

主な保存値:

- `state`: `durable_paused`または`resuming`
- session ID、保存時刻、cwd realpath
- provider、model、endpoint signatureのSHA-256 fingerprint
- `boundary: before_llm_request`
- 次iteration、元のuser intent、反復検知・自己点検・検証待ちのrun state

endpoint URLやAPI key値は診断表示しない。endpoint signatureも平文保存せずfingerprint化する。

## resumeと異常終了

`/run resume`はcwd、session ID、provider、model、endpoint fingerprintを照合し、差分があれば自動継続しない。`/run inspect`が差分とcheckpoint状態を表示し、user入力やtool引数は表示しない。

再開直前にstateを`resuming`としてatomic保存する。resume開始後にprocessが終了した場合、どのAPI/toolまで到達したかを一般には証明できないため、次回の自動resumeは`blocked_unknown_progress`としてfail-fastする。利用者は`/run inspect`で確認し、`/run discard`でcheckpointだけを破棄して会話から明示的に続ける。正常終端時だけcheckpointを削除する。

同一processのresume中に例外が起きた場合は、未pairing tool callをmemoryへ残さないようresume直前のatomic sessionへrollbackする。

## 状態遷移

```text
running
  └─ /run pause --durable
       → durable_pause_requested
       → current API + tool group complete
       → atomic save
       → durable_paused

new process
  /resume <id> → durable_pausedをrehydrate（自動実行しない）
  ├─ /run inspect
  ├─ /run resume → compatibility check → resuming → running → checkpoint削除
  └─ /run discard → checkpointだけ削除、conversation保持

resuming中にprocess終了
  → blocked_unknown_progress（自動再実行しない）
```

## 受け入れ条件

- tool resultを保存後に旧AgentLoopを終了し、新AgentLoopへsessionを復元してもtoolは再実行されず、次APIだけが1回始まる。
- checkpoint到達表示より前にPC停止可能とは案内しない。
- cwd/model/provider/endpoint/unknown schemaを明示的に拒否する。
- `resuming`を自動再実行しない。
- forkはrun checkpointを引き継がない。
- 通常`/run pause`、steering、Esc中断、session`/resume`を回帰させない。
- Windows/Linux/macOS、実PTY、配布exe smokeを最新push SHAで完了する。

## 制約

これは任意の外部toolにexactly-onceを付与する分散transactionではない。保証するのは`durable_paused`到達時点のtool pairingと、そこから次APIを一度開始することまでである。resume開始後の予期しないprocess/PC停止は安全のため自動継続せず、人の判断へ戻す。
