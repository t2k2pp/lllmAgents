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
| 機能 | ツール22種、権限3段階モデル、サブエージェント、スキル、Room、Discord/Slack 連携など機能面は製品級に充実 |
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

### [PR-03] 設定スキーマ検証が無い 【優先度: 中】

**現状**: zod が依存に入っているのに config.json の検証には使われていない。`loadConfig()` はスプレッドマージのみで、roomConfig だけ手書きサニタイズ (L-4) がある。手編集で型の合わない値を入れると、実行時の深い場所で初めて壊れる。

**改善方針**: `Config` の zod スキーマを定義し、`loadConfig()` で `safeParse` する。不正フィールドは既定値に置き換えた上で **警告を表示** する (どのキーがなぜ無効かを平易な日本語で)。roomConfig の手書きサニタイズもスキーマに統合する。docs/config-reference.md と スキーマの二重管理にならないよう、リファレンスはスキーマから生成することも検討する。

---

## 2. セキュリティ — 秘密情報と依存関係

### [PR-04] シークレットが平文 config.json に保存される 【優先度: 高】 — 🔶 一部実装済み (2026-07-04: 方針1+3)

> 実装: `hardenFilePermissions` (POSIX chmod 600 / Windows icacls 自ユーザーのみ) を saveConfig で config.json と .bak に適用 (icacls 適用を実機確認済み)。表示系は `src/utils/mask.ts` (maskWebhookUrl) を追加し、`/discord`・`/slack` の status と url 設定時エコーをマスク化 (Bot/App トークンは元から「設定済み」表示のみ)。**残**: credentials.json への分離 (方針2)、キーチェーン統合 (方針4)。

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

> 実装: ci.yml マトリクスに windows-latest を追加 (型チェック+テスト+audit)。Windows で失敗していた既存4テストを整理: `defaultSecretDenyDirs` は POSIX プロファイル専用のため `posix.join` に修正 (全 OS で同一結果)、封じ込め/unix ソケットの3件は POSIX 前提の環境依存テストとして win32 skip を明示。Windows ローカルで 839 passed / 0 failed を確認。exe ビルドスモークは未着手 (P2 以降)。

**現状**: CI マトリクスは ubuntu / macos のみ。**主開発環境も exe 配布ターゲットも Windows なのに、Windows 経路が CI で一度も検証されない**。git bash 検出、パス区切り、icacls、SEA ビルドなど Windows 固有コードが多いプロジェクトなので、これは基準線とのずれが大きい。

**改善方針**: マトリクスに `windows-latest` を追加する。サンドボックス統合テストは Windows では skip される設計 (WSL 前提) なので、まず型チェック+ユニットテストだけでも回す。余力があれば `npm run build:exe` のスモーク (exe が起動して `--version` を返す) も CI 化する。

---

## 3. 品質保証 — テスト・静的解析

### [PR-07] Lint が型チェックのみで、コード規約の自動強制が無い 【優先度: 中】

**現状**: `npm run lint` = `tsc --noEmit`。ESLint / Prettier / Biome が無い。未使用コード、`console.log` 直書き、import 順などは人力レビュー頼み。41,000行の規模では回らない。

**改善方針**: Biome (単体で lint+format、高速、設定が軽い) を導入し、CI に組み込む。既存コードへの一括適用は差分が巨大になるので、(1) format は一括適用を1コミットで実施、(2) lint ルールは error でなく warn から始めて段階的に締める。

### [PR-08] E2E スモークテストが無い 【優先度: 中】 — ✅ 実装済み (2026-07-04)

> 実装: `tests/e2e/mock-llm.ts` (OpenAI 互換モックサーバー、SSE canned response) + `tests/e2e/repl-smoke.test.ts`。HOME/USERPROFILE を一時ディレクトリへ隔離し、`tsx src/index.ts --no-mcp` を非TTYパイプモードで子プロセス起動。シナリオ1=1ターン会話→/quit→exit 0 + セッション永続化確認、シナリオ2=file_write ツール呼び出し→権限確認に数値応答 "1"→実ファイル書き込み→完了報告。モック応答は毎回 `response_complete` を添えてターンを決定的に終了させる (テキストのみ応答だと自己点検/classifier の追加 LLM 呼び出しが走り非決定的になるため)。ユニットテストとの CPU 競合 flake が実測されたため `vitest.e2e.config.ts` で分離・直列実行 (`npm run test:e2e`、CI では全 OS で別ステップ)。なお docs/checkpoint-and-smoke-design.md の `game_smoke` は成果物ゲーム向けで本件とは別物。

