# CLAUDE.md - lllmAgents

Claude Codeがこのプロジェクトで作業する際のルール。
プロジェクト概要・ビルド手順・アーキテクチャはREADME.mdを参照。

## User Rules (ユーザーとの約束)
- タスクは必ずToDo化してToDoを確認しながら進める
- ToDoには概要レベルの設計思想も構造化して含める
- 機能追加を行う場合はdocs配下に設計書を作成し、設計書と実装の整合性を常に保つ
- 参考資料と成果物を区別し、不要なものをリポジトリに入れない
- アプリ内のファイルアクセスは絶対パスを使う（相対パス禁止）

## ワークスペース構成（docs/workspace-separation.md 参照）
- `src/` — 開発コード。`npm run start` (tsx) で直接実行。Claude はここを直接編集する
- `dist/` — `npm run build` / `npm run build:exe` の出力（gitignore）
- `deploy/` — 配布用フォルダ（exe ベース、手動ビルド）。成果物は gitignore、`scripts/deploy-assets/` から組み立てる
  - 中身: `localllm.exe` + `skills/`(= ビルトイン同梱) + `install.bat` + `install.sh` + `README.md`
  - 組み立て: `npm run build:deploy`（または同等の `build-exe.bat`）
  - 注意: `node build-exe.js` 単独では `dist/` のみ更新で `deploy/` は古いまま。常に `build:deploy` 経由でビルドすること。`build-exe.bat` も内部で `npm run build:deploy` を呼ぶ仕様 (2026-04-25 修正)
- `sandbox/` — 動作検証用。`sandbox/run.bat` / `run.sh` で deploy/localllm.exe を起動
- ユーザー検証成果物（生成 PPTX/XLSX/JSON/画像等）は必ず `sandbox/` 配下に出力する。リポジトリルートに置かない

## ビルトインスキルと ~/.localllm/skills/
- ビルトインスキルのソース: `src/skills/builtin/<name>/SKILL.md`
- スキルローダーは `~/.localllm/skills/` と作業フォルダの `.claude/skills/` / `.localllm/skills/` を見る
- 開発時は Stop フック (`scripts/on-stop.js`) が `scripts/sync-skills.js` を呼び、`src/skills/builtin/` → `~/.localllm/skills/` を差分同期する
- Stop フックは未 push コミットがあれば警告（実装後は必ずpushルールの補助）
- **exe の再ビルドは Stop フックでは行わない**。`npm run build:deploy` を手動で実行

## デバッグ・テスト作業のルール

### 非TTYパイプモード
- パイプモードで実行する場合は、作業開始時にユーザーへ事前宣言する
- REPL対話品質（Q→A応答の対応、UX）はパイプモードでは検証できない。対話品質に関わる変更後は手動TTY確認が必要
- 権限確認の数値: `1`=今回のみ許可、`2`=セッション中常に許可、`4`=拒否、`5`=中止（`3`は永続変更のため禁止）

### 長時間タスク
- 長時間タスクはScheduled Tasks（`mcp__scheduled-tasks__`）で30分ごとにログ確認・追加指示を自動化する
- 確認間隔は処理時間に関わらず30分以下に保つ（詳細: docs/internal_design.md §10）
