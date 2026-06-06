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

実装順：土台（allowlist 照合＋既定リスト＝実装済み）→ **2b-1（macOS・実機検証済み）** → **2b-2（Linux・🧪実験的/WSL2 実機未検証）**。

**2b-2 実装メモ（Linux/WSL2）**：
- proxy は TCP(127.0.0.1)に加え **unix ソケット**でも待ち受ける（`ensureUnixSocket`）。bwrap の `--unshare-net` 名前空間からはホスト TCP loopback に届かないため、 ソケットを名前空間内へ bind-mount して橋渡しする。**unix ソケット経路の allowlist 判定は macOS 実機でテスト済み**（`sandbox-proxy.integration`）。
- `buildBwrapAllowlistArgs`（純粋・単体テスト済み）：`--unshare-net` ＋ writeDir bind ＋ 機密 tmpfs ＋ ソケット bind（/tmp マスク回避のため tmpfs の後に配置）＋ 名前空間内ラッパ `ip link set lo up; socat TCP-LISTEN:port,...,bind=127.0.0.1 UNIX-CONNECT:socket & <cmd>; 後始末`。子の `HTTP(S)_PROXY=127.0.0.1:port`（bash.ts 注入）で proxy 経由を強制。
- 必要ツール：`socat` と `ip`。無い環境（`canEnforceLinuxNetAllowlist()` が false）では従来どおり fs=ネット許可とし、 `/sandbox status`・`sandbox_info` が「allowlist 未強制（socat と ip が必要）」と明示。
- **fail-closed**：ブリッジ構築に失敗した場合は fs でも `--unshare-net` で**ネット全遮断**に倒す（全開に落とさない）。
- **未検証**：bwrap/`--unshare-net`/lo 起動/socat の実ランタイム挙動は macOS では確認不能。WSL2(Ubuntu) 実機での疎通確認が必要（`npm install` が allowlist 経由で通り、 `curl --noproxy https://1.1.1.1` が遮断されること等）。route-to-WSL と同じく実装→実機検証の順で進める。
- **Phase 3 連動は当面 macOS 限定**（`isBashNetworkContained` は macOS のみ true）。Linux の allowlist 強制が WSL2 実機で確認できたら Linux にも自動許可を拡張する。

**セキュリティ4役レビュー反映（レッド/ブルー/ホワイト/パープル）**：macOS のネット/FS 封じ込め（直結/DNS/UDP/ICMP/SSRF/rebinding/IDN/任意ポート遮断・writeDir 限定・symlink realpath・機密 deny）は実機で堅牢と再確認。是正:
- **【Critical】force push 検出の追加回避**：`git push origin +main`（refspec の `+`＝force）と `git -c k=v push --force`（`-c` 挿入で `git`直後`push` 前提の正規表現を回避）がすり抜けていた。→ `destructive-commands.ts`/`rules.ts` を**語順非依存＋refspec `+` 対応**に修正。
- **【High】自アプリ機密 `~/.localllm` が封じ込め対象外**：クラウド LLM の API キー(config.json)・会話履歴(sessions)・チェックポイントがサンドボックス内 bash から**読取可、 かつ writeDir で改ざん可**、 許可ドメイン(gist 等)へ exfil 可能だった。→ (1) `~/.localllm` を bash の writeDir から除外（改ざん防止）、(2) 読取遮断（`computeSecretProtection`）。ただし `skills/` は SKILL スクリプト実行のため **allow-back**（macOS=deny 後に allow file-read を last-match-wins、 Linux=tmpfs 後に ro-bind 戻し）。macOS 実機で「config.json は読めず skills は読める」を検証。**脅威モデルの機密資産に `~/.localllm`(+`.netrc`/`.config/git` 検討) を追加**。
- **【High→明記】許可ドメイン経由 exfil**：設計書 §7.2 の「外部送信は必ず確認」を「**未許可ドメインのみ確認・許可ドメイン経由 exfil は残存リスク**」へ正確化（上記 §7.2 参照）。
- **【Med】download-exec 回避**：`curl | sudo sh` / `bash <(curl …)`（プロセス置換）/ 他インタプリタへのパイプを `rules.ts` の block に追加。
- **【Med】Phase 3 副作用の可視化**：`/sandbox on`(fs) 時に「bash 確認が自動許可される」旨を警告表示（W-3）。
- **【Med】可観測性（B-3）実装**：proxy が今セッションで実際に中継した宛先ホストを記録（`getRelayedHosts`・内部IP遮断を通過した接続のみ）し `/sandbox status`・`sandbox_info` に表示。exfil 先の事後監査が可能に。**非TTY でも出力に残るため B-2（パイプ実行時の不可視）も同時に解消**。
- **【B-2 判断】非TTY での Phase 3**：自動許可を非TTY で無効化すると、 逆にパイプ/委任実行で全 bash が確認待ち→停止し自動化が壊れる。封じ込め自体は同等に効く（機密 deny 強化済）ため**挙動は変えず**、 上記 B-3 監査で観測可能にする方針。厳格にしたいユーザーは `autoAllowBashWhenContained: false`。
- **【R-4 不可】大容量 exfil のヒューリスティック確認**：HTTPS は CONNECT トンネル＝TLS 非終端で body も byte 数も観測不能。サイズ閾値確認は技術的に不可。B-3 の「中継先可視化」で代替（どこへ出たかは把握できる）。
- 受容（明記済の残存）：インタプリタ経由の cwd 内破壊（`node -e` 等）、許可ドメイン自体への持出（中身は見えないが宛先は B-3 で記録）。

