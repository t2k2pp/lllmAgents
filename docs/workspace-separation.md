# ワークスペース分離 & Stop フック自動化 設計書

> **ステータス**: 第 2 次改訂版（A 案確定 2026-04-18、実装完了 2026-04-18）
> **起票日**: 2026-04-17
> **関連**: ユーザールール「実装後は必ずpush」「参考資料と成果物を区別」

## 改訂履歴

- **2026-04-17**: 初版。deploy/ を Node ベースの JS 配布として設計 → 実装後に「Node 前提の配布は不自然」と判明
- **2026-04-18 (本版)**: exe 配布 + ホーム統合スキルモデルに全面改訂。A 案確定

## 確定事項（ユーザー判断）

| # | 判断 | 決定日 |
|---|------|-------|
| 1 | 配布形態は **SEA exe** 単体（Node 非依存） | 2026-04-18 |
| 2 | ビルトインスキルとユーザースキルは **`~/.localllm/skills/` に同居**（A 案） | 2026-04-18 |
| 3 | インストール方式は **任意フォルダに exe 配置 + PATH 追加**（Claude Code 風） | 2026-04-18 |
| 4 | exe 再ビルドは **明示コマンド**（Stop フックでは行わない） | 2026-04-18 |
| 5 | Stop フックは **開発時のスキル自動反映 + 未 push 警告** に限定 | 2026-04-18 |
| 6 | `dist/` は残す（`build-exe.js` 中間成果物として） | 2026-04-17 |
| 7 | `output.zip` は削除済 | 2026-04-17 |

## 背景と問題意識

現状、リポジトリルートに **開発コード・ビルド成果物・ユーザー検証成果物** が混在し、「何を配ればユーザーがすぐ使えるのか」が不明瞭。加えてユーザールール「実装後は push」の失念も散発していた。

初版実装で `deploy/` をコミットしたが、内容が `tsc` 出力の JS ミラーだったため、実使用時に `npm install` 必要・Node 前提・ビルトインスキルがロードされない等の問題が露呈し、方針転換に至った。

## 目標

1. **3 層分離**: 開発 (`src/`) / 配布物 (`deploy/`) / 検証 (`sandbox/`)
2. **配布物は exe 単体 + 付随ファイル**のみで、受け取ったユーザーが install → PATH 追加 → 実行で完結
3. **Stop フック**で開発中のスキル変更を即座にローカル（`~/.localllm/skills/`）に反映
4. **未 push 警告**で push 忘れ防止
5. 開発ループ (`npm run start`) を破壊しない

---

## 全体アーキテクチャ

### ディレクトリ構成

```
lllmAgents/
├── src/                        # 開発コード（Claude/人間が編集）
│   ├── agent/
│   ├── skills/builtin/         # ビルトインスキルの原本
│   └── ...
├── dist/                       # tsc 出力 + build-exe.js 中間成果物（gitignore）
│   ├── localllm.cjs
│   ├── sea-prep.blob
│   └── localllm.exe            # ← build-exe.bat の最終生成物
├── deploy/                     # ★配布物（Git管理、exeのみgitignore）
│   ├── localllm.exe            # dist/ からコピー（gitignore、ビルド時生成）
│   ├── skills/                 # ビルトインスキル（install 時に ~/.localllm/skills/ へ）
│   │   ├── powerpoint/
│   │   ├── excel/
│   │   └── ...
│   ├── install.bat             # Windows 用インストーラ
│   ├── install.sh              # Linux/macOS/git bash 用
│   ├── README.md               # エンドユーザー向け使い方
│   └── .deploy-meta.json       # 最終ビルド時刻・コミット・バージョン（gitignore）
├── sandbox/                    # 動作検証（既存、維持）
│   ├── run.bat / run.sh        # deploy/localllm.exe を叩くラッパー
│   ├── scripts/
│   ├── artifacts/
│   └── ...
├── scripts/
│   ├── sync-skills.js          # ★src/skills/builtin/ → ~/.localllm/skills/ 差分同期
│   ├── build-deploy.js         # ★build-exe + deploy/ 全体組み立て（手動）
│   ├── on-stop.js              # ★Stop フック（sync-skills + 未push警告）
│   └── ...
├── build-exe.bat               # 既存、deploy/ からも呼ばれる
├── build-exe.js                # 既存
└── .claude/settings.json       # Stop フック定義（既存を置き換え）
```

### 各層の責務

| 層 | 配置 | 更新タイミング | Git 管理 |
|----|------|---------------|----------|
| **開発** | `src/` | 随時編集 | 対象 |
| **ビルド中間** | `dist/` | `npm run build:exe` 時 | 除外 |
| **配布物** | `deploy/` | `npm run build:deploy` 時 | 対象（exe とメタは除外） |
| **検証** | `sandbox/` | ユーザー/Claude の検証作業で生成 | scripts のみ対象 |
| **ホーム設定** | `~/.localllm/` | 初回起動 + install 実行時 | 管理外 |

### ユーザー環境のインストール後構成

