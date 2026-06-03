# WSL連携サンドボックス設計

> ステータス: **Phase 1 実装・実機検証済み（2026-06-04）** / Phase 2・3 未着手 / 作成 2026-06-03
> 関連: `docs/checkpoint-and-smoke-design.md`（封じ込めと可逆性の設計原則）、`src/security/process-sandbox.ts`、`src/security/permission-manager.ts`

## §1 背景・動機

本質的な狙いは「仮想環境を作ること」ではなく、**エージェントにのびのび開発させたい＝許可確認を減らしたい**ことである。

確認を安全に減らす原理はひとつしかない：**封じ込めが強いほど、確認は安全に減らせる**（containment earns autonomy）。Claude Code のローカル CLI もこの設計で、サンドボックス内の bash は無確認・外に出ようとした時だけ確認する。

現状を確認すると：

| 層 | 中身 | Mac/Linux | Windows |
|---|---|---|---|
| ソフト層 | autorun + パス・サンドボックス（`Sandbox`）。宣言されたパスを許可ディレクトリに限定 | ✅ | ✅ |
| ハード層 | `processSandbox`（bwrap / sandbox-exec）。bash が実際に何をしても書込先・ネットをカーネルで封じ込める | ✅（既定オフ） | ❌ **存在しない** |

ソフト層は「モデルが宣言したパス」しか見ない。`bash` で `npm install` や `curl | sh` を打てば、その中で何が起きるかは素通りする。つまり **Windows で autorun を広げる＝封じ込めではなく「作業フォルダ内だろう」という信頼に乗るだけ**。

Mac/Linux はハード層が既にあるので、autorun を広げても封じ込めで裏打ちできる。**穴は Windows だけ。** そこで本設計は、Windows ユーザーが多くの場合すでに有効化している **WSL の中で、既存の Linux サンドボックス（bwrap/unshare）をそのまま再利用**し、Windows にハード層を与える。新規のサンドボックス実装はほぼ不要で、「bash の実行先を WSL に向ける配線」が主な作業になる。

クラウド/リモート VM は本設計の対象外（明示的に除外）。

## §2 現状の事実（実装調査）

- `src/tools/definitions/bash.ts`：Windows では **git bash（`findGitBash`）→ 無ければ cmd.exe**。WSL は一切経由しない（コード内に WSL/wslpath/`/mnt/c` 処理ゼロ）。非 Windows は `processSandbox.isActive()` の時だけ `wrapCommand` でラップ。
- `src/security/process-sandbox.ts`：`platform()` が `linux`→bwrap/unshare、`darwin`→sandbox-exec、**`win32`→ `none`（no-op）**。
- `src/security/sandbox.ts`：`Sandbox.isPathAllowed` が file_*/glob/grep を許可ディレクトリ（cwd, `~/.localllm`, config.allowedDirectories）に限定。全 OS で有効。
- `src/security/permission-manager.ts`：`autorun` は作業フォルダ内の非破壊操作を自動承認。`AUTORUN_DESTRUCTIVE_PATTERNS`（rm/rmdir/del/dd/git reset --hard 等）と CWD 外参照・広域再帰スキャンは依然ブロック/確認。
- 設定型：`SecurityConfig.processSandbox?: { enabled, level: none|network|full }`（`src/config/types.ts`）。

## §3 設計方針（配置）

`docs/checkpoint-and-smoke-design.md` の原則「モデルが失敗しても効くべきものは深く（core/Hook）」に従う。封じ込めは bash ツール実行経路（core）に置く。

1. **WSL 連携は `bash` ツール限定**。`file_write`/`file_edit` は今まで通り Node が Windows 側で直接実行し、**WSL を経由しない**。
   - 理由：ファイルはどのみち `Sandbox`（パススコープ）で守られている。WSL 越し（`/mnt/c`）への書き込みは 9p 経由で遅く、整合性・実装複雑性の害が大きい。封じ込めたいのは「bash が実際に走らせる副作用」であって、宣言済みのファイル書き込みではない。
2. **「封じ込めが効いている時だけ autorun が bash 確認を省く」連動**を入れる（= 本件の目的そのもの）。
3. **WSL が無い／無効な環境では、従来の git bash 経路へ完全フォールバック**（機能劣化なし）。

## §4 アーキテクチャ

### 4.1 実行経路の分岐（bash ツール）

