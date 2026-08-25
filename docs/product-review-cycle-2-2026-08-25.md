# 商品品質レビュー・改善サイクル 2

Status: incomplete checkpoint（既存P1を継続せず完了扱いしたため、統合クローズ作業へ継続）

> 2026-08-25 是正: UTF-8修正と評価は有効だが、既存P1を「次回候補」として残した終了判定は誤りだった。未修正項目は `product-review-closure-2026-08-25.md` で同一依頼の継続対象として扱う。

- 実施日: 2026-08-25
- 観点: Codex に類する開発エージェントとしての正しさ、安全性、運用性、UX、配布可能性。特に Windows 上のスキルとシェル出力
- 変更前 commit: `f2d62816124533644f57d3d38b7727e2f8262f6d`
- 完了条件: 対象バグの回帰テスト、全 unit test、E2E、lint/typecheck、build、配布スモークを通し、対象差分だけを commit/push する

## 1. 調査範囲と基準

設計書、実装、テスト、CI、配布スクリプト、直近15 commit、前回レビュー記録、2026-07-30〜2026-08-24 の匿名化済み実行ログ集計を確認した。ログのプロンプト・応答本文は転載していない。

Codex 相当の製品基準として、公式 OpenAI ドキュメントが独立した機能領域として扱う skills、shell、Windows、sandboxing、agent approvals、long-running work を参照した。参照: https://learn.chatgpt.com/docs

作業開始時点で `sandbox/` 配下にユーザー所有の未追跡ファイル群があるため、本サイクルでは変更・stageしない。

## 2. 変更前ベースライン

- 初回 `npm` 実行: PowerShell 実行ポリシーが `npm.ps1` を拒否。製品不具合ではなく環境要因として `npm.cmd` へ切替
- unit test: 87 files 中84 passed / 3 skipped、1094 tests 中1070 passed / 24 skipped、failed 0
- E2E: 1 file / 3 tests passed
- typecheck / build: passed
- lint: exit 0、既存 warning 283件・info 104件
- sandbox 内 Vitest: esbuild がリポジトリ上位を走査して access denied。許可済みのサンドボックス外実行では成功

実行ログは7 session / 47 user span。反復数 median 7、average 20、p90 63、max 79、stuck-loop 4件 (8.5%)。前回以降の新規実セッションはなく、目標 `p90 < 40` と `stuck-loop < 2%` は未達のまま。

## 3. 発見事項と優先順位

### 今回修正するバグ

| ID | 優先度 | 証拠・原因 | 影響 | 修正方針・回帰テスト |
|---|:---:|---|---|---|
| BUG-08 | P1 | `bash` が stdout/stderr の各 `Buffer` を独立して `toString()` する。UTF-8の多バイト文字がチャンク境界を跨ぐと U+FFFD に壊れる | 日本語のスキル、設計書、エラー出力をモデルが誤読し、誤った修正判断につながる | 状態を持つ `StringDecoder` でチャンクを連結し、文字の途中で分割した回帰テストを追加 |
| BUG-09 | P2 | skill loader は `readFileSync(..., "utf-8")` の置換デコードと広い `catch` を使い、不正UTF-8や構文不正を黙って無視する | スキルが一覧から消えても原因・対象ファイルが分からない | UTF-8を fatal decode し、読込・構文エラーをパス付きで警告。日本語/BOM/CRLF/不正バイトの回帰テストを追加 |
| BUG-10 | P2 | 品質サイクルスキルに Windows PowerShell 5.1 の暗黙エンコーディングを避ける規則がない。本サイクル開始時にUTF-8の同スキルが文字化けして再現 | レビュー手順自体を誤読し、品質ゲートや安全条件を落とし得る | `file_read` または UTF-8明示読取を規則化し、文字化けを検出したら解釈前に再読込する |

### 今回残す重要課題

