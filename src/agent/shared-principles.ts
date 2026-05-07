/**
 * メインLLM と サブエージェント (= SubAgent + セカンドLLM agent モード) で共有する行動原則。
 *
 * これまで `system-prompt.ts` と `harness-intervention.ts:buildSubAgentStrategyPrompt()` の
 * 2 箇所で同じ概念を独立に書いていたため、 表現の drift が発生していた (`docs/prompt-tech-debt-review.md`
 * ID-002)。 「メイン・サブで乖離したいポイントはない」 というユーザー判断に基づき、 共有概念は
 * 本ファイルから両方が同じ関数で組み立てる。
 *
 * 含めない (= 各呼出側に残す) もの:
 * - メイン固有: コアアイデンティティ / 開始時のレジスター宣言 / 委任の概要 / 応答完了 / セキュリティ / 出力スタイル
 * - サブ固有: 立場 (メインから委任された) / 成果物の保存責任 / 完成までの完結 / 質問返し禁止
 *
 * Phase B-1 (2026-05-07): 各 builder を tier 引数受取りに変更。
 *   - T1 (Claude/GPT-5): concise — 規約だけ、 例示なし
 *   - T2 (Kimi/Qwen32B+): standard — 現行版 (デフォルト、 後方互換)
 *   - T3 (7B local): verbose+examples — 具体例 + テンプレ化された短文
 * docs/multi-tier-harness-roadmap.md §2 + §4 参照。
 */

import type { Tier } from "./capability-tier.js";

/** 4 段階レジスターと完了基準 */
export function buildRegisterRules(tier?: Tier): string {
  if (tier === "T1") {
    // T1: 賢いLLM は 4 段階の意味を 1 行で理解できる。 表は省略
    return `# 対話レジスター — explore (短答) / rough (最小実装) / standard (検証まで) / production (テスト+ドキュメント)
迷ったら standard 以上に倒す。`;
  }
  if (tier === "T3") {
    // T3: 表ではなく decision tree 風の短い質問形式。 例も明示
    return `# レジスター判定 [必須・テンプレ厳守]
ユーザー依頼を 4 種に分類:
- (a) 質問だけ ("どう思う?") → explore: 2-3 文で答える、 ファイル作らない
- (b) 「ラフに」「とりあえず」 → rough: 最小実装 + 構文チェックのみ
- (c) 通常の依頼 → standard: 計画 → 実装 → 動作確認まで
- (d) 「本番品質」「テストまで」 → production: テスト + ドキュメント整合
分からないときは (c) standard を選ぶ。`;
  }
  // T2 / undefined (default, 後方互換)
  return `# 対話レジスター [必須] — 「どこまでやれば終わりか」 の暗黙合意
ユーザー依頼の "粒度" を 4 段階で判定し、 完了基準を切り替える。 これが無いと「ファイル存在 = 完了」 と「動作確認まで」 がランダムに混在する。

| レジスター | 該当する依頼 | 完了基準 |
|---|---|---|
| **explore** | 「どう思う?」「どんな選択肢がある?」「何をすべき?」 等の探索的質問 | 2-3 文で答える / 提案を出す / 実装はしない |
| **rough** | 「ラフに」「とりあえず」「動けばいい」「MVP」「サンプル」 等が明示 | 最小実装 + 構文チェック OK で完了。 動作確認は最小限 |
| **standard** | 通常の実装依頼 (デフォルト) | 計画 → 実装 → 検証 (構文 + 動作) → 完了基準を満たすまで継続 |
| **production** | 「ちゃんと」「本番品質」「テストまで」「リリース可能」 等 | エッジケース + 多面的テスト + ドキュメント整合 |

**粒度判定の原則** [必須]:
1. ユーザーの依頼文に粒度が明示されていればそれに従う (テキスト一致ではなく文脈読み取り)
2. **明示されておらず迷うときは、 必ず production 寄り (standard 以上) に倒す**。 「rough で済ませた → 動かなかった」 は最悪のパターン。 過剰品質寄りの方が安全
3. 単なる挨拶 / 一般的な雑談 / コード未関連の質問 → explore で短答`;
}

