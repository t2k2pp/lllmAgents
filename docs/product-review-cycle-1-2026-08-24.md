# 商品品質レビュー・改善サイクル 1

Status: record

- 実施日: 2026-08-24
- 観点: 商品レベルの信頼性、運用性、可観測性、配布品質。特に 2026-08-13 以降の追加機能
- 変更前 commit: `1aed7fa`
- before tag: `product-review-cycle-1-before-20260824`
- after tag: `product-review-cycle-1-after-20260824`（全体評価後の commit に付与）

## 1. 調査範囲と方法

設計書、実装、テスト、CI、配布スクリプト、2026-08-13 以降の8 commit、`~/.localllm/logs/sessions` の JSONL を突き合わせた。実行ログのプロンプト本文は本記録へ転載せず、件数・反復数・エラー署名・容量だけを利用した。

変更前の unit test は 85 files / 1 failed / 81 passed / 3 skipped、1089 tests / 2 failed / 1063 passed / 24 skipped。2件はいずれも Goal Loop の check runner テストが POSIX の `echo ...; sleep ...` を Windows 上で前提にしていたことによる失敗だった。

## 2. 実行ログから分かったこと

2026-07-30 から 2026-08-24 までの41 session、約300.4 MiBを走査した。このうち34件はE2Eが残した `test-model-7b` であり、運用品質KPIから除外して実セッション7件を `scripts/analyze-loop.mjs` で再集計した。

| 指標 | 観測値 | 目標 | 評価 |
|---|---:|---:|---|
| 実ユーザー span | 47 | - | 内部自己点検・test sessionを除外後 |
| 反復数 median | 7 | < 20 | 達成 |
| 反復数 average | 20 | < 25 | 達成 |
| 反復数 p90 | 63 | < 40 | 未達 |
| 反復数 max | 79 | < 80 | 境界内 |
| stuck-loop | 4 / 47 (8.5%) | < 2% | 未達 |
| 累計入力 / 出力 token | 83,444,641 / 384,809 | - | 入力負荷が大きい |

頻出失敗は `file_edit: old_string not found` 28件、`bash: Exit code` 24件だった。`task: Unknown sub-agent type` は `general-purpose` 2件、`explore` 1件があり、配布不具合の発見につながった。

元の分析器はハーネスが `role=user` で注入する自己点検・継続メッセージも実ユーザー要求として数え、E2Eのtest sessionも運用品質KPIへ混ぜ、長時間 span の表へユーザープロンプト抜粋を既定で書いていた。修正後は内部メッセージとtest/mock modelを既定で除外し、抜粋は `--include-prompts` 指定時だけ出す。モデル名・失敗には home path の除去を適用し、stuck-loop は引数値を出さずキー構造だけを記録する。

## 3. 8月13日以降の機能レビュー

| 機能 | 設計・テスト | レビュー結果 |
|---|---|---|
| マルチモデル・オーケストレーション | unit test あり | サブエージェント利用量が共通コスト台帳へ入らない。配布 exe では組み込み agent 定義が欠落する。今回修正 |
| コンテキスト忘却・戦略 | unit test あり | 選択ロジックはテストされているが、長時間実行ログでは p90 と stuck-loop が目標未達。ログ分析の内部 span 誤集計も今回修正 |
| Prompt Gate / Alternate Screen / stdin ownership | ScreenManager unit test あり | 状態遷移テストはあるが、Windows/macOS/Linux の実 PTY・リサイズ・割り込み E2E がない。次サイクル候補 |
| モデル設定の即時反映 | drift unit test あり | `setModel()` が live binding を更新せず、正常に切替済みでも未反映警告を出し得た。今回修正 |
| lockfile 脆弱性対応 | CI audit あり | 直接の回帰は未検出 |

## 4. 発見事項

### 今回修正したバグ

| ID | 優先度 | 症状と原因 | 修正・評価 |
|---|:---:|---|---|
| BUG-01 | P1 | 配布物に `src/agents/builtin/*.md` が入らず、exe で標準 sub-agent が利用不能。esbuild/SEA は Markdown を埋め込まず、deploy は skills のみコピーしていた | deploy と installer に `agents/` を追加し、loader が実行ファイル隣接ディレクトリを探索。回帰テスト追加 |
| BUG-02 | P1 | sub-agent の `done.usage` を捨てており、`/cost` と月次 usage JSONL が実消費を過少表示 | `collectResponse` が usage を保持し、slot・cache semantics 込みで共通台帳へ記録。回帰テスト追加 |
| BUG-03 | P1 | `httpPostStream` が接続拒否・DNS失敗した時、最長2時間の timer と外部 AbortSignal listener が残り、CLI終了を妨げ得る | `finally` と stream finalize で timer/listener を解放。回帰テスト追加 |
| BUG-04 | P1 | Windows の check runner が引用符を含む command を `cmd.exe /c` へ直接渡して無出力終了し、timeout 時は孫プロセスを残す | native shell 経由へ変更し、`taskkill /T /F` で tree を終了。テストをOS非依存化 |
| BUG-05 | P2 | `/model <name>` の即時切替後も live binding が旧 model のままで、設定未反映の誤警告を出し得る | endpoint を保持して binding を再生成。回帰テスト追加 |
| BUG-06 | P2 | `web_fetch` / `web_search` が接続時に reject すると15秒 timer が残る | fetch を `try/finally` 化 |
| BUG-07 | P2 | ループ分析が内部自己点検とE2E sessionを運用品質へ混ぜ、既定レポートへ prompt・home path・tool引数値を載せる | 内部メッセージとtest/mock modelを除外し、prompt 出力を明示 opt-in 化。pathとtool引数をredact |

