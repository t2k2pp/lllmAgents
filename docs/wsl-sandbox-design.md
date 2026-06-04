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
| 2b | ネットを allowlist（プロキシ）化。`@anthropic-ai/sandbox-runtime` 採用検討＝§7 | 未着手 |
| 3 | 封じ込め時のみ autorun が bash 確認を省く連動（確認削減の実体） | 未着手（Phase 2b 後） |
