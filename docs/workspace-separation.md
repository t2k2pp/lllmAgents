# ワークスペース分離 & Stop フック自動化 設計書

> **ステータス**: 実装中（ユーザー承認済 2026-04-17）
> **起票日**: 2026-04-17
> **関連**: ユーザールール「実装後は必ずpush」「参考資料と成果物を区別」

## 確定事項（ユーザー判断 2026-04-17）

1. **`deploy/` は Git 管理する** — リリーススナップショットとしての価値を優先
2. **`dist/` は残す** — `npm run build` / `build-exe.bat` との互換性維持
3. **`output.zip` は削除** — 用途不明のため
4. **Stop フック方式で運用開始** — 問題があれば後日修正

## 背景と問題意識

現状、本プロジェクトのルートは **開発コード・ビルド成果物・ユーザー検証成果物** が混在しており、以下の実害が出ている。

| 問題 | 具体例 |
|------|--------|
| デプロイ対象が不明瞭 | `dist/` が長期間更新されず放置（`package.json` の `main` が `dist/index.js` を指すが、実運用は `tsx src/index.ts`） |
| 検証成果物のリポジトリ混入 | ルート直下に `extract_ppt_data.py`, `extracted_ppt_data.json`, `redesign_ppt_v{1,2,3}.py`, `output/`, `screenshots/`, `output.zip` など |
| 開発物とユーザー生成物の境界不明 | スキル開発で生成したサンプル PPTX/XLSX がルートに散乱 |
| リモート push 忘れ | ユーザールールで "実装後は push" と定めているが、CLAUDE 側でたびたび失念（`feedback_always_push.md` に記録） |

## 目標

1. **3 層分離**: 開発 / デプロイ / 検証 を物理的に別ディレクトリへ
2. **自動同期**: ソース変更後、Claude Code の応答終了タイミングで deploy 側を自動更新
3. **push 忘れ防止**: 同タイミングで未 push コミットを検知してリマインド
4. **既存ワークフロー不破壊**: `npm run start` (src 直実行) の即時反映ループは維持

## 非目標

- 自動 push の実行（暴発リスクが高いため警告に留める）
- `dist/` の完全廃止（互換性のため残す）
- ユーザー検証成果物のバージョン管理

---

## 全体アーキテクチャ

### ディレクトリ構成（提案後）

```
lllmAgents/
├── src/                        # 開発コード（従来通り）
│   ├── agent/
│   ├── skills/builtin/
│   └── ...
├── dist/                       # tsc ビルド出力（従来通り、ncc/pkg 連携用）
├── deploy/                     # ★新設: 配布用スナップショット
│   ├── index.js                # dist/index.js のコピー
│   ├── skills/                 # src/skills/builtin/ のコピー
│   ├── package.json            # 依存関係のみ抽出（devDeps除外）
│   ├── README.md
│   └── .deploy-meta.json       # 最終同期日時・ソースcommit hash
├── sandbox/                    # ★新設: 動作検証用ワークスペース
│   ├── run.bat / run.sh        # deploy/ を参照して起動するラッパー
│   ├── scripts/                # PPT/Excel 等の検証スクリプト退避先
│   │   └── ppt/
│   │       ├── extract_ppt_data.py
│   │       └── redesign_ppt_v3.py
│   ├── artifacts/              # 生成物（PPTX, XLSX, JSON出力）
│   ├── output/                 # 従来のoutput/を移設
│   ├── screenshots/
│   └── .gitkeep
├── scripts/
│   ├── sync-deploy.js          # ★新設: src → deploy 同期
│   ├── on-stop.js              # ★新設: Stopフックエントリポイント
│   ├── reset-sandbox.js        # ★新設: sandbox 初期化（任意）
│   └── ...
├── .claude/
│   └── settings.json           # ★更新: Stopフック定義追加
└── .gitignore                  # ★更新: sandbox/artifacts 等を除外
```

### 各層の責務

