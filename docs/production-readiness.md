# 製品レベル到達のための改善計画 (Production Readiness Assessment)

> **作成日**: 2026-07-04
> **調査対象**: main ブランチ (914a4f7 時点、src 161ファイル / 約41,000行、テスト71ファイル)
> **目的**: 「開発者の手元で動くアプリ」から「第三者に配布できる製品」へのギャップを洗い出し、改善タスクの元にする
> **基準線**: Claude Code 等の製品エージェントアプリ。機能面の比較ではなく、信頼性・セキュリティ・リリース工学などの製品品質の観点で評価する
> **関連文書**: docs/issues.md (2026-03 の設計書レビュー起点の Issue 一覧)、docs/security_assessment.md、docs/repl-io-robustness.md

---

## 0. 現状評価サマリ

先にできていることを記録する。改善点だけを見て「全部だめ」と誤読しないため。

| 領域 | 現状 |
|---|---|
| 機能 | 設定に応じて登録される30種以上のツール、権限3段階モデル、サブエージェント、スキル、Room、Discord/Slack 連携など機能面は製品級に充実 |
| テスト | vitest 71ファイル。ユニットテストの資産は十分 |
| CI | GitHub Actions あり (ubuntu / macos で型チェック+テスト、Linux は bwrap サンドボックス統合テストまで実行) |
| セキュリティ設計 | security_assessment.md で脅威モデル文書化済み。web_fetch の http/https 限定、危険コマンド検出、OSサンドボックス (Seatbelt/bwrap) など実装済み |
| ログ | ops-logger (~/.localllm/logs/ops/*.jsonl) と LLM I/O ログの2系統が存在 |
| ドキュメント | docs 配下に設計書 70+ 本。設計書駆動の開発文化が定着 |
| セットアップ | 初回セットアップウィザードあり (`--setup`) |

ギャップは「機能」ではなく **「壊れたとき・配るとき・時間が経ったとき」** に集中している。以下、領域別に改善点を列挙する。

---

## 1. 信頼性 — クラッシュ・データ破損への耐性

### [PR-01] グローバル例外ハンドラが無い 【優先度: 高】 — ✅ 実装済み (2026-07-04)

> 実装: `src/utils/crash-handler.ts` (installCrashHandlers/setCrashContext/writeCrashLog)、`src/index.ts` で起動直後に登録。緊急保存→端末復元→`~/.localllm/logs/crash/crash-<ts>.log`→日本語案内→exit 1 を実機確認済み。

**現状**: `src/index.ts` に `process.on("uncaughtException")` / `unhandledRejection` の登録が無い。`main().catch()` は起動時の失敗しか拾えない。

**リスク**: 実行中の未捕捉例外で即死する。そのとき
- 進行中ターンのセッション保存が走らない (保存は `saveCurrentSession()` のターン境界のみ)
- raw mode の端末が壊れたまま残る可能性がある
- ユーザーには生のスタックトレースが出るだけで、報告に使える情報が残らない

**改善方針**:
1. `uncaughtException` / `unhandledRejection` ハンドラを登録し、(a) セッションの緊急保存 → (b) 端末状態の復元 → (c) クラッシュログ書き出し → (d) 平易な日本語の終了メッセージ、の順で後始末する
2. クラッシュログは `~/.localllm/logs/crash/<timestamp>.log` にスタックトレース+バージョン+直近の ops ログ数行を書く。「このファイルを添えて報告してください」と案内する
3. [[feedback_no_silent_loss]] の原則どおり、握りつぶして継続はしない。後始末して明示的に落ちる

### [PR-02] config.json / セッション JSON の書き込みが非アトミック 【優先度: 高】 — ✅ 実装済み (2026-07-04)

> 実装: `src/utils/atomic-file.ts` (writeFileAtomic)。saveConfig/saveSession を移行し、loadConfig は破損時に `.broken-<ts>` 退避→`.bak` 復元→既定値の順でフォールバック (すべて告知)。loadSession もパース失敗を告知して null を返す。破損→退避→.bak 復元の一連を実機確認済み。

**現状**: `saveConfig()` (`src/config/config-manager.ts:75`) と `saveSession()` (`src/agent/session-manager.ts:74`) は `fs.writeFileSync` で直接上書きする。書き込み途中でプロセスが死ぬと (クラッシュ、taskkill、電源断) ファイルが半端な JSON になる。

さらに `loadConfig()` の `JSON.parse` (config-manager.ts:27) は try/catch されておらず、**壊れた config.json があると起動自体が例外で死ぬ**。復旧手段の案内も無い。

**改善方針**:
1. **アトミック書き込み**: 一時ファイルに書いて `fs.renameSync` で差し替える共通ヘルパー (`writeFileAtomic`) を `src/utils/` に作り、config / セッション / usage-store 等の永続化をすべてこれに寄せる
2. **破損時のリカバリ**: `loadConfig()` でパース失敗したら、壊れたファイルを `config.json.broken-<timestamp>` に退避し、「設定が壊れていたので退避しました。`--setup` で再設定してください」と案内して既定値で起動する (黙って既定値にしない — 退避と告知で可視化する)
3. 直前の正常版を `config.json.bak` として1世代残す

### [PR-03] 設定スキーマ検証が無い 【優先度: 中】 — ✅ 実装済み (2026-07-04)

> 実装: `src/config/config-schema.ts` に Config の deep-partial zod スキーマ (検出専用・型チェックのみ) を定義し、`loadConfig()` で検証。型の合わないフィールドだけをピンポイントで取り除き、「どのキーがなぜ無効か」を警告表示 (プロセス内1回)。未知キーは保持する (スキーマ出力を使うと z.object が未知キーを黙って strip するため、元オブジェクトから不正パスだけ削る方式)。roomConfig の手書きサニタイズ (旧 L-4) はスキーマへ統合し、mergeRoomConfig は純粋な既定値マージに簡素化。値の欠落は検証しない (既定値マージと各機能の既存ガードが担う)。リファレンスのスキーマ生成は見送り (検出専用スキーマのため二重管理の負担が小さい)。テスト: `tests/config/config-schema.test.ts` (12ケース)。

**現状**: zod が依存に入っているのに config.json の検証には使われていない。`loadConfig()` はスプレッドマージのみで、roomConfig だけ手書きサニタイズ (L-4) がある。手編集で型の合わない値を入れると、実行時の深い場所で初めて壊れる。

**改善方針**: `Config` の zod スキーマを定義し、`loadConfig()` で `safeParse` する。不正フィールドは既定値に置き換えた上で **警告を表示** する (どのキーがなぜ無効かを平易な日本語で)。roomConfig の手書きサニタイズもスキーマに統合する。docs/config-reference.md と スキーマの二重管理にならないよう、リファレンスはスキーマから生成することも検討する。

---

## 2. セキュリティ — 秘密情報と依存関係

### [PR-04] シークレットが平文 config.json に保存される 【優先度: 高】 — ✅ 実装済み (2026-07-04: 方針1+2+3。方針4 は見送り)

> 実装: 方針1+3 = `hardenFilePermissions` (POSIX chmod 600 / Windows icacls 自ユーザーのみ) を saveConfig で適用、表示系は `src/utils/mask.ts` (maskWebhookUrl) でマスク化。方針2 = `src/config/credentials.ts` で API キー・Bot/App トークン・Webhook URL を `~/.localllm/credentials.json` (権限強制) に分離。読み込み時マージ・保存時分離で config-manager に透過統合し、呼び出し側は従来どおり config.mainLLM.apiKey 等を読み書きするだけ。旧形式 (config.json 内シークレット) は初回 loadConfig で自動分離して告知。credentials.json 破損時は .broken-<ts> 退避+告知 (silent 上書き防止)。imageGen.profiles の apiKey は index 対応 (両ファイルは同一 saveConfig で常に一緒に書かれるため不整合しない)。テスト: `tests/config/credentials.test.ts`。**方針4 (OS キーチェーン) は見送りを確定**: SEA exe にネイティブ依存 (keytar 等) を同梱するコストと、credentials.json + 権限強制で得られる保護の差分が見合わない。組織配布など要件が変わったら再検討。

**現状**: API キー、Discord Bot トークン、Slack トークン (xoxb/xapp) がすべて `~/.localllm/config.json` に平文で入る。ファイルパーミッションの強制 (POSIX 0600) も無い。入力時の `mask: "*"` (repl.ts) はあるが、保存後の保護が無い。

**リスク**: 配布した製品として見た場合、バックアップツール・同期ツール・他ユーザーから秘密情報が読める。トークン漏洩は Bot の乗っ取り (= 任意コマンド実行チャネルの乗っ取り) に直結する。

**改善方針** (段階的に):
1. **即効**: `saveConfig()` で POSIX は `chmod 600`、Windows は `icacls` で自ユーザーのみに制限する
2. **分離**: シークレット類を `config.json` から `~/.localllm/credentials.json` (600 固定) に分離する。config.json は共有・バックアップしても安全な状態にする
3. **表示系の点検**: `/status` `/integrations` `/model` 等でトークンを表示する箇所を洗い出し、`xoxb-***abc` 形式の末尾数文字マスクに統一する
4. OS キーチェーン (Windows Credential Manager / macOS Keychain) 統合は exe 配布と相性を検証してから判断する (SEA バイナリでネイティブ依存を増やすコストと見合うか)

### [PR-05] 依存パッケージに High 脆弱性が放置されている 【優先度: 高】 — ✅ 実装済み (2026-07-04)

> 実装: `npm audit fix` で実行時依存の脆弱性 0 件を確認 (lockfile のみ更新)。CI に `npm audit --omit=dev --audit-level=high` ゲート、`.github/dependabot.yml` で npm/actions の週次セキュリティ更新を追加。devDependencies に esbuild の Low 1件が残るが breaking 更新が必要なため見送り (dev 専用・開発サーバー機能は未使用)。

**現状**: `npm audit --omit=dev` で **High 複数件** (axios: プロキシ資格情報漏洩ほか8件 / form-data: CRLF injection / hono: Windows パストラバーサル / brace-expansion: DoS)。いずれも `npm audit fix` で修復可能な範囲。CI に audit ゲートが無いため、今後も静かに溜まる。

**改善方針**:
1. まず `npm audit fix` を実行して現存分を解消する (lockfile 更新のみで済む見込み)
2. CI に `npm audit --omit=dev --audit-level=high` ステップを追加し、High 以上で fail させる
3. Dependabot (`.github/dependabot.yml`) で週次のセキュリティ更新 PR を自動化する

### [PR-06] Windows の CI が無い 【優先度: 高】 — ✅ 実装済み (2026-07-04)

> 実装: ci.yml マトリクスに windows-latest を追加 (型チェック+テスト+audit)。2026-08-25 にWindows専用 `package-smoke` jobを追加し、`build:deploy`、SEA exe / CJSの `--version`、agent / skill資産、埋込みcommitが`unknown`でないことまで検証する。

**現状**: CI マトリクスは ubuntu / macos のみ。**主開発環境も exe 配布ターゲットも Windows なのに、Windows 経路が CI で一度も検証されない**。git bash 検出、パス区切り、icacls、SEA ビルドなど Windows 固有コードが多いプロジェクトなので、これは基準線とのずれが大きい。

**改善方針**: マトリクスに `windows-latest` を追加する。サンドボックス統合テストは Windows では skip される設計 (WSL 前提) なので、まず型チェック+ユニットテストだけでも回す。余力があれば `npm run build:exe` のスモーク (exe が起動して `--version` を返す) も CI 化する。

---

## 3. 品質保証 — テスト・静的解析

### [PR-07] Lint が型チェックのみで、コード規約の自動強制が無い 【優先度: 中】 — ✅ 実装済み (2026-07-04)

> 実装: @biomejs/biome 2.5 を導入 (`biome.json`: スペース2/幅120/ダブルクォート、vcs.useIgnoreFile=true、sandbox/.localllm 除外、assist=off)。format は 212 ファイルへ一括適用を独立コミットで実施 (blame 汚染を1コミットに隔離)。lint は recommended プリセットで開始し、既存コードで error になった 5 ルール (noControlCharactersInRegex / useIterableCallbackReturn / noShadowRestrictedNames / noAssignInExpressions / noImplicitAnyLet) を biome.json で warn へ明示降格 = 「段階的に締める」対象リストとして可視化。`npm run lint` = tsc + biome check (format 差分はエラーで CI fail)、`npm run format` 追加。警告 242 件/情報 101 件は残存 (今後の縮減対象)。

**現状**: `npm run lint` = `tsc --noEmit`。ESLint / Prettier / Biome が無い。未使用コード、`console.log` 直書き、import 順などは人力レビュー頼み。41,000行の規模では回らない。

**改善方針**: Biome (単体で lint+format、高速、設定が軽い) を導入し、CI に組み込む。既存コードへの一括適用は差分が巨大になるので、(1) format は一括適用を1コミットで実施、(2) lint ルールは error でなく warn から始めて段階的に締める。

### [PR-08] E2E スモークテストが無い 【優先度: 中】 — ✅ 実装済み (2026-07-04)

> 実装: `tests/e2e/mock-llm.ts` (OpenAI 互換モックサーバー、SSE canned response) + `tests/e2e/repl-smoke.test.ts`。HOME/USERPROFILE を一時ディレクトリへ隔離し、`tsx src/index.ts --no-mcp` を非TTYパイプモードで子プロセス起動。シナリオ1=1ターン会話→/quit→exit 0 + セッション永続化確認、シナリオ2=file_write ツール呼び出し→権限確認に数値応答 "1"→実ファイル書き込み→完了報告。モック応答は毎回 `response_complete` を添えてターンを決定的に終了させる (テキストのみ応答だと自己点検/classifier の追加 LLM 呼び出しが走り非決定的になるため)。ユニットテストとの CPU 競合 flake が実測されたため `vitest.e2e.config.ts` で分離・直列実行 (`npm run test:e2e`、CI では全 OS で別ステップ)。なお docs/checkpoint-and-smoke-design.md の `game_smoke` は成果物ゲーム向けで本件とは別物。

**現状**: 71ファイルのテストはユニット中心。「アプリを起動して1ターン会話して終了する」経路を自動で通すテストが無い。REPL には非TTYパイプモードがあり (CLAUDE.md のテスト規約参照)、LLM をモックサーバー (OpenAI 互換の canned response) に向ければ自動化できる素地はある。

**リスク**: repl.ts (6,705行) の変更が起動不能・入力不能などの致命的な退行を起こしても、リリースまで気づけない。実際に Esc 中断・Enter 飲み込み等の入出力バグが繰り返し起きている (docs/repl-io-robustness.md)。

**改善方針**: `tests/e2e/` に「モック LLM サーバー + パイプモード起動 + 1ターン応答 + /quit」の最小スモークを追加し、CI で全 OS 実行する。ツール実行 (file_read 1回) と権限確認 (数値応答) を含む第2シナリオまであれば主要経路を覆える。docs/checkpoint-and-smoke-design.md に既存の構想があれば統合する。

### [PR-09] カバレッジ計測が無い 【優先度: 低】 — ✅ 実装済み (2026-07-04)

> 実装: `@vitest/coverage-v8` 導入、`npm run test:coverage` (text-summary + html を ./coverage に出力、gitignore 済)。2026-08-25 実測は Statements/Lines 35.12%、Branches 76.20%、Functions 58.14%。CI閾値を34/34/75/57に設定し、大幅な低下を停止する。改善に合わせてratchetする。

**現状**: vitest にカバレッジ設定が無い。71ファイルあっても、どこが素通しか分からない。

**改善方針**: `@vitest/coverage-v8` を入れて CI でレポートだけ出す (閾値ゲートは最初は設けない)。まず現状値を可視化し、repl.ts / agent-loop.ts など巨大ファイルの穴を特定する材料にする。

---

## 4. 保守性 — コード構造とドキュメント

### [PR-10] repl.ts (6,705行) / agent-loop.ts (3,233行) の god module 化 【優先度: 中】 — 🔶 レジストリ基盤+実証移設済み (2026-07-04)

> 実装: `src/cli/commands/` に「1コマンド=1ファイル (name/summary/completions/handler)」のレジストリを新設 (`types.ts` / `registry.ts`)。repl.ts の handleCommand は switch の前にレジストリを引き、登録コマンドは新方式でディスパッチ。補完 (completer.ts) と /help (renderer.ts displayHelp) はレジストリから自動合成 → 登録コマンドについて4箇所チェックリストは原理的に不要 (README のみ手動)。実証移設: `/parallel` `/autorun` `/loglevel` の3コマンド (旧 case は削除)。`add-repl-command` スキルを新方式の手順に全面改訂。テスト: `tests/cli/command-registry.test.ts`。**残 (漸進)**: 既存 switch コマンドの移設は「触るついで」に継続。agent-loop.ts の責務分割は未着手 (候補洗い出しから)。

**現状**: 全コマンドのハンドラ・補完・ヘルプが repl.ts に同居している。「新コマンド追加は4箇所を揃える」という人力チェックリスト ([[feedback_new_command_checklist]]) が必要なこと自体が、構造が分散を強制している証拠。

**改善方針**: ビッグバン書き換えはしない。**コマンドレジストリ方式**への漸進移行を提案する:
1. `src/cli/commands/` に「1コマンド=1ファイル (name / help / completer / handler を1オブジェクトで定義)」の構造を作る
2. repl.ts はレジストリを参照するディスパッチャに縮める。ヘルプと補完はレジストリから自動生成 → 4箇所チェックリストが原理的に不要になる
3. 新規コマンドは必ず新方式で追加し、既存コマンドは触るついでに移設する
agent-loop.ts はターン制御・圧縮・介入 (harness-intervention) の責務境界で分割候補を洗い出すところから始める (先に PR-08 のスモークで安全網を張る)。

### [PR-11] docs 70+ 本にライフサイクル管理が無い 【優先度: 中】 — ✅ 実装済み (2026-07-04)

> 実装: `docs/README.md` を索引として新規作成 — 正典 7 本 (external/internal/security/config-reference/workspace-separation/production-readiness/issues) と機能別設計書をカテゴリ分類し、全ファイルに Status (implemented/in-progress/proposal/record/reference/superseded) を付与。**Status は索引で一元管理する方式に変更** (70+ ファイルへのヘッダ一斉付与は差分が巨大で blame を汚すため、各ファイルへのヘッダは触るついでに追加)。運用ルール「新規設計書は索引に1行追加」を索引冒頭に明記。issues.md は 10 件を棚卸し — 9 件解消 (ISSUE-01/03〜10)、ISSUE-02 の一部 (BROWSER-01/PERF-01/CTX-01/WEB-03) のみバックログとして残置し、以後 issues.md は凍結 (新規課題は本ドキュメントか GitHub Issues へ)。

**現状**: docs 配下に設計書が 70 本超あり、`docs/README.md` の索引は追加済み。ただし、各文書が「実装済みの正」「未着手の構想」「廃止済み」のどれかを全件で機械判定できる段階にはない。docs/issues.md の解消済み項目を含め、状態ラベルの継続整備が必要。

**改善方針**:
1. 各設計書の冒頭に status ヘッダを付ける: `Status: implemented | in-progress | proposal | superseded (→後継doc)`
2. `docs/README.md` を索引として作り、正典 (external_design / internal_design / security_assessment / config-reference) と機能別設計書を分類する
3. issues.md の10件を棚卸しし、解消済みはその旨追記、残件は本ドキュメントか GitHub Issues に移行する

### [PR-12] バージョン管理・変更履歴が無い 【優先度: 中】 — ✅ 実装済み (2026-07-04)

> 実装: CHANGELOG.md 導入 (v0.3.0 以降の主要変更を初回ロールアップエントリで開始、以後 Unreleased に追記)。バージョンを 0.4.0 へ bump し `v0.4.0` タグを付与。コミットハッシュは `src/version.ts` の `getAppCommit()` で解決 (優先順: build-exe.js の esbuild define 埋め込み → git rev-parse (dev) → "unknown") し、起動バナー・新設の `--version` フラグ・クラッシュログ (PR-01) に表示。リリース手順: package.json / src/version.ts / CHANGELOG.md を更新 → コミット → `v<version>` タグ → push --tags。

**現状**: version は 0.3.0 のまま大量の機能が積まれている。CHANGELOG が無く、git タグも作業用 (pre-goal-seek-mode 等) のみでリリースタグが無い。配布した exe のバージョンから中身を特定できない。

**改善方針**:
1. CHANGELOG.md を導入し、以後の機能追加・修正を記録する (過去分は v0.3.0 時点からの主要変更をまとめて1エントリで開始)
2. リリース時に semver でバージョンを上げ、`v0.x.y` タグを打つ。deploy ビルドの起動バナー・`--version` にコミットハッシュも埋め込む (build-exe.js で注入)
3. 不具合報告に「バージョン+コミット」が必ず載る状態を作る (PR-01 のクラッシュログにも同情報を含める)

---

## 5. リリース工学 — 配布と更新

### [PR-13] Windows exe が無署名 【優先度: 中】 — ✅ 方針決定・案内整備済み (2026-07-04)

> 決定: **個人配布の範囲では無署名 (macOS は ad-hoc) + 初回警告の案内で運用する**。コード署名証明書 (Windows OV/EV) / Apple Developer ID + notarization は年間コストと管理負担が配布規模に見合わないため、組織配布・不特定多数への公開に進む時点で再判断する。整備: `scripts/deploy-assets/README.md` に SmartScreen (詳細情報→実行、zip のブロック解除) と macOS Gatekeeper (右クリック→開く / xattr -d com.apple.quarantine) の手順を追記、`install.bat` の完了メッセージにも SmartScreen 案内を追加。サポート窓口をリポジトリ URL に更新し、不具合報告に `--version` と `/doctor` を添える運用を明記。

**現状**: macOS は ad-hoc `codesign` (build-exe.js:115) だが、Windows exe は signtool 処理が無い。配布先で SmartScreen 警告が出る。macOS の ad-hoc 署名も他マシンでは Gatekeeper に止められる。

**改善方針**: 個人配布の範囲では自己署名+手順書 (「詳細情報→実行」の案内) が現実解。README/install.bat に初回警告の説明を追加する。組織配布に進むならコード署名証明書 (Windows) / Developer ID + notarization (macOS) を導入する。コストがかかるため、配布規模が決まった時点で判断する。

### [PR-14] 更新の仕組み・通知が無い 【優先度: 低】 — ✅ 実装済み (2026-07-04)

> 実装: `src/utils/update-check.ts` (checkForUpdate)。起動時に GitHub releases/latest を非同期チェック (3秒タイムアウト・await しない) し、semver で新しければ1行通知。オフライン/API失敗/レート制限は黙ってスキップ。**TTY 対話セッションのみ実行** (パイプモード・CI・E2E では走らせない — 出力の決定性とテストごとの API 呼び出しを避ける)。`updateCheck.enabled: false` でオフ (既定 on)。テスト: `tests/utils/update-check.test.ts`。
>
> **リリース手順 (GitHub Releases)**: exe ビルドはユーザーが行う ([[feedback_user_does_deploy_build]])。
> 1. package.json / src/version.ts / CHANGELOG.md のバージョンを揃えて更新しコミット
> 2. `git tag v<version> && git push --tags`
> 3. `npm run build:deploy` で deploy/ を組み立て
> 4. `gh release create v<version> deploy/localllm.exe --title "v<version>" --notes "CHANGELOG.md の該当セクション"`
> リリースを公開すると、旧バージョン利用者には次回起動時に更新通知が出る。

**現状**: deploy フォルダの exe は手動ビルド・手動差し替え。利用者が古いバージョンを使い続けても気づけない。

**改善方針**: 自動更新は過剰。まずは (1) GitHub Releases にビルド成果物を載せる、(2) 起動時に GitHub API で最新リリースタグを非同期チェックし、新しければ1行通知する (オフライン/失敗は黙ってスキップ、チェック自体は設定でオフ可能) の2段で十分。

---

## 6. 運用性 — ログとトラブルシュート

### [PR-15] ログのローテーション・保持期限が無い 【優先度: 中】 — ✅ 実装済み (2026-07-04)

> 実装: `src/utils/log-rotation.ts` (applyLogRetention)。起動時に保持日数超過分を削除 (既定30日)、ログ合計を既定256 MiB以下へ古い順に縮減、セッションJSONは直近100件を保持する。LLM I/Oは機密値をマスクし、requestを差分化し、単一ファイル32 MiBで`log_limit`を残して停止する。config は `logging.retention.{logMaxAgeDays, logMaxTotalMb, sessionMaxCount}` (0で無制限)。削除時は通知し、掃除の失敗は起動を止めない。

**現状**: `~/.localllm/logs/ops/<sid>.jsonl` と LLM I/O ログ、`~/.localllm/sessions/` はセッションごとに増える一方で、削除・上限の仕組みが無い。LLM I/O ログはプロンプト全文を含むため肥大が速い。

**改善方針**: 起動時に軽量な世代管理を走らせる: 既定で「30日より古い ops/LLM ログを削除、セッションは直近100件保持」。上限は config で変更可能にし、削除時は「古いログをN件削除しました」と1行出す (黙って消さない)。

### [PR-16] 環境診断コマンド (`/doctor`) が無い 【優先度: 低】 — ✅ 実装済み (2026-07-04)

> 実装: `src/cli/commands/doctor.ts` (PR-10 のレジストリ方式第1号の新規コマンド)。チェック項目: メインLLM (セッションの復号済み provider で疎通 — 暗号化キー config でも動く)、セカンド/ビジョンLLM (createProvider で疎通、暗号化キーは「検証不可」と区別表示)、Playwright+Chromium (probeBrowserCapability、launch なし)、Discord (users/@me で Bot トークン失効検出)、Slack (auth.test)、画像生成 (設定整合のみ — 課金回避で疎通は /image test へ委譲)、logs サイズ+セッション件数。すべて読み取り専用 (メッセージ投稿等の副作用なし)、各チェック 8 秒タイムアウトで並列実行。E2E: repl-smoke シナリオ3。

**現状**: LLM サーバー不達・Playwright 未導入・Discord トークン失効などの障害は、実際に使おうとして初めてエラーになる。個々の設定コマンドに test サブコマンドは散在するが、一括診断が無い。

**改善方針**: `/doctor` を追加し、LLM 接続 / セカンド LLM / Playwright / Discord / Slack / 画像生成 / ディスク上の logs サイズ を一括チェックして ✔/✖ の表で出す。トラブル報告時に「まず /doctor の結果を貼ってもらう」運用ができるようになる。実装は各 test サブコマンドの内部関数を呼び集めるだけで済む見込み。

---

## 7. 優先度ロードマップ

「壊れたときにデータを失わない・漏らさない」を最優先に置く。

| フェーズ | 項目 | 内容 | 規模感 | 状況 |
|---|---|---|---|---|
| **P1: 守り** | PR-01 | グローバル例外ハンドラ+クラッシュログ | 小 | ✅ 2026-07-04 |
| | PR-02 | アトミック書き込み+config 破損リカバリ | 小 | ✅ 2026-07-04 |
| | PR-04 | シークレットのパーミッション強制+表示マスク統一 | 小〜中 | ✅ 2026-07-04 (方針4は見送り確定) |
| | PR-05 | npm audit fix + CI audit ゲート + Dependabot | 小 | ✅ 2026-07-04 |
| | PR-06 | Windows CI 追加 | 小 | ✅ 2026-07-04 |
| **P2: 品質の網** | PR-08 | E2E スモークテスト (モック LLM+パイプモード) | 中 | ✅ 2026-07-04 |
| | PR-07 | Biome 導入 | 中 | ✅ 2026-07-04 |
| | PR-03 | config の zod 検証 | 中 | ✅ 2026-07-04 |
| | PR-12 | CHANGELOG+リリースタグ+バージョン埋め込み | 小 | ✅ 2026-07-04 |
| **P3: 構造改善** | PR-10 | コマンドレジストリ方式への漸進移行 | 大 (漸進) | 🔶 基盤+3コマンド移設 2026-07-04 |
| | PR-11 | docs 索引+status ヘッダ+issues.md 棚卸し | 中 | ✅ 2026-07-04 |
| | PR-15 | ログローテーション | 小 | ✅ 2026-07-04 |
| **P4: 配布成熟** | PR-13 | 署名方針の決定と初回警告の案内整備 | 小〜中 | ✅ 2026-07-04 (無署名+案内で確定) |
| | PR-14 | GitHub Releases+更新通知 | 中 | ✅ 2026-07-04 |
| | PR-09 | カバレッジ可視化 | 小 | ✅ 2026-07-04 |
| | PR-16 | /doctor | 中 | ✅ 2026-07-04 |

### 実装時の共通ルール

- 各 PR-xx の着手時は、この文書の該当セクションを設計の起点とし、実装との差分が出たらこの文書を更新する (設計書と実装の整合ルール)
- P1 の各項目は独立しており並行実装可能。P2 の PR-08 (スモーク) は P3 の PR-10 (repl 分割) より **先に** 入れる — 安全網なしで god module を触らない
- フォールバック・自動修復を入れる場合は必ずユーザーに可視化する (silent な欠損・変更の禁止)