**現状**: 71ファイルのテストはユニット中心。「アプリを起動して1ターン会話して終了する」経路を自動で通すテストが無い。REPL には非TTYパイプモードがあり (CLAUDE.md のテスト規約参照)、LLM をモックサーバー (OpenAI 互換の canned response) に向ければ自動化できる素地はある。

**リスク**: repl.ts (6,705行) の変更が起動不能・入力不能などの致命的な退行を起こしても、リリースまで気づけない。実際に Esc 中断・Enter 飲み込み等の入出力バグが繰り返し起きている (docs/repl-io-robustness.md)。

**改善方針**: `tests/e2e/` に「モック LLM サーバー + パイプモード起動 + 1ターン応答 + /quit」の最小スモークを追加し、CI で全 OS 実行する。ツール実行 (file_read 1回) と権限確認 (数値応答) を含む第2シナリオまであれば主要経路を覆える。docs/checkpoint-and-smoke-design.md に既存の構想があれば統合する。

### [PR-09] カバレッジ計測が無い 【優先度: 低】

**現状**: vitest にカバレッジ設定が無い。71ファイルあっても、どこが素通しか分からない。

**改善方針**: `@vitest/coverage-v8` を入れて CI でレポートだけ出す (閾値ゲートは最初は設けない)。まず現状値を可視化し、repl.ts / agent-loop.ts など巨大ファイルの穴を特定する材料にする。

---

## 4. 保守性 — コード構造とドキュメント

### [PR-10] repl.ts (6,705行) / agent-loop.ts (3,233行) の god module 化 【優先度: 中】

**現状**: 全コマンドのハンドラ・補完・ヘルプが repl.ts に同居している。「新コマンド追加は4箇所を揃える」という人力チェックリスト ([[feedback_new_command_checklist]]) が必要なこと自体が、構造が分散を強制している証拠。

**改善方針**: ビッグバン書き換えはしない。**コマンドレジストリ方式**への漸進移行を提案する:
1. `src/cli/commands/` に「1コマンド=1ファイル (name / help / completer / handler を1オブジェクトで定義)」の構造を作る
2. repl.ts はレジストリを参照するディスパッチャに縮める。ヘルプと補完はレジストリから自動生成 → 4箇所チェックリストが原理的に不要になる
3. 新規コマンドは必ず新方式で追加し、既存コマンドは触るついでに移設する
agent-loop.ts はターン制御・圧縮・介入 (harness-intervention) の責務境界で分割候補を洗い出すところから始める (先に PR-08 のスモークで安全網を張る)。

### [PR-11] docs 70+ 本にライフサイクル管理が無い 【優先度: 中】

**現状**: docs 配下に設計書が 70 本超あるが、索引が無く、どれが「実装済みの正」でどれが「未着手の構想」「廃止済み」か外形から判別できない。docs/issues.md (2026-03) も ISSUE-05 (web_fetch スキーム制限) のように実装解消済みの項目が未更新のまま残る。「設計書と実装の整合性を常に保つ」というプロジェクトルールが規模に対してスケールしていない。

**改善方針**:
1. 各設計書の冒頭に status ヘッダを付ける: `Status: implemented | in-progress | proposal | superseded (→後継doc)`
2. `docs/README.md` を索引として作り、正典 (external_design / internal_design / security_assessment / config-reference) と機能別設計書を分類する
3. issues.md の10件を棚卸しし、解消済みはその旨追記、残件は本ドキュメントか GitHub Issues に移行する

### [PR-12] バージョン管理・変更履歴が無い 【優先度: 中】

**現状**: version は 0.3.0 のまま大量の機能が積まれている。CHANGELOG が無く、git タグも作業用 (pre-goal-seek-mode 等) のみでリリースタグが無い。配布した exe のバージョンから中身を特定できない。

**改善方針**:
1. CHANGELOG.md を導入し、以後の機能追加・修正を記録する (過去分は v0.3.0 時点からの主要変更をまとめて1エントリで開始)
2. リリース時に semver でバージョンを上げ、`v0.x.y` タグを打つ。deploy ビルドの起動バナー・`--version` にコミットハッシュも埋め込む (build-exe.js で注入)
3. 不具合報告に「バージョン+コミット」が必ず載る状態を作る (PR-01 のクラッシュログにも同情報を含める)

---

## 5. リリース工学 — 配布と更新

### [PR-13] Windows exe が無署名 【優先度: 中】

**現状**: macOS は ad-hoc `codesign` (build-exe.js:115) だが、Windows exe は signtool 処理が無い。配布先で SmartScreen 警告が出る。macOS の ad-hoc 署名も他マシンでは Gatekeeper に止められる。

