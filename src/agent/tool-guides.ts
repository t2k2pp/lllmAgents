/**
 * ツール初回使用時に注入するガイドテキスト（段階的開示）
 *
 * システムプロンプトの肥大化を防ぐため、 詳細なガイドはツール初回使用時にツール結果へ
 * 付加する形で遅延注入する。 1 つのツールに対して複数のガイドが該当しうるため、
 * 「ツール → ガイドキー配列」 のマッピングで管理し、 まだ使われていないガイドだけを
 * 連結して返す。
 *
 * 関連: `docs/prompt-tech-debt-review.md` ID-001 の §2 と §4 (2026-04-30 実施)
 *
 * Phase B-3 (2026-05-07): tier 引数を追加。 T3 (7B local) では主要ツールの
 * few-shot 例を初回使用時に追加注入する。 docs/multi-tier-harness-roadmap.md §4 D-3 参照。
 */

import type { Tier } from "./capability-tier.js";

/** ガイドキー → ガイドテキスト本体 */
const GUIDE_TEXTS: Record<string, string> = {
  secondLLM: `[ガイド: セカンドLLMの使い方]
- second_llm_agent: 別モデル (セカンドLLM) に任せる。道具を使う複合作業 (調査+生成+保存等) も、
  道具の要らない単発の相談・レビュー・要約 (no_tools:true、reason 不要) も これ1本。
注意: 単純なファイル読み書きなど自分で直接できるタスクには使わない。`,

  delegation: `[ガイド: 委任 (task / second_llm_agent) の判断]
**委任は 3 条件のいずれかが満たされる時のみ。 それ以外はインライン処理。**
1. コンテキスト保護: 大量ファイル読込で本セッションのコンテキストを浪費したくない
2. 並列性: 独立した複数タスクを同時に走らせたい
3. 専門性: 別モデルの特性 (高速 / 別視点等) が活きるタスク

委任の禁忌:
- 連続委任 (Delegation Cascade) を避ける: 同じ成果物への修正を細切れに 3 回以上委任しない
- 委任先で完結させる: 一度委任したらそのタスクの完成までを 1 回の委任内で
- 軽作業は委任しない: ファイル一覧 (glob) / 中身検索 (grep) / 単一ファイル読込 (file_read) は自分で

**委任時のレジスター継承 [必須]**:
delegate メッセージには次の 4 点を必ず含める:
1. レジスター (rough / standard / production)
2. 完成基準 (Acceptance Criteria) — standard 以上は 3-5 項目で明示
3. 仕様ファイルパス (内容コピーではなく file_read 指示で渡す)
4. 成果物の保存先パス (委任先が file_write で保存。 メインはファイル化しない)

委任時の禁忌 (出力形式の固縛):
- 「Output ONLY HTML」 のようなテキスト返却前提の形式縛りは禁止 (= file_write スキップの温床)
- 必ず「成果物は <パス> に file_write して、 return には完了サマリ + パスを書く」 という指示にする`,

  verification: `[ガイド: 検証ルール — レジスターに応じて深さを変える]
コード / 成果物を生成したら必ず検証:

| 種別 | rough | standard | production |
|---|---|---|---|
| .ts / .js | \`node --check <file>\` | + 関連テストを実行 | + lint + 型チェック |
| .py | \`python -m py_compile <file>\` | + pytest 実行 | + lint + 型チェック |
| HTML/CSS (Three.js含む) | file_read で主要要素確認 | + 主要 JS を行抽出して node --check | + browser_screenshot で表示確認 |
| GUIアプリ (pygame/tkinter/Electron) | 構文チェックのみ | + import 検証 | + 必要に応じスナップショット |
| 設定ファイル (json/yaml) | パース確認 | + スキーマ検証 | 同左 |

**HTML/Three.js のような GUI 系 [重要]**:
- 構文チェックだけでは「画面で見て動かない」 を検出できない
- standard 以上では必ず file_read で生成内容を確認 (主要要素・色指定・配置等)
- production では browser_screenshot で実際の表示を確認するか、 不可なら「動作確認できない」 と完了報告に明記
- 「ファイル存在 = 完了」 とは絶対に判定しない

**検証粒度の最適化 — 細切れ build は反復浪費の主因**:
- 複数の file_edit を行ってから 1 回 build が原則。 1 edit ごとに \`npm run build && node ...\` のような重い検証を回さない
- 軽い syntax check (\`node --check\` / \`python -m py_compile\` / \`tsc --noEmit\` 等) で edit 中の暫定確認、 build/run はまとまった単位で
- ホットリロード可能なサーバーは「再起動なし」 で確認できないか先に検討
- 検証用に起動したプロセスは用が済んだら kill する。 起動 → 確認 → kill で PID を放置しない

検証失敗 → 修正 → 再検証を通るまで繰り返す。 検証成功の事実を完了報告に含める。`,

  scopeStrict: `[ガイド: スコープ厳守]
ユーザーが @添付・明示したファイル / ディレクトリが **タスクスコープ**。 これを超えた広域探索は原則禁止:
- \`ls -R\`, \`find .\`, \`tree\` などの広域再帰スキャンは確認必須 (session-allow でもバイパスされない)
- 絶対パス・\`..\` を使って CWD 外を参照する bash も確認必須
- @添付されたファイルは context に既に入っている。 再度 file_read しないこと`,

  obsidian: `[ガイド: ナレッジベース（Obsidian連携）の使い方]
## knowledge_save — 保存
ユーザーが「記録して」「ナレッジに保存して」 等と指示した場合のみ使用する。 自動的には保存しない。
- ノート本文は日本語で書く
- 推奨構成: ## 要約 → ## 主要ポイント → ## 詳細 → ## ソース
- タグは階層構造: technology/frontend, language/typescript, framework/react 等
- type: web (Web検索結果), research (調査まとめ), reference (チートシート)
- ソースURLがある場合は必ず source に含める

## knowledge_search — 検索
過去に保存したナレッジを検索して回答に活用する。
- タグフィルタで絞り込み可能 (前方一致: "technology" で "technology/frontend" もマッチ)`,
};