| 層 | 配置 | 更新タイミング | Git 管理 |
|----|------|---------------|----------|
| **開発** | `src/` | ユーザー/Claude が随時編集 | 対象 |
| **デプロイ** | `deploy/` | Stop フック（差分時のみ） | 対象（スナップショット） |
| **検証** | `sandbox/` | ユーザー/Claude が検証作業で生成 | 除外（`.gitkeep` のみ） |
| **ビルド中間** | `dist/` | `npm run build` 明示実行時 | 除外（既に） |

---

## 同期ロジック（`scripts/sync-deploy.js`）

### 入出力

- **入力**: `src/` の現在状態、前回同期時のソース内容ハッシュ（`deploy/.deploy-meta.json.sourceHash`）
- **出力**: `deploy/` 配下の更新、`.deploy-meta.json` 更新

### 処理フロー（実装版）

```
1. src/** + package.json + README.md + tsconfig.json を走査して
   sha1 コンテンツハッシュ (sourceHash) を算出
2. 前回メタの sourceHash と一致 → no-op 終了（約250ms）
3. 不一致 → 以下を実行:
   a. npx tsc で dist/ を再生成
   b. dist/** を deploy/ にミラー（マップ/exe/sea-* 除外）
   c. src/skills/builtin → deploy/skills-assets にコピー
   d. package.json の devDependencies を除去して deploy/package.json に書き出し
   e. README.md コピー
   f. .deploy-meta.json に {syncedAt, commit, sourceHash, node} を記録
```

**hash 方式を採用した理由**: commit hash 比較だと作業ツリーが dirty な間は毎 Stop フックで再同期が走る（5秒 × 毎ターン）。コンテンツハッシュなら「実際に保存されたファイルが変わったとき」だけ同期する。

### パフォーマンス目標

- 差分ゼロ判定: 50ms 以内（git diff のみ）
- 通常同期（数ファイル変更）: 500ms 以内
- フル再同期: 5秒以内

### 冪等性

- 同じ hash で複数回呼ばれても no-op
- 途中失敗時は `.deploy-meta.json` を更新しない（次回リトライで回復）

---

## Stop フック設計

### `.claude/settings.json` の追加内容

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node scripts/on-stop.js"
          }
        ]
      }
    ]
  }
}
```

### `scripts/on-stop.js` の処理

```
1. プロジェクトルートを CWD として確定
2. git rev-parse で現在コミット取得
3. git diff --quiet HEAD -- src/ で作業ツリーの変更確認
4. deploy/.deploy-meta.json の hash と HEAD を比較
5. いずれか差分あり → sync-deploy.js を spawn（同期実行）
   - 結果を stdout へ 1 行サマリ（例: "✓ deploy synced (3 files, 240ms)"）
6. git log @{u}..HEAD --oneline で未 push コミット確認
   - 1件以上 → stderr へ警告（例: "⚠ 2 unpushed commits on main — run: git push"）
7. 全体で exit 0（Claude のターン継続を妨げない）
```

### エラーハンドリング

- 同期失敗時: stderr にエラー出力、exit 0（ブロックしない）
- git コマンド不在/非 git ディレクトリ: サイレント終了
- タイムアウト: スクリプト内で 5 秒上限を設定

### ループ防止

- Claude が hook 出力を受けて続行することがある → スクリプトは**冪等**かつ**出力を最小限**に
- 同期後は `.deploy-meta.json` の hash が HEAD と一致するため、次回 Stop では no-op

---

## sandbox の使い方

### 作業ルール

- PPT/Excel/PDF などの検証スクリプトは `sandbox/scripts/<用途>/` 配下に置く
- 生成物は `sandbox/artifacts/` へ出力する（ルート直下に出力しない）
- `output/`, `screenshots/` は `sandbox/` 配下へ移設
- sandbox 内のファイルは gitignore されるため、長期保存したいものは別途コミット対象ディレクトリに移す

### 既存ファイルの移設

| 現在の場所 | 移設先 |
|-----------|-------|
| `extract_ppt_data.py` | `sandbox/scripts/ppt/extract_ppt_data.py` |
| `extracted_ppt_data.json` | `sandbox/artifacts/extracted_ppt_data.json` |
| `redesign_ppt.py` / `redesign_ppt_v{2,3}.py` | `sandbox/scripts/ppt/` |
| `output/` | `sandbox/output/` |
| `screenshots/` | `sandbox/screenshots/` |
| `output.zip` | 削除（用途不明なら） or `sandbox/artifacts/` |
| `test-vision.mjs` | 要確認（テストコードなら `tests/` へ、検証用なら sandbox へ） |

### CLAUDE.md への追記

「ユーザー検証成果物は `sandbox/` 配下に置く。リポジトリルートに検証ファイルを生成しない」を User Rules に追加。

---

## `.gitignore` 変更

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
-screenshots/
-output/
 *.zip

+# Workspace separation
+sandbox/**
+!sandbox/.gitkeep
+!sandbox/run.bat
+!sandbox/run.sh
+!sandbox/scripts/
+!sandbox/scripts/**
+deploy/.deploy-meta.json

 # Local settings
 .claude/settings.local.json
```