**改善方針**: 個人配布の範囲では自己署名+手順書 (「詳細情報→実行」の案内) が現実解。README/install.bat に初回警告の説明を追加する。組織配布に進むならコード署名証明書 (Windows) / Developer ID + notarization (macOS) を導入する。コストがかかるため、配布規模が決まった時点で判断する。

### [PR-14] 更新の仕組み・通知が無い 【優先度: 低】

**現状**: deploy フォルダの exe は手動ビルド・手動差し替え。利用者が古いバージョンを使い続けても気づけない。

**改善方針**: 自動更新は過剰。まずは (1) GitHub Releases にビルド成果物を載せる、(2) 起動時に GitHub API で最新リリースタグを非同期チェックし、新しければ1行通知する (オフライン/失敗は黙ってスキップ、チェック自体は設定でオフ可能) の2段で十分。

---

## 6. 運用性 — ログとトラブルシュート

### [PR-15] ログのローテーション・保持期限が無い 【優先度: 中】

**現状**: `~/.localllm/logs/ops/<sid>.jsonl` と LLM I/O ログ、`~/.localllm/sessions/` はセッションごとに増える一方で、削除・上限の仕組みが無い。LLM I/O ログはプロンプト全文を含むため肥大が速い。

**改善方針**: 起動時に軽量な世代管理を走らせる: 既定で「30日より古い ops/LLM ログを削除、セッションは直近100件保持」。上限は config で変更可能にし、削除時は「古いログをN件削除しました」と1行出す (黙って消さない)。

### [PR-16] 環境診断コマンド (`/doctor`) が無い 【優先度: 低】

**現状**: LLM サーバー不達・Playwright 未導入・Discord トークン失効などの障害は、実際に使おうとして初めてエラーになる。個々の設定コマンドに test サブコマンドは散在するが、一括診断が無い。

**改善方針**: `/doctor` を追加し、LLM 接続 / セカンド LLM / Playwright / Discord / Slack / 画像生成 / ディスク上の logs サイズ を一括チェックして ✔/✖ の表で出す。トラブル報告時に「まず /doctor の結果を貼ってもらう」運用ができるようになる。実装は各 test サブコマンドの内部関数を呼び集めるだけで済む見込み。

---

## 7. 優先度ロードマップ

「壊れたときにデータを失わない・漏らさない」を最優先に置く。

| フェーズ | 項目 | 内容 | 規模感 | 状況 |
|---|---|---|---|---|
| **P1: 守り** | PR-01 | グローバル例外ハンドラ+クラッシュログ | 小 | ✅ 2026-07-04 |
| | PR-02 | アトミック書き込み+config 破損リカバリ | 小 | ✅ 2026-07-04 |
| | PR-04 | シークレットのパーミッション強制+表示マスク統一 | 小〜中 | 🔶 方針1+3 済 |
| | PR-05 | npm audit fix + CI audit ゲート + Dependabot | 小 | ✅ 2026-07-04 |
| | PR-06 | Windows CI 追加 | 小 | ✅ 2026-07-04 |
| **P2: 品質の網** | PR-08 | E2E スモークテスト (モック LLM+パイプモード) | 中 | ✅ 2026-07-04 |
| | PR-07 | Biome 導入 | 中 |
| | PR-03 | config の zod 検証 | 中 |
| | PR-12 | CHANGELOG+リリースタグ+バージョン埋め込み | 小 |
| **P3: 構造改善** | PR-10 | コマンドレジストリ方式への漸進移行 | 大 (漸進) |
| | PR-11 | docs 索引+status ヘッダ+issues.md 棚卸し | 中 |
| | PR-15 | ログローテーション | 小 |
| **P4: 配布成熟** | PR-13 | 署名方針の決定と初回警告の案内整備 | 小〜中 |
| | PR-14 | GitHub Releases+更新通知 | 中 |
| | PR-09 | カバレッジ可視化 | 小 |
| | PR-16 | /doctor | 中 |

### 実装時の共通ルール

- 各 PR-xx の着手時は、この文書の該当セクションを設計の起点とし、実装との差分が出たらこの文書を更新する (設計書と実装の整合ルール)
- P1 の各項目は独立しており並行実装可能。P2 の PR-08 (スモーク) は P3 の PR-10 (repl 分割) より **先に** 入れる — 安全網なしで god module を触らない
- フォールバック・自動修復を入れる場合は必ずユーザーに可視化する (silent な欠損・変更の禁止)