/**
 * Phase B-3: T3 (7B local) 向けの few-shot 例。 ツール初回利用時に description の
 * 補足として注入される。 T1/T2 では注入されない (= 賢い LLM の足枷にならない)。
 *
 * 設計指針:
 * - 良い例 1 つ + 悪い例の落とし穴 2-3 件
 * - JSON 形式で書く (T3 は JSON-mode が多い)
 * - 引数の必須/任意を明示
 */
const T3_FEW_SHOTS: Record<string, string> = {
  file_edit: `[T3向け 例: file_edit]
良い例:
  file_edit({"file_path": "/abs/path/to/main.py", "old_string": "def foo():\\n    pass", "new_string": "def foo():\\n    return 42"})
悪い例 / よくある失敗:
- 相対パス ("./main.py") → 絶対パス ("/abs/...") を使う
- old_string が空白/改行/インデントを 1 文字でも違える → エラーになる。 file_read 結果からそのままコピー
- 同じ old_string が 2 箇所以上マッチ → エラー。 replace_all=true を追加するか前後を含めて一意化
- 直前に file_read していない → 必ず先に読む`,

  file_write: `[T3向け 例: file_write]
良い例:
  file_write({"file_path": "/abs/path/to/output.py", "content": "<file 全文>"})
悪い例:
- content に差分だけ渡す → 全文を渡す (file_write は完全上書き)
- 相対パス → 絶対パスのみ
- 既存ファイルを上書きしたいだけなら file_edit を優先`,

  file_read: `[T3向け 例: file_read]
良い例:
  file_read({"file_path": "/abs/path/to/file.py"})
  file_read({"file_path": "/abs/main.py", "offset": 100, "limit": 50})  // 100行目から50行
悪い例:
- file_edit / file_write の直後に同じファイルを読む → 不要 (レスポンスに該当箇所が入っている)
- 大きいファイル (>1000行) を offset/limit なしで読む → コンテキスト浪費`,

  bash: `[T3向け 例: bash]
良い例:
  bash({"command": "node --check /abs/path/file.js"})
  bash({"command": "cd /abs/proj && python -m pytest test_main.py", "timeout": 60000})
悪い例:
- ファイル中身を見るために cat/head/tail を使う → file_read を使う
- ファイル一覧に ls -la を使う → glob を使う
- 同じコマンドを 2 回失敗で 3 回目を試す → 引数を変える
- pytest や npm run build を 1 edit ごとに走らせる → まとめて 1 回`,

  grep: `[T3向け 例: grep]
良い例:
  grep({"pattern": "function foo", "path": "/abs/path/src"})
  grep({"pattern": "TODO", "path": "/abs/proj", "include": "*.py"})
悪い例:
- 正規表現の特殊文字 ($, ^, [, ], (, )) を escape し忘れる
- ヒット 0 で同じ pattern を再試行 → pattern を緩める or path を広げる`,

  glob: `[T3向け 例: glob]
良い例:
  glob({"pattern": "**/*.py", "path": "/abs/proj"})
  glob({"pattern": "src/**/test_*.py"})
悪い例:
- ヒット 0 で同じ pattern を再試行 → pattern を緩める ("*" → "**/*"、 拡張子を変える)
- 全ディレクトリを再帰検索 (\`ls -R\` 相当) は使わない (スコープ違反)`,

  todo_write: `[T3向け — todo_write は deprecated。 todo_append を使う]
良い例 (新規):
  todo_append({"items": [
    {"content": "main.py を file_write で作成", "status": "in_progress"},
    {"content": "node --check で構文確認", "status": "pending"},
    {"content": "python main.py で動作確認", "status": "pending"}
  ]})
原則:
- 3 項目で十分。 細かく分けすぎない
- "in_progress" は同時に 1 つだけ
- 状態変更は todo_mark(id, status)。 全部 completed で response_complete
- 行き詰まったら todo_mark(id, "blocked") で自己宣言`,

  todo_append: `[T3向け 例: todo_append]
複数の作業ステップを ToDo に commit する。 思考 → 戦略 → 実行 のリズムで使う。
良い例:
  todo_append({"items": [
    {"content": "32x32 描画順を決める (遠 → 近)", "status": "in_progress"},
    {"content": "シルエットを rect.fill で配置", "status": "pending"},
    {"content": "顔のパーツを dot で詰める", "status": "pending"},
    {"content": "Vision で評価", "status": "pending"}
  ]})
原則:
- 思考だけで進めない。 戦略を todo に書き出してから実行に移る
- 1 ターン内に commit + 最初の Action を両方やる (= 計画蒸発を防ぐ)`,

  todo_mark: `[T3向け 例: todo_mark]
既存 todo の状態を変更する。 内容は変えない。
良い例:
  todo_mark({"id": "t_xxx", "status": "in_progress"})
  todo_mark({"id": "t_yyy", "status": "completed"})
  todo_mark({"id": "t_zzz", "status": "blocked"})  ← 行き詰まりの自己宣言
原則:
- 着手時に "in_progress"、 完了時に "completed"
- 詰まったら "blocked" で表明 → ハーネスや user が状況を把握できる
- ループしないように 1 つずつ進める`,

  todo_delete: `[T3向け 例: todo_delete]
不要な todo を明示的に削除する。 戦略破棄したい時は delete + append の 2 段。
良い例:
  todo_delete({"ids": ["t_xxx", "t_yyy"]})
原則:
- 暗黙削除 (= 書き忘れ) は避ける、 必ず明示的に delete を呼ぶ
- 戦略を作り直す時は: 古い todo を全 delete → 新 todo を append`,

  ask_user: `[T3向け 例: ask_user]
良い例:
  ask_user({"question": "ファイル名を教えてください。 main.py か app.py か。"})
原則:
- 推測で進めるより聞く方が良い
- 質問は 1 つだけ短く
- 同じツールが 2 回失敗した時 / ユーザー指示が曖昧な時に使う`,

  response_complete: `[T3向け 例: response_complete]
良い例:
  response_complete({"summary": "main.py を作成、 node --check 通過、 動作確認済み。"})
原則:
- 作業が全部終わったら必ず呼ぶ
- summary は 1-2 文で簡潔に「何を作ったか / どう確認したか」`,
};

