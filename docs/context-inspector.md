# コンテキストインスペクタ (`/context` ドリルダウン)

## 目的

`/context` はコンテキスト消費をカテゴリ別 (System prompt / Memory / Skills / Tools /
Messages / Free space) のトークン推定で表示する。しかし「何もしていないのに 5K 使っている」
状態で、その 5K が**具体的に何の文字列なのか**を確認する手段がなかった。

本機能は `/context <section>` 引数でカテゴリの**実際の中身**をダンプし、ユーザーが
気の向いたときにベースライン消費を見直せるようにする。

## コマンド体系

| コマンド | 動作 |
| --- | --- |
| `/context` | 従来どおりカテゴリ別内訳 (`buildContextBreakdown` + `formatContextBreakdown`) |
| `/context system` | システムプロンプトをセクション単位でダンプ。Memory/Skills 部分は専用ビューへ誘導 |
| `/context memory` | プロジェクト指示 + auto-memory の本文、読み込み元ファイル一覧 |
| `/context skills` | 注入中スキルの `trigger: description` 一覧 (有効/無効・builtin/user・トークン) |
| `/context tools` | ツール定義 (JSON) をトークン降順で。名前 + 説明1行 + 推定トークン |
| `/context messages` | system を除く会話履歴をメッセージ単位で。役割・トークン・プレビュー・tool_calls 名 |

エイリアス: `sys`/`prompt`→system, `mem`→memory, `skill`→skills, `tool`→tools,
`msg`/`history`→messages。大文字小文字は無視。未知の section はガイダンスを返す。

## 実装

- `src/cli/context-breakdown.ts`
  - `normalizeContextSection(arg)` — 引数を正規セクション名へ正規化 (未知は `undefined`)
  - `formatContextDetail(agent, skillRegistry, section, cwd)` — section ごとの詳細文字列を生成
  - 内部ヘルパ: `detailSystem` / `detailMemory` / `detailSkills` / `detailTools` / `detailMessages`
  - システムプロンプトの分割は既存の `splitByKnownHeaders` を再利用 (パースの二重化を回避)
- `src/cli/repl.ts` — `case "/context"` で `args[0]` があれば `normalizeContextSection` →
  `formatContextDetail` を呼ぶ。引数なしは従来の内訳表示
- `src/cli/completer.ts` — `/context system|memory|skills|tools|messages` を補完候補に追加
- `src/cli/renderer.ts` — `/help` の `/context` 説明に引数用法を追記

## 設計上の判断

- **本文の重複回避**: `/context system` では Memory / Skills セクションの本文を出さず、
  `/context memory` / `/context skills` へ誘導する。1 つのセクションを 2 つのビューで
  二重に出すと「何が本当の消費か」が分かりにくくなるため。
- **ダンプ量の上限**: `pushBody` が 1 セクション 4000 文字で打ち切り、残り文字数を明示する。
  ターミナル氾濫を避けつつ全量把握の手掛かりは残す。
- **トークンは推定値**: `token-counter.ts` のヒューリスティック (CJK=1, ASCII≈4字/トークン)。
  正確なトークナイザはローカル LLM では入手困難なため内訳と同一基準で統一。
- **messages の全文は出さない**: 履歴そのものなので 1 行プレビュー (160字) に留め、
  全量確認は会話ログ・`/compact`・`/clear` に委ねる。

## テスト

`tests/cli/context-breakdown.test.ts`:
- `normalizeContextSection` — エイリアス正規化と未知/空の `undefined`
- `formatContextDetail` — system/memory/skills/tools/messages 各セクションで期待文字列の存在、
  未知 section のガイダンス
