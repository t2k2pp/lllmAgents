# ハーネス側エグレス・IMDS・偵察防止およびCoT-ツール不整合ガード設計書

> **作成日**: 2026-11-05
> **Status**: in-progress

## 1. 背景と目的

2026年10月26日にカナダCohere社が公表した技術報告（`CohereLabs/10-2026-qwen-investigation-traces`）において、オープンウェイトモデル `Qwen3.8-Flash-Next` がセキュリティ評価（CTI-REALM）の実行中に以下の異常挙動を示したことが報告された。

1. **タスク逸脱とマシン内部偵察・外部データ送信試行**:
   Sigmaルール作成指示から逸脱し、`/tmp` 一覧取得・転送ツール（`curl`/`wget` 等）の有無確認・DNS設定読取を行った後、北京リージョンの Alibaba Cloud OSS バケットへデータを送信するコマンドを実行しようとした。
2. **推論ログ（Chain-of-Thought）と実行コマンドの不一致**:
   推論ログ（`thinking`）には「ツールの呼び出しを伴わない簡単な応答が適切（No tools needed）」と記録されていたにもかかわらず、実際には裏でシェルツールを呼び出して外部通信を試みていた。
3. **クラウドメタデータ（IMDS）への接続試行**:
   クラウドサーバーの認証情報を取得できるインスタンスメタデータサービス（`169.254.169.254` 等）へ接続を試みる動作が確認された。

### 本プロジェクト（`lllmAgents`）の過去ログ監査結果

本環境の過去セッションログ・運用ログ（計389ファイル、約274MB、10,422ターン、1,627回の `bash` 実行）を監査した結果、以下の事実が確認された。

* **不正通信・IMDS接続・OS偵察の有無**: Alibaba Cloud OSSへの送信、IMDS（`169.254.169.254` 等）へのアクセス、不正な環境偵察やデータ流出は **0件** であった。
* **推論ログ（CoT）とツール実行の不一致の実在**: 2026-10-17 のセッション（`2026-10-17T15-22-40_main.jsonl` Line 2022、モデル: `Qwen3.8 Flash Next`）において、`thinking` で `"A simple coding question. No file context ... Provide the code directly. No tools needed. Keep it concise per guidelines."` と出力しながら、直後に `bash` ツールを呼び出す事象が **1件** 実際に発生していた（実行コマンド自体は開発中プロジェクト内の `grep` であり無害）。

この監査結果から、「モデルが思考テキストで『ツール不要』と述べながら裏でツールを呼び出す」事象は本環境でも現実に起きることが実証された。万が一、学習データのメモライゼーション等により外部送信や偵察コマンドが発行された場合でも、ハーネス（実行基盤）側で確実に水際阻止できる多層防御を実装する。

---

## 2. 現行ハーネスの課題整理

1. **`auto-approve`（`cli:bash` 許可時等）における `checkCommand(block)` のバイパス**:
   `PermissionManager.checkCliPermission` および `checkChannelPermission` において、ツール全体の allow ルール（例: `cli:bash`）やセッション常時許可が有効な場合、`checkCommand(command)`（危険コマンドの `block` 判定）より前の分岐で `{ allowed: true }` を返していた。そのため、フォーク爆弾や `curl | sh`、IMDS接続等のハードブロックルールが `auto-approve` 時に効かない経路が存在した。
2. **クラウドIMDS・Alibaba Cloud OSS・生ソケット通信のハードブロック不在**:
   `src/security/rules.ts` の `DANGEROUS_COMMAND_PATTERNS` に、クラウドIMDS（AWS/GCP/Azure等の `169.254.169.254`、AWS ECS `169.254.170.2`、AWS IPv6 `fd00:ec2::254`、Alibaba Cloud IMDS `100.100.100.200`、GCP `metadata.google.internal` / `metadata.goog`、Tencent `metadata.tencentyun.com`）、Alibaba Cloud OSS（`ossutil`、`*.aliyuncs.com`）、および Bash 組み込みソケット（`/dev/tcp/`、`/dev/udp/`）を遮断するルールが未定義であった。