/**
 * ツール名 → 該当するガイドキー配列。
 * 1 つのツールに対して複数のガイドが該当しうる (例: bash は verification + scopeStrict)。
 */
const TOOL_TO_GUIDES: Record<string, readonly string[]> = {
  task: ["delegation"],
  second_llm_agent: ["secondLLM", "delegation"],
  bash: ["verification", "scopeStrict"],
  file_write: ["verification"],
  knowledge_save: ["obsidian"],
  knowledge_search: ["obsidian"],
};

/**
 * Phase D-3: T3 向けの失敗時 few-shot ガイド。 (toolName, errorPattern) のペアごとに
 * 1 度だけ注入される。 D-2 の decision-tree (stuck-loop = 2 回目の失敗) より早く、
 * **1 回目の失敗時** に具体的な「次にすべき tool 呼び出し例」 を提示する。
 *
 * ペアキー = `<toolName>:<errorPattern>` (errorPattern は固定の識別子)
 * 値 = 注入される文字列
 */
const T3_FAILURE_GUIDES: Record<string, string> = {
  "file_edit:found-multiple": `[T3向け 失敗時例: file_edit "found N times"]
このエラーは old_string が複数箇所にマッチした場合に出ます。 次の例を真似てください:
  file_edit({"file_path": "/abs/path", "old_string": "<同じ>", "new_string": "<新>", "replace_all": true})
全部置換したくない場合は old_string の前後を含めて一意化してください。`,

  "file_edit:not-found": `[T3向け 失敗時例: file_edit "not found in file"]
このエラーは old_string がファイルにマッチしなかった場合に出ます。 次のいずれかを試してください:
  1. file_read でファイル現状を確認 (空白・改行が違う可能性)
  2. file_write でファイル全体を書き直す:
       file_write({"file_path": "/abs/path", "content": "<全文>"})`,

  "file_read:not-found": `[T3向け 失敗時例: file_read "File not found"]
パスが間違っているか、 ファイル自体が無い可能性。 次の例を真似てください:
  1. glob でファイル名検索: glob({"pattern": "**/<filename>"})
  2. 見つからなければ ask_user で正しいパスを確認`,

  "bash:exit-1": `[T3向け 失敗時例: bash "Exit code: 1"]
コマンド失敗時の対処:
  1. エラー出力 (STDERR) を読み、 引数を 1 つ変える
  2. 同じコマンドを再実行しない (= 同じ結果になるだけ)
  3. 何度も失敗するなら ask_user で人間に確認`,

  "grep:no-match": `[T3向け 失敗時例: grep "No matches found"]
pattern が厳しすぎる可能性。 次の例:
  1. pattern を短く: "function foo" → "foo"
  2. path を広げる: 親ディレクトリを指定
  3. 大文字小文字: 別の case を試す`,

  "glob:no-match": `[T3向け 失敗時例: glob "0 files"]
pattern にマッチするファイルが無い。 次の例:
  1. pattern を緩める: "*.py" → "**/*.py"
  2. 拡張子を変える: ".py" → ".pyc" や ".pyi" など
  3. 親 path を指定する`,
};