※ `sandbox/scripts/` は再利用前提なので残す（`feedback_keep_generate_scripts.md` に整合）。`artifacts/`, `output/`, `screenshots/` は除外。

---

## 実装タスク分解

| # | タスク | 依存 | 見積 |
|---|--------|------|------|
| T1 | `docs/workspace-separation.md` レビュー&承認 | - | - |
| T2 | `scripts/sync-deploy.js` 実装 | T1 | 中 |
| T3 | `scripts/on-stop.js` 実装 | T2 | 小 |
| T4 | `.claude/settings.json` に Stop フック追加 | T3 | 小 |
| T5 | sandbox ディレクトリ作成 + ルート散乱ファイル移設 | T1 | 中 |
| T6 | `.gitignore` 更新 | T5 | 小 |
| T7 | `sandbox/run.bat` / `run.sh` ラッパー作成 | T2 | 小 |
| T8 | `CLAUDE.md` に sandbox 運用ルール追記 | T5 | 小 |
| T9 | 初回 `sync-deploy.js` 実行で `deploy/` を初期化 | T2 | 小 |
| T10 | 動作確認（Stop フック発火、差分同期、push 警告） | T1-9 | 中 |

---

## トレードオフ・オープン項目

### 採用した選択

- **Stop フック一本化** vs PostToolUse 逐次同期 → Stop 採用（無駄が少ない）
- **警告のみ** vs 自動 push → 警告のみ（暴発リスク回避）
- **sandbox gitignore** vs コミット → gitignore（ユーザー検証物はリポジトリ外）
- **差分コピー** vs フル再同期 → 差分（初回のみフル）

### 未決事項（ユーザー判断が欲しい箇所）

1. **`deploy/` を Git 管理するか**
   - (A) 管理する: リリースタグで配布可、レビューで差分追跡可能、ただしリポジトリサイズ増
   - (B) gitignore: サイズ抑制、ただし "ビルドしないと動かない" 状態
   - **推奨: (A)** （スナップショットとしての価値）

2. **旧 `dist/` の扱い**
   - (A) そのまま残す: `npm run build` 用、ncc/pkg 連携を温存
   - (B) `deploy/` に統合して廃止
   - **推奨: (A)** （既存 `build-exe.bat` との互換性）

3. **`output.zip` の処分**
   - 用途不明。削除 or sandbox 退避の判断をユーザーに委ねる

4. **Stop フック遅延許容**
   - 同期に数百 ms 掛かる → ユーザー体感でどこまで許容するか
   - 許容できない場合は `PostToolUse` で非同期化する代替案あり

### 想定リスク

| リスク | 対策 |
|--------|------|
| Stop フックが毎ターン遅延する | 差分ゼロ早期 exit、5秒タイムアウト |
| 同期中に再度 Stop が呼ばれる | `.deploy-meta.json` の hash で冪等化 |
| Windows/Unix 間のパス差異 | `path.join` 徹底、改行コード注意 |
| Hook がサイレント失敗 | 初回実装時に `--verbose` モードでログ出力確認 |

---

## 参照

- `CLAUDE.md` 「参考資料と成果物を区別し、不要なものをリポジトリに入れない」
- `feedback_always_push.md` 「実装後は必ず push」
- `feedback_keep_generate_scripts.md` 「生成スクリプトは残す」
- Claude Code Hooks 仕様（`Stop` イベント）