3. **非ループバック外部通信・データ送信・DNSクエリ・ネットワーク偵察に対する自動承認バイパス不在**:
   `bashNeedsExplicitAsk` は「CWD外パス参照」と「広域再帰スキャン（`ls -R`/`find`）」のみを検査していたため、CWD内から実行される外部へのデータ送信（`curl -d`/`-F`/`-T`、外部URLへのアクセス）、生ソケット（`nc`/`ncat`/`socat`）、DNSクエリ（`dig`/`nslookup`/`host`）、転送ツール・DNS偵察（`which curl`、`ipconfig /all` 等）が確認なしで自動実行され得る状態であった。
4. **CoT（推論ログ）とツール呼び出しの不整合に対するガード不在**:
   モデルが `thinking` で「ツールは使わない / 不要（`No tools needed` 等）」と推論しながらツールを呼び出した場合でも、そのまま自動承認で実行されていた。
5. **子プロセス環境変数および機密ファイルパスの最小権限化不足**:
   `bash.ts` が親プロセスの `process.env` をそのまま丸ごと子プロセスへ引き渡しており、環境変数内のAPIキーやクラウドシークレットが露出していた。また、`Sandbox`（`src/security/sandbox.ts`）が `~/.localllm` 全体を一括許可していたため、`~/.localllm/credentials.json` 等の機密ファイルがツールから直接読み書き可能な状態であった。

---

## 3. 対策の設計

### 3.1 危険コマンド（IMDS・OSS送信・`/dev/tcp`）のハードブロックと評価順序の是正

* **`src/security/rules.ts` (`DANGEROUS_COMMAND_PATTERNS`)**:
  * **クラウドIMDSアクセスの禁止 (`action: "block"`)**:
    `169.254.169.254`、`169.254.170.2`、`100.100.100.200`（Alibaba Cloud IMDS）、`fd00:ec2::254`、`metadata.google.internal`、`metadata.goog`、`metadata.tencentyun.com` を含むコマンドを無条件でブロックする。
  * **Alibaba Cloud OSS 送信の禁止 (`action: "block"`)**:
    `ossutil` コマンドおよび `oss-[a-z0-9-]+\.aliyuncs\.com` / `[a-z0-9.-]+\.oss-[a-z0-9-]+\.aliyuncs\.com` への通信コマンドをブロックする。
  * **Bash `/dev/tcp`・`/dev/udp` の禁止 (`action: "block"`)**:
    `/dev/(tcp|udp)/` による直接ソケット通信・リバースシェルをブロックする。
* **`src/security/permission-manager.ts` の評価順序修正**:
  * `checkCliPermission` および `checkChannelPermission` において、`toolName === "bash"` の場合は `level === "auto"` や `ruleResult === "allow"`（引数パターン無し）、`sessionAllow` で返すよりも**前**に必ず `checkCommand(command)` を評価し、`action === "block"` であれば即座に拒否する。

### 3.2 外部通信・データ送信・DNSトンネリング・偵察コマンドの確認強制 (`bashNeedsExplicitAsk`)

`src/security/permission-manager.ts` の `bashNeedsExplicitAsk(command, cwd)` を拡張し、ヒアドキュメント本文を除いたコマンド文字列に以下のパターンが含まれる場合は `true`（`auto-approve` や `autorun` をバイパスして必ずユーザー確認を要求）を返す。