/**
 * Phase D-3: ツール失敗時、 (toolName, error 本文) から該当する failure guide キーを
 * 推定する。 既知パターンに該当しなければ null。
 */
function inferFailureGuideKey(toolName: string, errorMsg: string): string | null {
  if (!errorMsg) return null;
  const err = errorMsg.toLowerCase();
  if (toolName === "file_edit") {
    if (err.includes("found") && err.includes("times")) return "file_edit:found-multiple";
    if (err.includes("not found")) return "file_edit:not-found";
  }
  if (toolName === "file_read") {
    if (err.includes("not found")) return "file_read:not-found";
  }
  if (toolName === "bash") {
    if (err.includes("exit code: 1") || err.includes("exit code: 127")) return "bash:exit-1";
  }
  if (toolName === "grep") {
    if (err.includes("no matches") || err.includes("0 match")) return "grep:no-match";
  }
  if (toolName === "glob") {
    if (err.includes("no match") || err.includes("0 file")) return "glob:no-match";
  }
  return null;
}

/** 既に注入済みのガイドキーを追跡する Set */
const usedGuides = new Set<string>();
/** Phase B-3: 既に注入済みの T3 few-shot キー (= ツール名) */
const usedFewShots = new Set<string>();
/** Phase D-3: 既に注入済みの T3 failure guide キー (= toolName:pattern) */
const usedFailureGuides = new Set<string>();

