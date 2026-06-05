# bash 封じ込め設計（Windows 2種モデル）

> ステータス: **設計確定（2026-06-04）** / `/sandbox` コマンド実装済み・route-to-WSL は退役
> 復帰点タグ: `wsl-phase1-routing`（route-to-WSL が実機で動いた版。戻したくなったらここへ）
> 関連: `src/security/process-sandbox.ts`、`src/security/wsl.ts`、`src/security/permission-manager.ts`、`docs/checkpoint-and-smoke-design.md`

## §1 背景・動機

本質的な狙いは「仮想環境を作ること」ではなく、**エージェントにのびのび開発させたい＝許可確認を減らしたい**こと。確認を安全に減らす原理はひとつ：**封じ込めが強いほど、確認は安全に減らせる**（containment earns autonomy）。Claude Code のサンドボックスもこの設計（社内計測で確認プロンプト 84% 減）。

封じ込めの土台（ハード層）の現状：

| OS | ハード層の機構 | 現状 |
|---|---|---|
| Mac/Linux | `processSandbox`（sandbox-exec / bwrap） | 実装済み・既定 OFF |
| Windows（ネイティブ） | — | **無い**（git bash 実行） |

穴は Windows。これをどう塞ぐかが本設計の主題。

## §2 現状の事実（実装調査）

- `src/tools/definitions/bash.ts`：Windows は git bash（無ければ cmd.exe）。非 Windows は `processSandbox.isActive()` 時に `wrapCommand` でラップ。
- `src/security/process-sandbox.ts`：linux→bwrap/unshare、darwin→sandbox-exec、win32→none。`allowedHosts?: string[]`（未使用）あり。
- `src/security/sandbox.ts`：`Sandbox` が file_*/glob/grep を許可ディレクトリに限定（全 OS・アプリレベルのソフト層）。
- `src/security/permission-manager.ts`：`autorun` が作業フォルダ内の非破壊操作を自動承認。破壊・CWD 外・広域スキャンはブロック/確認。

## §3 設計方針 — Windows は「2種」に整理する

**Windows での封じ込めは、機構を作り込むのではなく「動かす環境」を 2 種に分ける。** これは Claude Code と同じ整理（§6 裏取り参照）。

| 変種 | bash | OS 封じ込め | 向き |
|---|---|---|---|
| **1. ネイティブ Windows**（exe） | Git Bash（無ければ cmd/PowerShell） | **無し（正直にそう言う）** | カジュアル層（sandbox/ でゲーム作る等） |
| **2. WSL2 の中でアプリごと起動** | Linux シェル | **既存 processSandbox（bwrap）がそのまま効く** | 封じ込めが欲しい上級者 |

要点：**変種2 ではアプリは `process.platform === "linux"` になる**ため、Mac/Linux 用に既にある `processSandbox` / `/sandbox` の Linux 経路が**そのまま発火**する。Windows 専用の封じ込めコードは不要。

### なぜ route-to-WSL（旧 Phase 1）を退役したか

当初は「ネイティブのまま bash だけ `wsl.exe` 経由で WSL に流す」routing を実装し、実機（Win11+WSL2 Ubuntu）で動作確認した（タグ `wsl-phase1-routing`）。しかし Windows 2種モデルに整理する中で退役した。理由：

- route-to-WSL は弱点が多い：`/mnt/c` 越しの I/O 遅延、Windows↔WSL のパス変換、**WSL サンドボックス内から `/mnt/c` の Windows バイナリを呼べない**、そして §7 のネット allowlist（プロキシ）を per-command の `wsl.exe` 呼び出しに被せるのが筋悪。
- 「封じ込めが欲しい人＝WSL を理解している上級者」なので、**変種2（WSL 内起動）で用が足りる**。中間層（route-to-WSL）は説明コストの割に価値が薄い。
- 変種2 は新規コードがほぼ不要（既存 Linux サンドボックスの再利用）で、Claude Code とも揃う。

`src/security/wsl.ts` は **WSL 検出のみ**を残す（ネイティブ Windows で「WSL2 があるなら中で起動すれば封じ込められますよ」と案内するため）。

## §4 アーキテクチャ

```
process.platform?
 ├─ darwin / linux  → processSandbox (sandbox-exec / bwrap)。/sandbox で on/off
 │                     ※ WSL2 の中で起動した場合もここ（platform=linux）
 └─ win32 (ネイティブ) → git bash → cmd.exe。OS 封じ込めは無し
                          /sandbox は「WSL2 内起動で封じ込め可」と案内するだけ
```