**2b-2 レビュー反映（06a2840 直後・Linux 知見の机上レビュー）**：骨格（unshare-net + ソケット bind + socat + fail-closed）は正しいと確認。修正したもの:
- **【Critical】socat readiness レース**：socat が listen する前に最初のリクエストが走ると `ECONNREFUSED` で非決定的に失敗するため、 bridge に「socat へ接続確認できるまで最大 ~5s 待つ」ループを追加。
- **【Med（共有機で High）】unix ソケット権限**：`/tmp` は全ユーザー書込可で他ユーザーの踏み台になりうるため、 listen 後に `chmod 600`。
- **【Med】既定 allowlist の過剰ワイルドカード削減**：`*.pypi.org`・`*.yarnpkg.com` は不要（`pypi.org` 完全一致・`registry.yarnpkg.com` で足りる）ため削除。攻撃面を縮小。
- **WSL2 実機で要確認（未検証）**：unprivileged userns 有効性／`ip link set lo up` が namespace 内で通るか／dash(`/bin/sh`)でユーザーコマンドの bash 固有構文が壊れないか／直結遮断（`curl --noproxy https://1.1.1.1` が失敗）／allowlist 経由疎通（`npm install` 成功）／未許可ドメイン 403。

**既定 allowlist の現実性（QA 指摘 H1/H2 反映）**：既定を `*.npmjs.org`/`*.yarnpkg.com`/`*.pythonhosted.org`/`pypi.org`/`*.pypi.org`/`github.com`/`codeload.github.com`/`*.githubusercontent.com`/`nodejs.org` に拡張し、 registry リダイレクト・CDN・git submodule・node prebuilt を既定でカバー。ただし prebuilt バイナリを S3/Azure 等の**ベンダー固有 CDN**から取るもの（playwright/electron/esbuild 等）は無数にあり既定化しない方針＝**初回に対話確認（TTY）/ `/sandbox allow`（非TTY）** で都度許可する。これは「のびのび」と最小権限の妥協点。

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
- **proxy ライフサイクル**：実効レベルから停止/維持を判断する単一窓口 `reconcileSandboxProxy()`（active-sandbox.ts）に集約し、`/sandbox on|off|level 変更`の後に呼ぶ（fs かつ強制可能環境のみ proxy を維持、 それ以外は停止。 起動は bash 実行時の遅延起動）。`/sandbox deny` で `proxy.revoke()`（セッション once 許可の残存通過を防止）。
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

⚠️ **TTY 非依存**：上記を満たせば**非TTY（パイプ/委任実行）でも bash は自動許可される**（`isBashNetworkContained` は TTY を見ない）。非TTY で自動許可を切ると全 bash が確認待ちで停止し自動化が壊れるため意図的。未許可ドメイン通信だけは非TTY で fail-closed deny。中継先は B-3 監査で出力に残る。厳格にするなら `autoAllowBashWhenContained: false`。

**維持する確認（自動許可しない）**：
- **破壊的コマンド**（`destructive-commands.ts` の `isDestructiveCommand`: rm / 上書き / git reset --hard / git checkout -- / force push / chmod -R / 実デバイス書込 等）→ 通常の確認フローへフォールバック。
- **危険コマンド**（既存 `checkCommand` の block ルール）→ 従来どおりブロック。
- **明示 ask ルール**（`security.rules.ask` 等にマッチ）→ 自動許可せず確認（ゲート条件 `ruleResult !== "ask"`）。
- **CWD 外参照・広域再帰スキャン**（`bashNeedsExplicitAsk`）→ 確認。
- **allowlist 外ドメインへの通信** → 実行時にプロキシ（`onUnknownDomain`）が対話確認。
  ⚠️ ただし担保されるのは**未許可ドメインへの送信のみ**。**許可ドメイン（既定 gist/github/npm/pypi 等）経由の exfil は確認されない**（TLS 非終端＝中身は素通し・§6/§7.1 の残存リスク）。「外部送信は必ず確認」ではなく「未許可ドメインへの送信は確認」が正確。許可ドメインを踏み台にしたデータ持出は Phase 3 自動許可下では無確認で通りうる（脅威モデル上の受容リスク）。