/**
 * ツール初回使用時のガイドテキストを取得する。
 *
 * - ツールに紐づくガイドキー (TOOL_TO_GUIDES) のうち、 まだ使われていないものだけを連結して返す
 * - Phase B-3: tier === "T3" で、 そのツールに T3 few-shot 例があれば追加で注入
 * - 1 つでも未使用ガイドがあれば文字列を返し、 全て使用済みなら null を返す
 * - 取得した時点で「使用済み」 とマークするため、 同じガイドが二度注入されることはない
 */
export function getFirstUseGuide(toolName: string, tier?: Tier): string | null {
  const keys = TOOL_TO_GUIDES[toolName] ?? [];
  const unusedKeys = keys.filter((k) => !usedGuides.has(k));

  // Phase B-3: T3 では few-shot を 1 度だけ注入
  let t3Example: string | null = null;
  if (tier === "T3" && T3_FEW_SHOTS[toolName] && !usedFewShots.has(toolName)) {
    t3Example = T3_FEW_SHOTS[toolName];
    usedFewShots.add(toolName);
  }

  if (unusedKeys.length === 0 && !t3Example) return null;

  for (const k of unusedKeys) {
    usedGuides.add(k);
  }

  const parts: string[] = [];
  for (const k of unusedKeys) {
    if (GUIDE_TEXTS[k]) parts.push(GUIDE_TEXTS[k]);
  }
  if (t3Example) parts.push(t3Example);
  return parts.length > 0 ? parts.join("\n\n") : null;
}

/**
 * Phase D-3: ツール失敗時 (T3 のみ) に該当する failure guide を 1 度だけ取得する。
 * 同じ (toolName, errorPattern) では 2 回目以降は null を返し、 D-2 の decision-tree が
 * 拾う構造になっている。
 *
 * @returns 注入する文字列。 該当パターン無し or 既に注入済 or T3 以外なら null。
 */
export function getFailureGuide(toolName: string, errorMsg: string, tier?: Tier): string | null {
  if (tier !== "T3") return null;
  const key = inferFailureGuideKey(toolName, errorMsg);
  if (!key) return null;
  if (usedFailureGuides.has(key)) return null;
  const guide = T3_FAILURE_GUIDES[key];
  if (!guide) return null;
  usedFailureGuides.add(key);
  return guide;
}

/**
 * ガイド追跡状態をリセットする (セッション復元時等)。
 */
export function resetToolGuides(): void {
  usedGuides.clear();
  usedFewShots.clear();
  usedFailureGuides.clear();
}