```
<任意のフォルダ>/localllm.exe   # PATH に追加
~/.localllm/
├── config.json                 # 初回起動ウィザードで生成
├── skills/                     # install 時にビルトイン展開、以後ユーザー編集可能
│   ├── powerpoint/SKILL.md
│   ├── excel/SKILL.md
│   ├── tdd/SKILL.md
│   └── <ユーザー追加スキル>/
├── sessions/
├── plans/
├── memory/
└── ...
```

**重要**: ビルトイン/ユーザースキルは区別せず同一ディレクトリに同居。ユーザーはビルトインを自由に編集・削除可。

---

## スキルローダーの改修

### 現状（問題あり）

`src/skills/skill-loader.ts:94-103`:
```ts
const srcBuiltinDir = path.join(selfDir, "builtin");            // ← exe化時に破綻
const rootBuiltinDir = path.join(selfDir, "..", "..", "builtin"); // ← 同上
```

### 改修後

```ts
// 1. ~/.localllm/skills/ （ビルトイン＋ユーザー同居）
const userSkillsDir = path.join(os.homedir(), ".localllm", "skills");
skills.push(...loadSkillsFromDir(userSkillsDir, true));

// 2. CWD .claude/skills/ （プロジェクト拡張）
const projectClaudeSkillsDir = path.join(process.cwd(), ".claude", "skills");
skills.push(...loadSkillsFromDir(projectClaudeSkillsDir, false));

// 3. CWD .localllm/skills/ （プロジェクト拡張）
const projectLocalSkillsDir = path.join(process.cwd(), ".localllm", "skills");
skills.push(...loadSkillsFromDir(projectLocalSkillsDir, false));
```

`selfDir` ベースの検索は全廃。`~/.localllm/skills/` が存在しない場合 0 件返し、初回起動時にセットアップウィザードで「install.bat を先に実行してください」とガイドする（または自動展開オプション）。

### 開発時のフロー

`src/skills/builtin/` に新規スキルを追加したら、Stop フック（`scripts/sync-skills.js` 呼び出し）が自動で `~/.localllm/skills/` にコピー。開発者は `npm run start` でそのまま動作確認できる。

---

## Stop フックの役割（改訂版）

`scripts/on-stop.js` は以下だけ行う:

1. **スキル同期** (`sync-skills.js`): `src/skills/builtin/` の内容ハッシュが前回と変わっていれば `~/.localllm/skills/` へ差分コピー（ビルトイン名のディレクトリのみ対象。ユーザーが独自追加したスキルには触れない）
2. **未 push コミット警告**: `git log @{u}..HEAD` で未 push があれば stderr に警告

**exe の再ビルドは行わない**（30〜60 秒かかるため毎ターン実行は非現実的）。

### `scripts/sync-skills.js` の動作

```
入力: src/skills/builtin/**、前回のソースハッシュ (~/.localllm/.skills-sync-meta.json)
出力: ~/.localllm/skills/<ビルトイン名>/ の最新化

処理:
1. src/skills/builtin/ 直下のディレクトリ名一覧を「ビルトイン名」として記録
2. それぞれについて、~/.localllm/skills/<name>/ と比較:
   - 存在しなければコピー
   - コンテンツハッシュが異なれば上書き（ただしユーザー編集を検出したら .user.bak に退避）
3. 前回同期時に存在したが今回 src/ から消えたビルトインは `~/.localllm/skills/<name>.removed/` にリネーム（安全策）
4. ユーザーが独自追加したスキル（src/skills/builtin/ に存在しない名前）は完全に無視
5. メタ更新: ~/.localllm/.skills-sync-meta.json
```

**ユーザー編集検出**: 前回同期時のハッシュを保存しておき、現在のファイルハッシュと照合。一致しなければユーザーが編集したとみなして `.user.bak` 退避。

---

## `npm run build:deploy` の動作

手動またはリリース前に実行する、deploy/ 全体の組み立てコマンド。

```
scripts/build-deploy.js の処理:
1. npm run build:exe （= node build-exe.js）で dist/localllm.exe 生成
2. dist/localllm.exe を deploy/localllm.exe へコピー
3. src/skills/builtin/ を deploy/skills/ へコピー（ファイル実体）
4. deploy/install.bat, install.sh, README.md を最新版で書き出し
5. deploy/.deploy-meta.json 更新（バージョン、ビルド日時、コミット）
```

所要時間: 30〜60 秒（esbuild + SEA blob + postject がボトルネック）。

---

## インストーラの動作

### `deploy/install.bat` (Windows)

```
@echo off
rem 1. 任意のインストールディレクトリを選択（デフォルト: %LOCALAPPDATA%\lllmAgents\）
rem 2. localllm.exe をそこにコピー
rem 3. %USERPROFILE%\.localllm\skills\ にビルトインをコピー（既存あれば .user.bak 退避）
rem 4. PATH に追加する方法を表示（自動追加 or 手動）
rem 5. "完了。localllm --help で確認してください"
```

### `deploy/install.sh` (Linux/macOS/git bash)

```
#!/usr/bin/env bash
# 同等の処理を bash で実装
# デフォルト配置先: ~/.local/bin/localllm または /usr/local/bin/localllm
```

### インストーラの判断