**実装**：既存の autorun の bash 分岐（`checkAutorunPermission`）を再利用する。封じ込め条件成立時は autorun トグルが OFF でも同じ判定を通す。
- `src/security/containment.ts`：`isBashNetworkContained()`（上記条件を判定。security レイヤ内で完結し循環依存なし）。
- `permission-manager.checkCliPermission`：`(this._autorunMode || (toolName==="bash" && isBashNetworkContained())) && ruleResult !== "ask"` で autorun 判定へ。destructive は null 返し→通常 ask へ落ちる既存挙動をそのまま活用。`ruleResult !== "ask"` により明示 ask ルールは自動許可されない。
- 透明性：封じ込め自動許可が初回発火した時に dim で一度通知。

**エスケープハッチ / オプトアウト**：
- `/sandbox off` で封じ込め解除 → 自動許可も止まり通常確認へ戻る。
- 封じ込めは維持しつつ自動許可だけ切りたい場合は `autoAllowBashWhenContained: false`。

**非対象（この段階では従来どおり確認）**：Linux/WSL2 の fs（ネット全開＝未実証。2b-2 後に拡張）、Windows ネイティブ（封じ込め無し）、`network`/`full`（ネット全遮断＝開発が進まないため auto-allow の意味が薄い）。

**Phase 3 セキュリティレビュー反映（df52cbf 直後）**：基幹の fail-closed（proxy 失敗時ネット全遮断・非TTY deny・deny/ask 優先・オプトアウト・`enabled:false`→level none）は堅牢と確認。指摘で修正したもの:
- **【Critical】force push のすり抜け**：`AUTORUN_DESTRUCTIVE_PATTERNS`(削除済) に force push が無く、 rules.ts の block も語順固定で `git push -f origin main` 等を取りこぼし、 さらに github.com は既定 allowlist のためドメイン確認も出ず、 remote 履歴を**無確認破壊**できた。→ 破壊判定を単一ソース `src/security/destructive-commands.ts` へ統合し force push（任意ターゲット）を確認へ。rules.ts の block 正規表現を語順非依存・`-f`/`--force-with-lease` 対応に修正。
- **【High】破壊判定リストの分裂**：permission の自動許可ゲートが使うリストに `git checkout --|.`・`chmod -R`・`git clean` 等が無く、 bash.ts の別リストとも乖離していた。→ 正典リストに集約（両者が同一ソースを参照）。
- **【Med】フォークボム正規表現の不発**：`/:()\s*\{/` は `()` がメタ文字で実物 `:(){ :|:& };:` に不一致だった。→ `\(`/`\)` をエスケープして修正。
- **残存リスク（文字列ベース検出の本質的限界・明記）**：`node -e 'fs.rmSync(...)'` / `python3 -c 'shutil.rmtree(...)'` / `sed -i` / `base64 -d | sh` のような**インタプリタ経由・難読化された破壊や任意コード実行**は文字列検出では捕捉しきれない。ただし封じ込めにより FS 破壊は writeDir(cwd 等) 内に限定され、 ネット送信は proxy の allowlist 確認を経る。**封じ込めで守れない不可逆操作は git 履歴/作業ツリー破棄・remote force push・許可済みドメインからの取得→実行**であり、 前2者はパターンで確認へ落とす。これらインタプリタ難読化は完全防御不能と割り切り、 ここに記録する。
- **L（軽微・据え置き）**：`getSandboxProxy()!=null` ガードは REPL では常に非null のため実質 level 判定が効いている（意図は将来 "proxy が fs 用に強制中" の明示 API 化で堅くする）。ゲートは `loadConfig`(毎回 disk) で都度 `ProcessSandbox` 生成、 bash.ts はキャッシュ instance のため、 config 外部編集時に理論上のずれ窓がある（`/sandbox` 操作経由なら両更新）。

## §7.2.1 可視化・UX（W1/W2/W3 リーン実装）