```
isWindows?
 ├─ no  → 従来通り（processSandbox.wrapCommand or /bin/sh）          ← 変更なし
 └─ yes → WSL 有効 & 検出OK?
          ├─ yes → wsl.exe -d <distro> --cd <winCwd> -- <wrapped>    ← 新規
          │          wrapped = WSL内で ProcessSandbox.wrapLinux(...) 適用
          └─ no  → 従来通り（git bash → cmd.exe）                     ← 変更なし
```

WSL の中は Linux なので、`ProcessSandbox` の Linux 経路（`wrapWithBwrap` / `wrapWithUnshare`）を**そのまま再利用**できる。

### 4.2 WSL 検出（`detectWsl()`、キャッシュ）

- `wsl.exe --status` の exit code で存在確認。
- `wsl.exe -l -q` で default distro 名を取得（config 未指定時）。
- `wsl.exe -l -v` で WSL2 か確認（**WSL2 前提**。WSL1 は namespace 挙動が異なるため検出して従来経路を推奨）。
- 結果はプロセス内キャッシュ（`getGitBash` と同じ遅延初期化パターン）。

### 4.3 パス変換（`toWslPath()`）

- cwd：`wsl.exe --cd <Windows パス>` は Windows パスを受理する（新しめの WSL）。保険として内部で `wslpath -u` 相当の変換も持つ。
- コマンド文字列内の `C:\Users\...` → `/mnt/c/Users/...`。**既存の `convertWindowsPaths`（git bash 用、`\`→`/` のみ）とは別関数**。ドライブレター `X:` → `/mnt/x` のマッピングを行う。
- 誤爆対策：正規表現中の `\`、URL、エスケープシーケンスを変換しない。git bash 版で得た教訓（ドライブレター起点のパスのみ対象）を流用。
- ユニットテスト対象（純粋関数なのでクロスプラットフォームで実行可）。

### 4.4 WSL 内サンドボックスのレベル決定

| WSL distro の状態 | 適用レベル | 隔離内容 |
|---|---|---|
| `bwrap` あり | full | ルート ro-bind + 許可ディレクトリのみ書込可 + ネット遮断 |
| `bwrap` なし / `unshare` あり | network | ネットワーク名前空間隔離のみ |
| どちらも無し | none | 隔離なし（ただし Windows 本体とは別の Linux 空間で実行＝弱い分離は残る） |

- 書込許可ディレクトリ（cwd, `~/.localllm`, allowedDirectories）は **`/mnt/c/...` 形式に変換**して bwrap `--bind` に渡す。
- `bwrap` は WSL ディストロに標準では入っていないことが多い。**`sandbox_info` / `/status` で「bwrap 未導入のため network 隔離どまり。`sudo apt install bubblewrap` で full 隔離可」と案内**する（checkpoint の git 未検出警告と同じ手法）。

### 4.5 設定（config）

`SecurityConfig` に追加：

```ts
wsl?: {
  /** 既定: auto（Windows かつ WSL2 検出時のみ有効）。明示 true/false で上書き */
  enabled?: boolean | "auto";
  /** 既定: WSL の default distro */
  distro?: string;
  /** WSL 内で適用する隔離レベル。既定: full（bwrap 無ければ自動降格） */
  sandboxLevel?: "none" | "network" | "full";
};
```

- `processSandbox`（Mac/Linux）とは**別立て**にする（プラットフォーム別の経路選択であり、混ぜると条件が読みにくい）。ただし WSL 内の隔離適用は `ProcessSandbox` を共用する。
- **既定は OFF（opt-in）**。`enabled` 未指定/`false` は従来経路、`"auto"` は WSL2 検出時のみ、`true` は WSL 検出時に強制。
  - checkpoint は「条件付き既定 ON」にしたが、WSL ルーティングは**それと判断が異なる**。理由：checkpoint は非破壊（裏でスナップショットを足すだけ）だが、WSL ルーティングは **bash の実行先＝使うツールチェーンを変える破壊的変更**で、Windows ネイティブの node/python で開発している人を黙って壊し得る（§6-3）。汎用アプリは「誰の環境でも安全な既定」で出荷し、望む人が設定で有効化するのが正しい。
  - 補強事例：WSL2 ディストロは **Docker Desktop を入れただけで自動生成される**（実機検証時も既定 distro Ubuntu とは別に `docker-desktop` が存在）。「WSL2 が在る＝ユーザーが bash を WSL で動かしたい」ではないため、検出ベースの自動 ON は不適切。

## §4.6 操作 UI — `/sandbox` 統一コマンド（実装済み）

config.json の手編集はハードルが高いため、REPL コマンドで切り替える。重要なのは **OS ごとに別コマンドを作らないこと**：機構は OS で違っても、ユーザーがやりたいことは「bash をハード封じ込めする」で同一。別名コマンドが乱立すると、クロスプラットフォーム利用者の学習コストが上がり、ユーザー同士の助け合い（Win↔Mac で同等操作を指示する）でも混乱する。

そこで **単一の `/sandbox status|on|off`** を用意し、内部で OS ディスパッチする：

| OS | `/sandbox on` の作用 | 設定キー |
|---|---|---|
| Windows | WSL ルーティング有効化（`enabled:"auto"`） | `security.wsl` |
| Mac/Linux | processSandbox 有効化（`level` 既定 full、未導入なら自動降格） | `security.processSandbox` |

- 動的適用：`loadConfig()` は都度ファイルを読むので **WSL 側は次の bash 実行から即反映**。processSandbox 側は `bash.ts` の `getProcessSandbox()` がインスタンスをキャッシュするため、`resetProcessSandboxCache()` を呼んで即反映させる（再起動不要）。
- `status` は OS を問わず「方式／設定値／検出状況／実効状態」を統一フォーマットで表示。`sandbox_info`（モデル用ツール）と整合。
- **OS で異なるリスクは警告で出し分ける**（コマンドと心象は共通、注意書きだけ平台依存）：
  - Windows on：WSL 未検出/WSL1 の注意、ツールチェーン分裂（§6-3）の前提を表示。
  - Mac/Linux on：**ネットワーク遮断**（processSandbox は network/full で network deny ＝ `npm install` 等が通らない）を明示警告。
- 既知の課題（Phase 2/3 で要検討）：processSandbox には「FS 書込のみ制限・ネットワークは許可」レベルが無い。「のびのび開発（確認削減）」には FS スコープ封じ込め＋ネット許可が欲しい場面が多く、現状の network/full（ネット遮断）とは噛み合わない。§5 の autorun 連動を詰める前に、封じ込めレベルの再設計が要る可能性。

## §5 autorun との連動（目的の核心）

封じ込めが裏打ちされて初めて、確認を安全に減らせる。

- **bash が封じ込め下（WSL full/network、または Mac/Linux で processSandbox active）にある時のみ**、autorun での bash 自動承認を広げる。
- ただし `AUTORUN_DESTRUCTIVE_PATTERNS`（削除・`git reset --hard` 等）は封じ込め下でも**ブロックを維持**する。封じ込めは「ホストを守る」だけで、「作業フォルダ内の破壊」は人の意思で行うべきだから（checkpoint と役割分担）。
- 封じ込めが効いていない（none / WSL 無し）時の Windows autorun は、**従来どおり「信頼ベース」であることを明示**する。`/status` と `sandbox_info` に「封じ込め: なし（信頼ベース）／WSL full（封じ込めあり）」を出し、ユーザーが現在地を把握できるようにする。パリティを偽らない。

## §6 既知の限界・トレードオフ（正直に）

1. **file_write/edit は WSL を経由しない** → 封じ込められるのは bash のみ。これは意図的な割り切り（§3-1）。
2. **`/mnt/c` 越しの性能劣化** → WSL2 から Windows FS への I/O は遅い。`npm install` 等を WSL 側で回すと体感で重くなる。
3. **ツール環境の分裂** → WSL の node/python と Windows 側は別物。成果物が web（HTML/JS）なら影響小だが、native binding を含むと「WSL でビルド→Windows で実行」が壊れ得る。利用者がこの分裂を理解している必要がある。
4. **bwrap 不在時は network 隔離どまり** → full 隔離には WSL ディストロへの `bubblewrap` 導入が必要。
5. **WSL 無しユーザー** → 従来の git bash 経路へフォールバック（劣化なし、ハード層は得られない）。
6. **WSL1** → 非対象。検出して従来経路を推奨。

## §7 非目標

- クラウド / リモート VM（明示的に除外）。
- Windows ネイティブの AppContainer / Job Object / 制限トークンによる隔離（Node から扱えず複雑。別案件）。
- file 操作の WSL 経由化（§3-1 の理由により行わない）。
- gameplay 品質の検証（それは `game_smoke` の役割）。

## §8 段階実装計画

| Phase | 内容 | 完了条件 | 状態 |
|---|---|---|---|
| 1 | WSL 検出 + bash を WSL 経由で実行（隔離なし）+ パス変換 + 完全フォールバック | Windows+WSL で `bash` が WSL 内で動き、WSL 無し環境で従来通り動く | ✅ 実装・実機検証済み（2026-06-04: Win11+WSL2 Ubuntu で `uname -a` が `microsoft-standard-WSL2` を返すことを確認） |
| 2 | WSL 内 `ProcessSandbox` 連携（unshare/bwrap）+ レベル自動降格 + 案内 | `sandbox_info` が WSL の実効隔離レベルを正しく表示 | 未着手 |
| 3 | autorun 連動（封じ込め時のみ bash 確認を緩和）+ `/status` 可視化 | 封じ込め下で bash 確認が減り、非封じ込め時は信頼ベースと明示される | 未着手 |

### Phase 1 実装メモ

- 新規 `src/security/wsl.ts`：`detectWsl()`（`wsl.exe --status` / `-l -v`、UTF-16LE デコード、キャッシュ）、`resolveWslRouting()`（純粋関数。platform/検出/設定から経路判定）、`toWslPath()` / `convertWindowsPathsToWsl()`（パス変換）、`buildWslInvocation()`（`--cd` 非依存。`cd '<wslパス>' 2>/dev/null; <変換後コマンド>` を `bash -lc` で実行）。
- `src/tools/definitions/bash.ts`：Windows 分岐で WSL ルーティングを最優先し、無効・未検出時のみ従来の git bash → cmd.exe へフォールバック。
- `src/config/types.ts`：`SecurityConfig.wsl?: WslConfig`（`enabled: boolean|"auto"`、`distro`、`sandboxLevel`）。既定 `"auto"`。
- `src/tools/definitions/sandbox-info.ts`：Windows で WSL 検出状態・bash 実行先・封じ込め状態を表示（Phase 1 検証用）。
- テスト `tests/security/wsl.test.ts`（24 件）：パス変換・distro 解析（NUL 残骸込み）・ルーティング判定・invocation 組み立てを純粋関数として検証（クロスプラットフォーム実行可）。
- **実機検証済み（2026-06-04, Win11 + WSL2 Ubuntu）**：`wsl.exe --status` / `-l -v` の起動・UTF-16LE デコード・distro 解析、ルーティング判定、`bash -lc` 経由実行、`/mnt/c` へのパス変換まで動作確認。bash で `uname -a` が `Linux … microsoft-standard-WSL2`、`$WSL_DISTRO_NAME` が `Ubuntu` を返すことを確認。
  - 検証中の知見: 検証は当初 118 コミット遅れの旧チェックアウト（WSL コード未取り込み）を起動していて再現に手間取った。実機検証時は `npm run start`（src 直実行）か `npm run build:deploy`（exe 焼き直し）を使うこと。`sandbox/run.bat` は常に `deploy/localllm.exe` を起動するため、build:deploy を回さないと旧 exe を踏む。
  - **体感の未確認軸（Phase 2/3 判断前に要確認）**: §6-2 の `/mnt/c` 越し性能（初回は WSL distro コールドスタートで数秒かかる）、§6-3 のツール環境分裂（WSL 側に node/python があるか）。

各 Phase で：パス変換のユニットテスト（純粋関数）、検出の `wsl.exe` モックテスト。実 Windows+WSL の挙動は **手動 TTY 検証**（CI 無しのため）。

## §9 代替案と却下理由

- **A. Windows は trust ベース autorun のまま（ハード層なし）** — ユーザーが封じ込めを望むため不採用。ただし WSL 無し環境では事実上これが挙動になる（フォールバック）。
- **B. Docker Desktop on Windows** — 重く前提が大きい。WSL が「すでに有効」なユーザーには WSL の方が軽い。Docker 自体 WSL2 バックエンドに乗るため、素の WSL で十分。
- **C. Windows ネイティブ隔離（AppContainer 等）** — Node から扱えず実装複雑度が跳ね上がる。費用対効果が悪い。

## §10 推奨

Phase 1〜2（WSL 経由実行＋既存サンドボックス再利用）は、**新規サンドボックス実装ゼロで Windows にハード層を与えられる**ため費用対効果が高い。Phase 3（autorun 連動）が本件の目的（確認削減）を実際に達成する部分。

一方、§6 の限界（特に 2・3 のツール環境分裂と性能）は実利用の満足度を左右するため、**まず Phase 1 を実装して実機の体感を確かめてから Phase 2/3 を判断する**のが安全。いきなり全部作らない。