- 封じ込めの実体は `processSandbox`（既存）に一本化。Windows ネイティブは封じ込め非対応と明示。
- WSL 検出（`detectWsl`）はネイティブ Windows での案内専用。

## §5 操作 UI — `/sandbox` 統一コマンド（実装済み）

config.json の手編集はハードルが高いので REPL コマンド化。**OS ごとに別コマンドを作らない**（機構が違ってもユーザーの心象は「bash を封じ込める」で同一。別名乱立はクロスプラットフォーム利用者の学習コストと、ユーザー同士の助け合いを損なう）。

- `/sandbox status|on|off` 単一コマンド。
- Mac/Linux/**WSL2 内** → `processSandbox` を on/off（`resetProcessSandboxCache()` で再起動不要の即反映）。
- ネイティブ Windows → トグル対象なし。「封じ込めには WSL2 の中で起動」と案内（WSL2 検出時は distro 名も表示）。
- `status` は OS 共通フォーマットで方式・実効状態を表示。`WSL_DISTRO_NAME` で WSL2 内実行を判定して表示。
- リスクは OS 別に警告を出し分け（コマンドと心象は共通）：Mac/Linux on 時は **ネットワーク遮断**（§7）を明示警告。
- REPL 対話 UI のため、表示・操作感は手動 TTY 検証が必要（パイプでは未確認）。

## §6 Claude Code との比較（裏取り 2026-06-04）

公式ドキュメントで方向性を確認した（出典は本節末）。**我々の整理は Claude Code と一致**：

- **FS とネットワークは独立した2軸**。「Effective sandboxing requires *both* filesystem and network isolation」。
- **コマンド名も `/sandbox`**、OS プリミティブも **macOS=Seatbelt / Linux=bubblewrap**。
- **既定 OFF・opt-in**（`sandbox.enabled`）。
- **Windows は「ネイティブ or WSL2 内起動」の2種**。サンドボックスは「Native Windows is not supported. On Windows, run Claude Code inside a WSL2 distribution.」＝**route-to-WSL のような routing は作っていない**。我々が route-to-WSL を退役して2種に倒した判断はこれと一致。
- Claude Code の Windows 対応の変遷：初期は WSL 必須 → 後にネイティブ Windows 対応（PowerShell/CMD、Git for Windows は任意で Git Bash 提供）→ **「WSL 必須」は“サンドボックスを使うなら”に縮小**。lllmAgents もネイティブ Windows＝git bash で同じ構図。
- 我々の `ProcessSandboxConfig.allowedHosts`（未使用の伏線）は Claude Code の `allowedDomains` に対応。

出典:
- [Configure the sandboxed Bash tool — Claude Code Docs](https://code.claude.com/docs/en/sandboxing)
- [Making Claude Code more secure and autonomous with sandboxing — Anthropic](https://www.anthropic.com/engineering/claude-code-sandboxing)
- [Advanced setup — Claude Code Docs（native Windows / WSL 両対応）](https://code.claude.com/docs/en/setup)

## §7 封じ込めの2軸再設計（今後の課題・未着手）

「のびのび開発（確認削減）」の核心はここ。現状の `processSandbox` は `network`/`full` のどちらも**ネット遮断**で、`npm install`・`pip`・CDN 取得が通らない。FS は閉じたいがネットは使いたい、という用途と噛み合わない。

Claude Code の“正解”：**ネットは OFF ではなく「プロキシ経由のドメイン allowlist（既定は新ドメイン初回に確認）」**。これで FS を閉じつつ必要な通信だけ通す。

→ 再設計の方向：`processSandbox` を **「FS 書込スコープ」と「ネット」の直交2軸**にする。段階を切る（決定1=b）：

- **Phase 2a（実装済み）**：レベル `"fs"`（FS 書込のみ隔離・ネットワークは許可）を追加。`/sandbox on` の既定を `fs` にし、`npm install`/`pip` 等が通る "のびのび dev" を成立させた。Linux は bwrap（`--unshare-net` なし）、macOS は Seatbelt（`(allow network*)`）。`buildBwrapArgs`/`buildSeatbeltProfile` を純粋関数に分離してテスト。
  - **決定3（厳しめ・実装済み）**：封じ込め有効時（fs/full）は `~/.ssh` `~/.aws` `~/.gnupg` `~/.kube` `~/.docker` `~/.config/gcloud` の**読み取りを既定でブロック**（Linux=空 tmpfs で覆う / macOS=Seatbelt deny）。Claude Code は既定で読める（denyRead 必須）が、我々は塞ぐ方針。`.npmrc`/`.pypirc` は npm/pip 認証を壊さぬよう**あえて含めない**。`defaultSecretDenyDirs` を純粋関数化してテスト。
  - 正直な穴：`"fs"` はネット全開なので、Claude Code が警告する「FS は閉じてもネット経由で SSH 鍵等を持ち出せる」リスクは Phase 2b まで残る。`full` を選べば従来どおりネット遮断。
- **Phase 2b（未着手）**：ネットを「ドメイン allowlist（プロキシ）」化（`allowedHosts` を `allowedDomains` 相当へ格上げ）。**決定2＝自前実装**（`@anthropic-ai/sandbox-runtime` は採用せず、自前のプロキシ＋allowlist を構築する）。Claude Code の `socat` リレー＋プロキシ方式を参考に設計する。工数大のため着手は別途・要設計。

これ（特に 2b で「必要な通信だけ通す」）が固まって初めて「封じ込め時のみ autorun が bash 確認を省く」連動（確認削減の実体）に進める。

### §7.1 Phase 2b 詳細設計（ネット allowlist・対話確認）

決定（user）: **未許可ドメインは初回に対話確認（Claude Code 流）** / **既定 allowlist は開発定番プリセット** / **自前実装**（`@anthropic-ai/sandbox-runtime` 不採用）。

**Claude Code の方式**：サンドボックスは直接ネット不可。unix domain socket 経由で「外のプロキシ」へ繋ぎ、プロキシが SNI/Host でドメイン allowlist を強制（TLS 終端なし）。`socat` がリレー。

**我々（自前）の方式** ―― 1点だけ単純化できる：
- **プロキシ＝エージェント本体プロセス内の HTTP CONNECT サーバ**にする。bash 子プロセスに `HTTP(S)_PROXY=localhost:PORT` を注入。Node の event loop は子プロセス待機中もプロキシ接続を捌ける。
- 未許可ドメインへの CONNECT → ハンドラが **REPL の確認（既存の権限プロンプト直列化を再利用）** を await → 許可なら allowlist 追加＋トンネル、拒否なら 502。**同一プロセスなので IPC 不要**（Claude Code の別プロセス＋socat より単純）。
- 直接接続の遮断（プロキシ迂回防止）：
  - **macOS（2b-1・先行）**：Seatbelt で `network-outbound` を `localhost:PORT` のみ許可（他は deny）。在プロセスのプロキシがそのまま効く＝tractable。
  - **Linux/WSL2（2b-2・後追い）**：bwrap `--unshare-net` で直接ネット遮断＋unix socket をサンドボックスへ bind＋内部 `socat` で `localhost:PORT`→unix socket→外のプロキシ、というブリッジ（Claude Code 同型）。工数大。
- **TLS は終端しない（ホスト名ベース）**。ドメインフロンティングの注意点は Claude Code と同じ割り切り。
- **allowlist の保存**：`config.security.processSandbox.allowedHosts`（既存フィールドを流用）。既定 = `DEFAULT_ALLOWED_DOMAINS`（npm/yarn/pip/GitHub）。
- **照合**：完全一致 ＋ `*.example.com` ワイルドカード（サブドメインのみ）。`src/security/net-allowlist.ts`（純粋関数・テスト済み）。
- **コマンド**：`/sandbox allow <domain>` / `/sandbox deny <domain>`、`status` で現在の allowlist 表示。
- 非 TTY/パイプ：対話確認できないため「未許可はブロック（fail-closed）」にフォールバック。

実装順：土台（allowlist 照合＋既定リスト＝実装済み）→ **2b-1（実装済み）** → 2b-2（Linux/WSL2 の socat ブリッジ・未着手）。

**2b-1 実装メモ（macOS）**：
- `src/security/sandbox-proxy.ts`：在プロセス `http.Server`。CONNECT はホスト名で `authorize` → 許可ならトンネル（TLS 素通し）/ 拒否は 403。未許可は `onUnknownDomain` で対話確認、同一ホストの並行確認は集約、once はセッション許可・always は永続。`configureSandboxProxy`/`getSandboxProxy` シングルトン。
- `bash.ts`：macOS かつ実効 `fs` かつプロキシ構成済みなら `ensureStarted()` でポート取得 →子プロセスへ `HTTP(S)_PROXY` 注入。
- `process-sandbox.ts`：`buildSeatbeltProfile(..., proxyPort)` ＝ fs で proxyPort 指定時は `(allow network-outbound (remote ip "localhost:port"))` のみ許可し直接接続を遮断。proxyPort 無しの fs は **fail-closed でネット遮断**（`(allow network*)` 退避は撤去済み）。
- `repl.ts`：`configureSandboxProxy` を構成（allowlist=config、確認=inquirer・非TTY は deny、always で config 保存）。`/sandbox allow|deny <domain>`、`status` に allowlist 表示。
- テスト：`net-allowlist`（照合）、`sandbox-proxy`（authorize: allow/deny/once/always/並行集約/ワイルドカード）、`process-sandbox`（fs+proxyPort の Seatbelt 文字列）、`process-sandbox.seatbelt.integration`（**プロファイルを実際に sandbox-exec へロード**して受理・書込封じ込め・機密 deny を検証＝下記盲点の回帰防止／darwin 限定）。

**セキュリティレビュー反映（サブエージェント指摘・cf12134 直後）**：
- **fail-open 撲滅（最重要）**：macOS fs は「プロキシ経由 or ネット遮断」のみ。`buildSeatbeltProfile` から `(allow network*)` 退避を撤去し、proxyPort 無し fs は **fail-closed**（プロキシ起動失敗・未構成でもネット全開に落ちない）。
- **HTTP Host 詐称対策**：プレーン HTTP 経路で認可対象と実接続先を `url.hostname` に統一（Host ヘッダとリクエストラインの不一致による迂回を防止）。
- **CONNECT ポート制限**：443/80 以外の CONNECT を拒否（許可ドメインの任意ポートトンネル悪用を防止）。
- **末尾ドット正規化**：`normalizeHost` が FQDN 末尾ドットを除去。
- ⚠️ **表記一致は誤りだった（撤回）**：当時「Seatbelt 許可を `localhost:port`→`127.0.0.1:port` に統一」としたが、**Seatbelt の `remote ip` はホストに数値IPを受け付けず `localhost`/`*` のみ**。`127.0.0.1:port` を書くと sandbox-exec がプロファイルをロードできず exit 65 で **macOS fs が全滅**する。正しくは rule=`localhost:port`・env=`http://127.0.0.1:port`（数値IPへの接続も localhost ルールで許可されることを実機確認）。ユニットの `toContain` 文字列検査だけで実ロードしていなかった盲点。→ §7.1 実機検証で発覚し修正（rule を `localhost` へ・統合テスト追加）。

**実機検証（macOS 26.3・sandbox-exec・2026-06-05、4観点サブエージェントレビュー後）**：
生成プロファイルと同一物を sandbox-exec へ実ロードして測定。
- ✅ **ネット封じ込めは堅牢**：直接 TCP（`curl --noproxy` / `/dev/tcp` / `nc` / python socket）・**DNS（getaddrinfo / `dig @8.8.8.8` / 生UDP sendto:53）**・ICMP は **すべて `deny default` が遮断**（EPERM）。許可は `localhost:proxyPort` の TCP のみ。env が数値 `127.0.0.1` でも `localhost` ルールで接続成立。→ レビューの最重大懸念 **C1（DNS/UDP exfil）・H-D（生TCP迂回）は macOS では不成立**と実証。
- ✅ **FS**：writeDir 内のみ書込可・外（HOME 直下等）は EPERM、機密ディレクトリ（実パス）の read は `deny file-read*` が後勝ちで遮断。
- ⚠️ **symlink 注意点（実コードにも該当）**：Seatbelt は**正規化後の実パス**で照合する。`/tmp`(→`/private/tmp`) や `/var`(→`/private/var`) のような symlink を writeDir/denyDir に渡すと allow/deny が一致しない。既定機密 `~/.ssh` 等や通常の `/Users` 配下 cwd は実パスなので問題ないが、symlink 経路は要注意。→ 対策として writeDirs/denyDirs を `realpathSync` で正規化してからプロファイルに載せるのが望ましい（要対応・低〜中）。
- 残課題（当時）：在プロセスプロキシの**対話確認(live-prompt)の TTY 操作感**（非TTYでは品質検証不可）、ほか下記の堅牢化バッチで対応。

**堅牢化バッチ（4観点レビュー＋実機検証の反映・2026-06-05）**：4観点（設計者/実装者/評価者/セキュリティ）のサブエージェントレビュー指摘のうち、正解が明確なものを修正。
- **HTTP フォワードのポート制限**：CONNECT と同じく 80/443 のみ（許可ドメインの任意ポートへの平文中継を防止）。`sandbox-proxy.integration.test` で 403 を確認。
- **内部IP/SSRF 遮断＋DNS ピン留め**：`isBlockedAddress`（loopback/link-local＝メタデータ 169.254.169.254/RFC1918/ULA/v4-mapped）で、許可ドメインでも内部レンジへは中継しない。ホスト名は解決IPをピン留めして接続し authorize 後の DNS rebinding を防ぐ。
- **IDN/ホモグラフ対策**：`normalizeHost` を userinfo(`user@`)除去・IPv6 ブラケット処理・**punycode 正規化**に強化。対話確認で punycode ドメインには警告表示。
- **NO_PROXY 非クリア是正**：プロキシ注入時に子 env の `NO_PROXY`/`no_proxy`/`ALL_PROXY` を削除（残存でプロキシをバイパスし allowlist 無効化されるのを防止）。
- **socket 堅牢化**：トンネルの相互クローズ・アイドルタイムアウト(30s)・接続前ハング防止・確立前後のエラー切り分け（502/403）。
- **proxy ライフサイクル**：`/sandbox off` と非fsレベルへの切替で `proxy.stop()`、`/sandbox deny` で `proxy.revoke()`（セッション once 許可の残存通過を防止）。
- **fail-open コメント是正＋可視化**：proxy 起動失敗時はコメント通り fail-closed で全遮断し、bash 結果に「プロキシ起動失敗で全遮断中」の注記を出す（沈黙で詰まらせない）。
- **status/sandbox_info の誠実化**：`fs` でも macOS=allowlist 経由のみ／Linux=全開（allowlist 未強制）／network・full=全遮断、を OS・レベル別に正直表示。allowlist は「macOS の fs でのみ適用」を明記。
- **allowlist ポリシー一元化**：`resolveAllowedDomains`（undefined→既定プリセット、`[]`→空のまま）に集約。`removeDomain` 追加。
- **realpath 正規化**：writeDirs/denyDirs を `realpathSync` で実体パス化（symlink 経由で allow/deny が一致しない問題の恒久対策）。
- 追加テスト：net-allowlist（userinfo/IPv6/IDN/removeDomain/resolve）、sandbox-proxy（isBlockedAddress/parseConnectPort IPv6/revoke）、sandbox-proxy.integration（CONNECT・HTTP の拒否パス）。計 576 tests green。
- **なお残る（設計の岐路・別途相談）**：`level` enum を真の2軸(FS×ネット)へ作り直すか（アーキ指摘 H-1。`network`/`full` で allowlist が死ぬ根本原因）、既定 allowlist の拡充（prebuilt binary を S3/CDN から取る npm/pip が既定で通らない＝QA H1/H2）、Linux/WSL2 のネット allowlist 実装（2b-2）。ドメインフロンティング（CONNECT は SNI を見ない）と許可ドメイン自体への exfil は脅威モデル上の残存リスクとして明記（TLS 終端しない割り切り）。

## §7.2 Phase 3 — 封じ込め連動の bash 確認自動許可（確認削減＝本機能の原点）

**目的**：当初ゴール「エージェントにのびのび開発させるため許可確認を減らす」を、**封じ込めという安全保証付き**で実現する。Claude Code も同様（封じ込め時は auto-allow＋エスケープハッチ、機密や外部送信は別途確認）。

**発動条件（macOS 先行）**：以下を全て満たす時のみ bash 実行確認を自動許可する。
- `process.platform === "darwin"`（Seatbelt 封じ込めを実機検証済みなのは macOS のみ。§7.1）
- 実効レベルが `fs`（FS 書込スコープ＋ネット allowlist 経由のみ）
- 在プロセスプロキシが構成済み（= ネット allowlist が強制される）
- 設定 `security.processSandbox.autoAllowBashWhenContained !== false`（既定 ON、 オプトアウト可）

**維持する確認（自動許可しない）**：
- **破壊的コマンド**（`AUTORUN_DESTRUCTIVE_PATTERNS`: rm -rf / 上書き / git reset --hard / ディスク操作等）→ 通常の確認フローへフォールバック。
- **危険コマンド**（既存 `checkCommand` の block ルール）→ 従来どおりブロック。
- **CWD 外参照・広域再帰スキャン**（`bashNeedsExplicitAsk`）→ 確認。
- **allowlist 外ドメインへの通信** → 実行時にプロキシ（`onUnknownDomain`）が対話確認。封じ込めが「外部送信は必ず確認」を担保するので、bash 起動自体を自動許可しても exfil は無確認では起きない。

**実装**：既存の autorun の bash 分岐（`checkAutorunPermission`）を再利用する。封じ込め条件成立時は autorun トグルが OFF でも同じ判定を通す。
- `src/security/containment.ts`：`isBashNetworkContained()`（上記条件を判定。security レイヤ内で完結し循環依存なし）。
- `permission-manager.checkCliPermission`：`(this._autorunMode || (toolName==="bash" && isBashNetworkContained()))` で autorun 判定へ。destructive は null 返し→通常 ask へ落ちる既存挙動をそのまま活用。
- 透明性：封じ込め自動許可が初回発火した時に dim で一度通知。

**エスケープハッチ / オプトアウト**：
- `/sandbox off` で封じ込め解除 → 自動許可も止まり通常確認へ戻る。
- 封じ込めは維持しつつ自動許可だけ切りたい場合は `autoAllowBashWhenContained: false`。

**非対象（この段階では従来どおり確認）**：Linux/WSL2 の fs（ネット全開＝未実証。2b-2 後に拡張）、Windows ネイティブ（封じ込め無し）、`network`/`full`（ネット全遮断＝開発が進まないため auto-allow の意味が薄い）。

## §8 既知の限界・トレードオフ

1. ネイティブ Windows は封じ込め非対応（git bash 実行）。封じ込めは WSL2 内起動が前提。
2. 変種2（WSL2 内）で `/mnt/c` を触ると I/O が遅い。成果物を WSL ネイティブ FS に置けば速い。
3. 現状の processSandbox はネット遮断（§7 で2軸化予定）。
4. bwrap/sandbox-exec が無い環境では実効レベル none（警告表示）。
5. 配布：変種2 用に WSL 内で動かす手段（WSL 内で `npm run start`、または Linux ビルド提供）の案内が必要。

## §9 非目標

- クラウド / リモート VM（明示的に除外）。
- Windows ネイティブの AppContainer / Job Object 隔離（Node から扱えず複雑）。
- file_write/edit の隔離化（パススコープ `Sandbox` で別途担保。サンドボックスは bash サブプロセス対象）。

## §10 決定の経緯（履歴）

1. Windows に欠けるハード層を埋めるため、まず **route-to-WSL**（bash だけ `wsl.exe` 経由で WSL に流す）を実装。
2. 実機（Win11+WSL2 Ubuntu）で動作確認（`uname` が `microsoft-standard-WSL2` を返すことを確認）。検証中、118 コミット遅れの旧チェックアウト起動で再現に手間取った教訓あり。
3. 既定を `"auto"` → OFF（opt-in）に修正（汎用環境の安全側）。
4. config 手編集回避のため `/sandbox` 統一コマンドを追加。
5. Claude Code の裏取りで「FS/ネット2軸」「Windows は2種（ネイティブ/WSL内起動）で routing は作らない」が判明。
6. **route-to-WSL を退役**し、Windows 2種モデルへ整理（本設計）。退役前の版をタグ `wsl-phase1-routing` で保全。

## §11 段階計画

| Phase | 内容 | 状態 |
|---|---|---|
| 〜 | route-to-WSL（実装→実機検証→退役） | 完了（タグ `wsl-phase1-routing` で保全） |
| 1 | Windows 2種モデル＋`/sandbox` 統一コマンド（検出案内含む） | ✅ 実装済み（REPL UX は手動 TTY 検証要） |
| 2a | レベル `"fs"`（FS 書込スコープ・ネット許可）追加。`/sandbox on` 既定を fs に＝§7 | ✅ 実装済み（純粋関数をユニットテスト） |
| 2b-1 | macOS: 在プロセス CONNECT プロキシ＋Seatbelt＋対話確認＋`/sandbox allow\|deny`＝§7.1 | ✅ 実装済み・**Seatbelt 封じ込めは実機検証済**（rule `localhost` バグ修正＋統合テスト追加）。対話 UX の TTY 手触りのみ残 |
| 2b-2 | Linux/WSL2: socat ブリッジで bwrap 名前空間からプロキシへ＝§7.1 | 未着手 |
| 3 | 封じ込め時のみ bash 確認を自動許可（確認削減の実体）＝§7.2 | ✅ 実装済み（macOS 先行。破壊的/CWD外/allowlist外は確認維持・オプトアウト可）。TTY 手触り検証のみ残 |