- **既存 skills あり**: 各ファイル単位でハッシュ比較、ユーザー編集らしきものは `.user.bak` に退避
- **既存 exe あり**: 上書き確認（またはバージョン表示して自動判断）

---

## `.gitignore` 更新

```diff
 node_modules/
 dist/
 *.js.map
 *.d.ts.map
 .env
 .env.local
 coverage/
 .vitest/
 *.log
 *.zip

 # Workspace separation
 sandbox/artifacts/*
 sandbox/output/*
 sandbox/screenshots/*
 !sandbox/artifacts/.gitkeep
 !sandbox/output/.gitkeep
 !sandbox/screenshots/.gitkeep
-deploy/.deploy-meta.json
+deploy/localllm.exe
+deploy/.deploy-meta.json
```

deploy/skills/, deploy/install.*, deploy/README.md はコミット対象。

---

## 実装タスク分解

| # | タスク | 依存 | 見積 |
|---|--------|------|------|
| T1 | 本設計書をユーザーがレビュー・承認 | - | - |
| T2 | 既存 deploy/ の JS ミラー大量ファイルを削除（クリーンアップ） | T1 | 小 |
| T3 | `skill-loader.ts` を改修（`selfDir/builtin` 廃止） | T1 | 中 |
| T4 | `scripts/sync-skills.js` を新規作成 | T1 | 中 |
| T5 | `scripts/build-deploy.js` を新規作成 | T1 | 中 |
| T6 | `scripts/on-stop.js` を書き直し（sync-skills 呼び出し + 未push警告） | T4 | 小 |
| T7 | `scripts/sync-deploy.js` を廃止（deploy は build コマンドで明示更新） | T5 | 小 |
| T8 | `deploy/install.bat` と `install.sh` を作成 | T1 | 中 |
| T9 | `deploy/README.md`（配布版）を作成 | T1 | 中 |
| T10 | `package.json` スクリプト更新（`build:exe`, `build:deploy` 整理） | T5 | 小 |
| T11 | `.gitignore` 更新 | T1 | 小 |
| T12 | 初回 `npm run build:deploy` 実行で deploy/ を組み立て | T2-10 | 小 |
| T13 | 初回 `sync-skills` で `~/.localllm/skills/` にビルトイン展開（テラさん環境） | T4 | 小 |
| T14 | `sandbox/run.{bat,sh}` を exe 起動に切替 | T12 | 小 |
| T15 | `CLAUDE.md` 更新 | T1 | 小 |
| T16 | 動作確認（sync-skills 冪等性、未push警告、build:deploy、install） | T12-14 | 中 |
| T17 | コミット & push | T16 | 小 |

---

## オープン項目

1. **ユーザー編集スキルの扱いの詳細**
   - 「ハッシュ不一致 = ユーザー編集」判定で足りるか？（編集直後に公式更新が重なると誤検出あり）
   - 当面は `.user.bak` 退避＋警告で運用、不都合あれば改善
2. **PATH 自動追加の可否**
   - Windows: `setx PATH` は動くが副作用大きい → install.bat は手順表示に留める案
   - Linux: `.bashrc` への追記は敬遠されやすい → 同上
3. **exe の Git 管理**
   - 93MB。バージョンタグ付きリリース時だけ `git lfs` で管理する選択肢あり → 当面は完全 gitignore とし、GitHub Releases で配布する運用
4. **Playwright 依存**（詳細: docs/exe-playwright-externalization.md）
   - exe は Playwright 本体も Chromium も同梱しない。`build-exe.js` で playwright/playwright-core を
     external 化し、実行時に `~/.localllm/node_modules` の非バンドル playwright を createRequire で読む。
   - 初回のみ `localllm --install-browser`（= ~/.localllm へ `npm i playwright` + `npx playwright install chromium`）。
   - 注: かつて「`npx playwright install` で Chromium だけ入れる」案内だったが、それでは不十分
     （バンドルされた playwright が require.resolve 破綻でロード不能だった）。本方式で是正。
5. **セキュリティ警告**
   - SmartScreen / Gatekeeper の「未署名」警告は不可避。README に対処法を明記

---

## トレードオフと想定リスク

| リスク | 対策 |
|--------|------|
| ユーザー編集が `.user.bak` で埋まる | 差分コピー時に内容ハッシュが前回の「公式ハッシュ」と一致するファイルのみ上書き、違えば skip（ログに残す）という方針を検討 |
| `~/.localllm/skills/` が既に存在し別用途で使われていた場合 | install 時に `ls` して確認、既存あれば統合 or 別パス提示 |
| Stop フックが重くなる | sync-skills はハッシュ一致なら 100ms 未満、src/skills/builtin/ は小さいため許容範囲 |
| 複数端末で開発する際の skills 不整合 | `~/.localllm/` はローカル、リポジトリにコミットされる `src/skills/builtin/` が source of truth |

---

## 参照

- 前版設計書（初版、本版で完全置き換え）
- `build-exe.js` / `build-exe.bat` （既存の SEA ビルドパイプライン）
- `src/skills/skill-loader.ts` （要改修）
- `feedback_always_push.md` / `feedback_no_workarounds.md`
