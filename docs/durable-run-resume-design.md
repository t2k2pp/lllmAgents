# foreground run の一時停止と再開 (PC再起動を跨ぐ) 設計

- 課題ID: `GAP-DURABLE-RUN-01`
- 優先度: P1
- 実装cycle: 18
- 状態: 実装・対象回帰済み
- 改訂: 2026-10-25 — 一時停止を 1 方式に統合 (`--durable` とプロセス内 pause を廃止)、 起動時の再開確認を追加 (§一時停止の一本化 / §起動時の再開確認)

## 目的

`/run pause`が安全境界へ到達したことをatomic保存し、アプリを閉じずにそのまま、 またはアプリ・PC再起動後に、同じforeground runを続ける。

```text
/run pause
  → 「⏸ 一時停止しました」 表示を待つ (会話と再開地点を保存済み)
  ├─ そのまま: /run resume
  └─ アプリ・PC停止 → 同じフォルダでアプリ起動 → 「再開しますか?」 → はい
       (いいえ / 非TTY の場合: /resume <session-id> → /run resume)
```

既存の`/resume`は会話sessionの選択・復元、`/run resume`は選択済みsession内の実行継続であり、役割を混ぜない。

## 一時停止の一本化 (2026-10-25)

旧仕様は 2 方式だった: `/run pause` (プロセス内。API 応答の直後に止め、保存しない) と `/run pause --durable` (tool 完了後、 次 API 直前で保存して止める)。
同じ目的に 2 つのやり方があると使い分けを誤る。 実際に myppt で `/run pause` を先に出したため後の `--durable` が「予約済み」 で無視され、
保存されないまま終了しかけた。 違いは「tool の完了を待たずに止まる」 点だけで、 ローカル LLM の 1 応答 (数十分) に比べて得るものが小さい。

- `/run pause` は常に「応答と tool を完了 → 次 API 直前で保存 → 停止」。 `--durable` は廃止 (受け付けない)
- 同じプロセスでの `/run resume` は接続先の照合をしない (停止中に llama-server の再起動・並列数変更・モデル入替をする用途のため)。
  照合は再起動を跨ぐ再開 (`/resume` 後の `/run resume`、 起動時の再開確認) だけで行う
- 停止中も `/parallel` は即時に反映できる (従来どおり)
- 要求後に run が次の API を必要とせず完了した場合は、 再開地点を作らず予約終了を表示する

## 起動時の再開確認 (2026-10-25)

一時停止したまま終了した作業は、 次に同じフォルダで起動した時に REPL の入力待ちの前で確認する。

- 対象: `~/.localllm/sessions/` のうち、 再開地点が `durable_paused` で `cwdRealpath` が現在のフォルダと一致するもの。 複数あれば保存時刻が最も新しいもの
  (`findPausedSessionForCwd`。 セッションは 1 件数 MB あるため、 `"durable_paused"` を含むファイルだけを解析する)
- `--resume <id>` で既に再開地点付きのセッションを開いている場合は、 そのセッションについて確認する
- 「はい」: 会話を復元し、 `/run resume` と同じ経路 (互換性照合 → resuming 保存 → 再開) で続ける。 照合で差分があれば理由を表示して止まる (`/run inspect` で確認)
- 「いいえ」: 何もしない。 あとで再開する方法 (`/resume <id>` → `/run resume`、 不要なら `/run discard`) を表示する
- 非TTY (パイプ) では確認せず、 同じ案内だけを表示する

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
  └─ /run pause
       → pause_requested
       → current API + tool group complete
       → atomic save
       → durable_paused

same process
  └─ /run resume → resuming → running → checkpoint削除 (照合なし)

new process
  起動時に同じフォルダの durable_paused を検出 → 「再開しますか?」 (はい = 下の /run resume と同じ)
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
- steering、Esc中断、session`/resume`を回帰させない。
- `/run pause --durable` は不明な引数として拒否する (旧方式を残さない)。
- Windows/Linux/macOS、実PTY、配布exe smokeを最新push SHAで完了する。

## 制約

これは任意の外部toolにexactly-onceを付与する分散transactionではない。保証するのは`durable_paused`到達時点のtool pairingと、そこから次APIを一度開始することまでである。resume開始後の予期しないprocess/PC停止は安全のため自動継続せず、人の判断へ戻す。