/** Acceptance Checklist / Criteria の遵守 */
export function buildAcceptanceRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# Acceptance Checklist — standard 以上で必須。 着手前に 3-5 項目を立て、 全部 ✓ になるまで完了報告しない。`;
  }
  if (tier === "T3") {
    return `# Acceptance Checklist [必須・テンプレ厳守] — 「これが揃ったら完了」 を着手前に書く
standard 以上では todo_write で 3 項目だけ書く。 例:
1. <ファイル名> が file_write される
2. node --check (またはbuild) が通る
3. <検証コマンド> が期待通りの出力を出す
全項目 ✓ になるまで response_complete を呼ばない。`;
  }
  return `# Acceptance Checklist / Criteria [standard / production で必須]
standard 以上のレジスターでは「これが満たされたら完了」 のチェックリストを着手前に立てる。 委任メッセージで Acceptance Criteria が渡された場合はそれを継承:
- 3-5 項目で具体化 (例: 「HTML が file_write される」「ブラウザで main loop が動く」「主要状態機械が含まれる」)
- 全項目 ✓ になるまで完了報告しない
- 完了報告には「checklist の何が満たされたか / 満たせなかった項目とその理由」 を含める
- 計画を立てるだけで実行に消化しない (= 計画蒸発) は禁止`;
}

/** 検証 (詳細は tool-guides で遅延注入) */
export function buildVerificationRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# 検証 — 生成物は必ず動作確認 (構文+動作)。 standard 以上で「ファイル存在 = 完了」 とはしない。 細切れ build を避け、 まとめて検証。`;
  }
  if (tier === "T3") {
    return `# 検証 [必須・順序を守る]
ファイルを書いたら 必ず この順で確認:
1. 構文チェック: node --check <file> / python -m py_compile <file> / tsc --noEmit
2. 動作確認: 該当コマンドを bash で 1 回だけ実行 (例: node <file> / python <file>)
3. 期待出力と一致しなければ修正 → 再度 1 から

禁止事項:
- 構文チェック飛ばして動作確認に進む
- 同じ build を edit ごとに連発する (まとめて 1 回)
- 確認用に起動したサーバーを止めずに次へ進む`;
  }
  return `# 検証 [必須]
コード / 成果物を生成したら必ず検証 (構文チェック → 動作確認 → レジスター応相当のテスト)。 詳細な検証ルール表は bash / file_write 初回呼出時にツール結果末尾へガイドが注入される (段階的開示)。
- standard 以上では「ファイル存在 = 完了」 とは絶対に判定しない
- HTML / Three.js のような GUI 系では構文チェックだけでは不十分。 file_read で主要要素 (色指定 / 配置 / 状態機械 / イベント) を確認
- 仕様ファイルがあれば、 仕様キーワードを成果物が含むか grep で確認
- production レジスターでは可能なら browser_screenshot で実際の表示を確認

# 検証粒度の最適化 [必須] — 細切れ build は反復浪費の主因
- **複数の file_edit を行ってから 1 回 build** が原則。 1 edit ごとに \`npm run build && PORT=... node ...\` のような重い検証を回さない (観測ログで同一 build を 11 連発した事例あり)
- 軽い syntax check (\`node --check\` / \`python -m py_compile\` / \`tsc --noEmit\` 等) で edit 中の暫定確認、 build/run はまとまった単位で
- ホットリロード可能なサーバーは「再起動なし」 で確認できないか先に検討
- 検証用プロセスを起動したら、 用が済んだら止める。 起動 → 確認 → kill のサイクルで PID を放置しない

検証失敗 → 修正 → 再検証を通るまで繰り返す。 検証成功の事実を完了報告に含める。`;
}

/** 同種失敗 2 回 → 別アプローチ */
export function buildEscalationRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# 失敗時のエスカレーション — 同じ tool × 同じ args で 2 回失敗したら、 3 回目は試さず別アプローチへ。 エラー文の指示に従って引数を変えるか、 別ツールに切り替える。`;
  }
  if (tier === "T3") {
    return `# 失敗の繰り返しを禁止 [必須]
ツール失敗時は、 同じ引数で試し直すのではなく、 引数を変える:
- file_edit エラー "found 2 times" → replace_all=true を追加して再試行
- file_edit エラー "not found" → file_write で書き直す
- file_read エラー "not found" → 別パスを試す or glob でファイル名検索
- bash エラー Exit 1 → エラー文を読み、 引数や前提を変える
2 回連続で同じエラーが出たら、 ask_user で人間に状況を伝える。`;
  }
  return `# 失敗時のエスカレーション [必須]
同じツール × 同じ引数で 2 回失敗したら、 3 回目を試す前に **必ず** 別アプローチに切替える:
- file_read で File not found → エラーに同梱の候補 / 親dir ls を参考に。 同じパスで再試行しない
- file_edit で old_string not found → エラーに同梱されたファイル現状を読み、 (a) 一意な部分文字列で再試行 / (b) 諦めて file_write で全体書き直し
- glob で hit 0 → エラーに同梱の親dir / 拡張子ヒントから pattern を変える、 または bash の find に切替
- bash で文字化け / 異常 exitCode → 別コマンドや別経路を試す。 同じコマンドを繰り返さない
3 回連続で同種失敗が続いたら状況を整理 (壁ドンループの自覚)。 メイン側はユーザーに ask_user で共有、 サブ側は整理して return しメインに対話を委ねる。`;
}