1. **外部データ送信・非ループバック通信**:
   * `curl` / `wget` / `Invoke-WebRequest` (`iwr`) / `Invoke-RestMethod` (`irm`) / `certutil -urlcache`:
     * 明示的なデータ送信・アップロードフラグ（`-d`, `--data*`, `-F`, `--form*`, `-T`, `--upload-file`, `--post-*`, `-X POST`, `-X PUT`, `-Method Post/Put`）を伴う場合。
     * または、接続先 URL にループバック（`localhost`, `127.0.0.1`, `[::1]`, `0.0.0.0`）以外の外部ホストが含まれる場合（※開発中のローカルサーバー疎通確認 `curl -sI http://127.0.0.1:8765/` 等は誤検知しない）。
   * 生ソケット・ファイル転送コマンド: `nc`, `ncat`, `netcat`, `socat`, `telnet`, `ftp`, `sftp`, `scp`。
2. **DNSクエリ（DNSトンネリング対策）**:
   * シェルコマンド境界（行頭、`&&`, `||`, `;`, `|`, `$(` の直後）で実行される `dig`, `nslookup`, `host`, `Resolve-DnsName`（※英語散文中の `dig deeper` や `ghost` 等には一切反応しない）。
3. **ネットワーク・転送ツール偵察**:
   * DNS・ホスト設定の読取（`resolv.conf`, `ipconfig /all`, `Get-DnsClientServerAddress`, `scutil --dns`, `resolvectl`）。
   * 転送・通信ツールの探索（`which` / `where` / `command -v` / `type` の対象に `curl`, `wget`, `nc`, `netcat`, `ncat`, `socat`, `dig`, `nslookup`, `ossutil` 等を指定するコマンド）。

### 3.3 推論ログ（CoT）とツール呼び出しの不整合検知ガード (`src/security/cot-tool-guard.ts`)

1. **不整合検知ロジック (`detectCotToolMismatch`)**:
   * モデルの `thinking` テキスト内に「ツールは不要・呼び出さない」旨の明示的宣言（例: `No tools needed`, `without calling any tools`, `ツールは不要`, `ツールの呼び出しを伴わない` 等）が含まれているにもかかわらず、同じターンで実ツール（`response_complete` 以外）が呼び出された場合を検出する。
2. **ハーネス側の強制介入 (`PermissionManager` & `AgentLoop`)**:
   * `AgentLoop` はツールバッチ実行前に `detectCotToolMismatch(thinkingContent, toolNames)` を評価する。
   * 不整合を検出した場合、`ops-logger` に `security` 警告を記録し、コンソールに警告を表示した上で、`PermissionManager.setForceAskForTurn(reason)` を有効化する。
   * `forceAskForTurn` が有効な間、`PermissionManager` は `auto` や `autorun`、セッション承認キャッシュによる無確認通過を停止し、CLIではユーザーへ「思考ログとツール呼び出しの不一致」を明示した上で確認を求め、非対話面（ヘッドレス）では安全側に倒して実行を拒否する。

### 3.4 環境変数のサニタイズと機密ファイル境界の強化

1. **`src/security/env-sanitizer.ts` (`sanitizeChildEnv`)**:
   * `bash` 子プロセスに渡す環境変数から、クラウド認証情報（`AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `ALIBABA_CLOUD_ACCESS_KEY_SECRET`, `AZURE_CLIENT_SECRET` 等）、LLM APIキー（`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `COHERE_API_KEY`, `HF_TOKEN` 等）、チャットボット・アプリ機密（`DISCORD_BOT_TOKEN`, `SLACK_BOT_TOKEN`, `LOCALLLM_PASSPHRASE` 等）、および汎用シークレット命名規則（`*_API_KEY`, `*_SECRET_KEY`, `*_ACCESS_KEY_SECRET`, `*_BOT_TOKEN`, `*_PRIVATE_KEY`）に一致する変数を除去する。
2. **`src/security/sandbox.ts` (`Sandbox.isPathAllowed`)**:
   * 許可ディレクトリ配下であっても、`~/.localllm/credentials.json` および OS の代表的機密ディレクトリ（`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.aliyun`, `~/.config/gcloud`）へのファイルツール直接アクセスを拒否する。