| ID | 優先度 | 課題 | 選外理由・次案 |
|---|:---:|---|---|
| RISK-01 | P1 | LLM I/O JSONL の容量上限・redaction・差分保存が未設計 | 互換性・保持方針を先に設計する必要がある。次回のログ運用サイクル候補 |
| RISK-02 | P1 | `web_fetch` の private/link-local/localhost/DNS再束縛対策が未統一 | redirect/DNS/プロキシを跨ぐ共通 outbound policy が必要。セキュリティ専用サイクル候補 |
| RISK-03 | P1 | CI に実 `build:deploy` と exe 起動 smoke がない | OS別リリースジョブとして設計する必要がある |
| RISK-05 | P1 | stuck-loop 8.5%、p90反復63 | 今回のログは前回修正前の履歴のみ。新実行データを蓄積後に再評価する |
| RISK-06 | P2 | TUI の実PTY・resize・割り込みのOS別E2E不足 | node-pty等のテスト基盤を別サイクルで導入する |
| RISK-11 | P2 | WindowsでGitが標準位置に存在してもPATH外だと、配布ビルドのcommit表示が `unknown` になる | Git探索をbuild/runtimeで共通化し、標準インストール位置も検出する |
| RISK-12 | P2 | tracked project skill `.localllm/skills/demo-skill/SKILL.md` が非UTF-8かつ未完了scaffold | ユーザー所有のプロジェクト拡張なので本サイクルでは変更せず、完成させるか削除する判断を別途行う |

## 4. 改善設計

### 4.1 UTF-8ストリーム境界

`src/tools/definitions/bash.ts` の stdout/stderr ごとに `StringDecoder("utf8")` を1つ保持する。`data` ごとの `write()` は完成した文字だけを返し、プロセス結果確定前に `end()` を一度だけ呼んで末尾をflushする。stream表示と蓄積は同じデコード結果を使い、表示とモデル入力の差を作らない。

### 4.2 スキル読込診断

`SKILL.md` は UTF-8 を正規形式とし、`TextDecoder("utf-8", { fatal: true })` で検証する。不正バイトは置換文字へ化けさせず、そのファイルだけをskipしてパスとUTF-8要件を `stderr` へ出す。frontmatter不正も別メッセージに分ける。他の正常スキルのロードは継続する。

### 4.3 スキル自身の防御

品質サイクルの証拠読取では、Windows上の PowerShell を使う場合に `Get-Content -Raw -Encoding UTF8` を明示する。文字化けの兆候があれば内容を解釈せずUTF-8で再読込する。この規則は非自明なWindows差分だけを追加し、一般的な読取手順は増やさない。

## 5. 修正後評価

- 修正前回帰: 2 files / 4 failure（実装モジュール・export未作成）を確認
- 対象回帰: 2 files / 5 tests passed
- 全 unit test: 89 files中86 passed / 3 skipped、1099 tests中1075 passed / 24 skipped、failed 0
- E2E: 1 file / 3 tests passed
- typecheck / build: passed
- lint: exit 0。既存 warning 283件・info 104件でベースラインから増加なし
- Windows deploy build: SEA exe生成成功、skills 19件・agents 5件を同梱
- 配布 smoke: exe / fallback CJS の `--version` が成功。同梱 `product-quality-cycle` は正本とSHA-256一致、U+FFFD 0件、UTF-8規則あり
- runtime smoke: `~/.localllm/skills` へ差分保護付き同期後、更新スキルをロードし、UTF-8規則あり・U+FFFD 0件を確認
- Codex skill: 変更前正本と一致する既存インストールだけを更新し、正本・Codex・lllmAgents runtime のSHA-256一致を確認
- ログ再集計: 7 session / 47 user span、stuck-loop 4件 (8.5%)。新規実データがないため行動改善の効果は未評価
- `skill-creator` の `quick_validate.py`: Python launcherが環境にないため実行不能。frontmatter/BOM/CRLF/UTF-8はTypeScript回帰テストとruntime loadで代替検証
- 実TTY: シェル内部のストリームデコード変更でREPL描画・入力状態は変更しないため未実施。非TTY E2Eと実配布起動を実施

## 6. commit / push

- 実装 commit: `5f42443` (`fix: preserve UTF-8 across shell and skill loading`)
- レビュー記録・changelog: 本記録を含む文書commit
- push先: `origin/main`
- タグ: 依頼されていないため作成しない