封じ込めを「安心して自走させる信頼の仕組み」にするための最小 UX。既存の状態を活かす:
- **W1 育てる allowlist**：`/sandbox status`・`sandbox_info` に「今セッションで一時許可(once)した先」を出し `/sandbox allow <domain>` で恒久化を促す（`SandboxProxy.getSessionAllowedHosts`）。
- **W2 封じ込め HUD**：プロンプト脇に常時インジケータ `🛡<level>·auto`（封じ込め有効時のみ・`sandboxHudTag`）。今 bash がどこまで自走してよいか一目で分かる。
- **W3 セッションサマリ**：`/sandbox status` に「bash 自動許可 N 回 / 遮断ドメイン M件」（`PermissionManager.getContainmentAutoAllowCount`・`SandboxProxy.getBlockedHosts`）。封じ込めの実績を信頼の根拠に。

## §7.3 運用・障害復旧（引き継ぎ向け）

- **proxy がハング/応答しない**：在プロセス設計のため REPL の event loop に影響しうる。`/sandbox off` で `proxy.stop()`（listen 解放）→ 必要なら REPL 再起動。終了時は `saveBeforeExit` で `getSandboxProxy()?.stop()` を呼ぶ。
- **socat 子プロセスの孤児（Linux）**：`socat ... fork` の子は親 kill で落ちないことがある。bwrap の `--new-session`＋namespace teardown で最終的に回収されるが、 残る場合は `pkill -f 'lllm-proxy'` 等。
- **一時成果物の残骸**：`$TMPDIR/lllm-sandbox-*`（Seatbelt プロファイル）・`$TMPDIR/lllm-proxy-<pid>.sock`（unix ソケット）。**起動時に `cleanupStaleSandboxArtifacts()` が pid 生存チェック付きで掃除**（生きているプロセス・自プロセスのものは残す）。SIGKILL 時は cleanup callback が走らず残るが次回起動で回収。
- **socat/ip 不足（Linux）**：`/sandbox on` 時にその場で黄色警告（allowlist 未強制＝ネット全開）。`sudo apt install socat iproute2` で解消。
- **CI**：`.github/workflows/ci.yml` で ubuntu/macos の matrix。Linux runner は bwrap/socat/iproute2 を入れて bwrap FS 隔離の統合テストを実走（`process-sandbox.bwrap.integration.test`）、 macOS runner は Seatbelt 統合テストを実走。socat ネットブリッジ(2b-2)の実走検証は WSL2 実機が引き続き必要。

## §8 既知の限界・トレードオフ

1. ネイティブ Windows は封じ込め非対応（git bash 実行）。封じ込めは WSL2 内起動が前提。
2. 変種2（WSL2 内）で `/mnt/c` を触ると I/O が遅い。成果物を WSL ネイティブ FS に置けば速い。
3. ネット allowlist の強制には OS 機能が要る：macOS=sandbox-exec、Linux=bwrap+socat+ip。不足時は fs でもネット全開（status で「未強制」と明示）。
4. bwrap/sandbox-exec が無い環境では実効レベル none（警告表示）。Linux `full` で bwrap 無し時は `unshare` があれば `network` へ降格（none ではない。`getEffectiveLevel`）。
5. 配布：変種2 用に WSL 内で動かす手段（WSL 内で `npm run start`、または Linux ビルド提供）の案内が必要。
6. ドメインフロンティング（CONNECT は SNI を見ない）・許可ドメイン自体への exfil（Gist 等）・インタプリタ難読化による破壊は脅威モデル上の残存リスク（TLS 非終端の割り切り・§7.1/§7.2）。
7. ~~`network` レベルの FS 挙動に OS 差~~ → **解消済み**：`buildSeatbeltProfile` を修正し、 FS 隔離は `fs`/`full` のみ・`network` は file-write 全許可（FS 開放）に。macOS/Linux とも `network`=ネットのみ隔離で揃えた（あるべき論＋Claude Code の独立2軸に一致）。

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
| 2b-2 | Linux/WSL2: socat ブリッジで bwrap 名前空間からプロキシへ＝§7.1 | 🧪 **実験的・未検証（実機検証前は信用しない）**。コードと純粋関数テストは有るが bwrap/socat/lo up/dash の実ランタイムは **WSL2 実機未検証**。proxy unix socket 部分のみ macOS で検証。socat/ip 不足時は fs=全開（警告表示）・構築失敗時は fail-closed 全遮断 |
| 3 | 封じ込め時のみ bash 確認を自動許可（確認削減の実体）＝§7.2 | ✅ 実装済み（macOS 先行。破壊的/CWD外/allowlist外は確認維持・オプトアウト可）。TTY 手触り検証のみ残 |