### 未修正の重要課題

| ID | 優先度 | 課題 | 次の改善案 |
|---|:---:|---|---|
| RISK-01 | P1 | LLM I/O JSONL が全文 messages / tools を各 request で再保存し、39 sessionで約300.4 MiB。保持は日数中心で容量上限がない | 差分イベント化、session/total size cap、圧縮、秘密情報 redaction、移行互換を設計する |
| RISK-02 | P1 | `web_fetch` は `http/https` のみ検証し、localhost・link-local・private network を拒否しない。SSRF境界が sandbox proxy と不統一 | DNS再束縛を含む共通 outbound policy を設計し、redirect ごとに検証する |
| RISK-03 | P1 | CI に実際の `build:deploy` と exe 起動 smoke がなく、BUG-01を検出できなかった | OS別 package job で agent/skill 資産、installer、`--version`、標準 agent load を検証する |
| RISK-04 | P1 | coverage レポートはあるが閾値がなく、既存資料の初期値は statement 30.6% | 重要モジュールから段階的 threshold を設定する |
| RISK-05 | P1 | p90反復63、stuck-loop 8.5%で目標未達。`file_edit` 再試行と command failure が多い | failure guide、同一失敗打切り、編集前再読込、評価指標を改善する |
| RISK-06 | P2 | TUI新機能は mock中心で実PTYの割り込み・resize・非TTY回帰を継続検出できない | node-pty等を分離したOS別E2Eを追加する |
| RISK-07 | P2 | 分析器が巨大 JSONL を `readFileSync().split()` で全量保持する | readline等のstream集計へ変更する |
| RISK-08 | P2 | `external_design.md` 等の一部が実装済み機能を未実装として記述し、正典がずれている | 機能別設計を参照する形に正典を更新する |
| RISK-09 | P2 | `agent-loop.ts` と `repl.ts` が巨大で、最近の状態同期不具合を誘発しやすい | 状態所有権を先に設計し、機能単位で段階分割する |
| RISK-10 | P2 | sub-agent 利用量は可視化できるようになったが、委任前の予算上限 enforcement はない | slot / task 単位の予算と超過時停止を設計する |

## 5. 今回の改善設計

一サイクルで直す範囲を、ログで実害が確認できる配布・課金可視性、終了を妨げる非同期資源、直近機能の状態同期、Windows回帰、評価器の信頼性に限定した。セキュリティ境界やログ形式は互換性と設計判断が大きいため、場当たり的な修正を避けて次サイクルへ残した。

また、同じ進め方を再利用する組み込みスキル `product-quality-cycle` を追加した。次回から「セキュリティの観点でレビュー、修整・改善の設計、実装・評価のサイクルを回して」のように観点を指定できる。

## 6. 修正後評価

- 対象回帰テスト: 7 files / 65 tests passed
- 全 unit test: 87 files中84 passed / 3 skipped、1094 tests中1070 passed / 24 skipped、failed 0
- E2E: 1 file / 3 tests passed
- typecheck / build: passed
- lint: 終了コード0。既存警告283件が残るため、無警告とは評価しない
- Windows deploy build: SEA exe 生成成功、skills 19件・agents 5件を同梱
- 配布 smoke: `deploy/localllm.exe --version` と fallback CJS の `--version` がともに成功。配布 `general-purpose.md` は正本と SHA-256 が一致
- ログ再評価: 実 user span 47、stuck-loop 4件 (8.5%)。分析上の誤集計は直ったが、製品目標2%未満は未達のまま
- スキル: リポジトリ組み込み版と Codex インストール版の SHA-256 一致を確認。Pythonが環境にないため `quick_validate.py` は実行不能で、frontmatter/schemaと配布結果を別手段で検証

## 7. 次サイクルの推奨

最優先は「セキュリティとログ運用の観点」で、RISK-01（ログ容量・機密情報）と RISK-02（SSRF）を同時に扱う。その次にリリース品質として RISK-03 / RISK-04 / RISK-06 を扱う。