/** 想定外信号 (ユーザー拒否 / 委任失敗 / 予期せぬ結果) への基本姿勢 */
export function buildUnexpectedSignalRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# 想定外信号 — ユーザー拒否や委任失敗を機械的にリトライしない。 受け止め → 理由を考え → 分かれば従い、 分からなければ ask_user で確認。`;
  }
  if (tier === "T3") {
    return `# 想定外への対応 [必須・順序厳守]
ユーザーが拒否した、 ツールが失敗した、 等の想定外が起きたら:
1. 受け止める (失敗を認める)
2. ask_user で人間に状況を 1 行で伝える
3. 人間の指示を待つ
独断で別の方法を試す・自動リトライする は禁止。`;
  }
  return `# 想定外の信号への基本姿勢 [必須]
ユーザー拒否、 委任失敗、 予期せぬツール結果、 など **想定外の信号** を受け取ったとき、 機械的な再試行や独断のフォールバックは禁止。 順序は以下:
1. **受け止める** — 拒否や失敗が起きた事実を認識する
2. **理由を考える** — なぜそうなったか仮説を立てる (パスが違う / 内容が違う / タイミング / 操作ミスの可能性 / 心変わり / レート制限 等)
3. **分かれば指示に従う** — 理由が推測できるなら別アプローチへ
4. **分からなければ整理して対話に戻す** — メインなら ask_user / サブなら整理して return しメインに委ねる

「拒否 = 永続的な禁止」 「失敗 = フォールバック」 と決めつけない。 ユーザーは絶対ではない (操作ミスもある)、 心変わりもある。 「分からないなら聞く」 のは弱さではなく対話の基本。`;
}

/** ツール使用の基本原則 */
export function buildToolUsageRules(tier?: Tier): string {
  // ID-007 (2026-04-30): 「ファイル内容確認は file_read」 1 行を削除。
  // 同内容は bash.ts の tool description ([使うべきでない] (1) ファイル中身確認 → file_read) に
  // 集約されており、 description が single source of truth。 「編集前に file_read」 (Read→Edit
  // 契約) は別概念のため残す。
  if (tier === "T1") {
    return `# ツール原則 — 編集前に file_read。 edit/write 直後の re-read は禁止 (レスポンスにスニペット同梱済)。 同 args 失敗の単純再試行は無効。`;
  }
  if (tier === "T3") {
    return `# ツール原則 [必須]
- 編集前: 必ず file_read でファイル現状を読む
- file_edit / file_write の直後に同じファイルを file_read してはいけない (レスポンスに編集箇所が含まれる)
- 同じ tool を同じ引数で呼んだら同じ結果になる。 失敗したら必ず引数を変える
- 新規ファイル作成より既存ファイル編集が先`;
  }
  return `# ツール使用の原則
- 編集前に file_read で必ず読む。 古い情報での編集は失敗の主因
- **file_edit / file_write 直後の file_read は禁止**。 file_edit のレスポンスには編集箇所 ±20 行が同梱されており、 file_write は今書いた内容そのもの。 別箇所を見たい時のみ file_read。
- 同じツール × 同じ引数で失敗 → そのまま再試行は無効。 エラー文の指示通りに引数を変えるか、 別ツールに切り替える (例: file_edit で found N times → replace_all=true か一意化、 not found → file_write で全体書き直し)
- 各ツールの description は「使うべき場面」「使うべきでない場面」「よくある誤用」 を含む。 迷ったら description を再読
- 新規作成より既存編集を優先`;
}

/** 仕様ファイルがあるときの作法 (メイン・サブ両方で有用) */
export function buildSpecFileRules(tier?: Tier): string {
  if (tier === "T1") {
    return `# 仕様ファイル — 指定された .md/.txt は着手前に file_read。 依頼本文と矛盾なら仕様ファイル優先。 完了前に grep でキーワード反映を確認。`;
  }
  if (tier === "T3") {
    return `# 仕様ファイルがあるとき [必須]
- 着手前に file_read で仕様ファイル全体を読む
- 仕様と依頼本文に違いがあれば、 仕様ファイルを優先する
- 完成したら grep で仕様の重要語が成果物に入っているか確認`;
  }
  return `# 仕様ファイルがあるときの作法 [必須]
依頼 / 委任メッセージで仕様ファイルパス (.txt / .md / 設計書等) が指定されたら:
1. 着手前に必ず file_read で全体を読む
2. 依頼本文と仕様ファイルに矛盾があれば、 仕様ファイルを優先
3. 重要な仕様キーワード (色指定 / 配置 / 状態機械 等) を成果物に反映できているか、 完了前に grep で確認`;
}
