/**
 * ハーネス介入レイヤ (Phase 5 第2ラウンド)
 *
 * メインLLM (agent-loop.ts) とセカンドLLM (second-llm-manager.ts) の両方から
 * 共有して使う、 ツール実行結果のエンリッチ + 失敗パターン検出ロジック。
 *
 * 設計原則:
 *   メイン側に独自実装し、 セカンド側でハーネス警告が届かない非対称性を解消する。
 *   両者が **同じ HarnessState を保持し、 同じ enrichToolResult を通す** ことで、
 *   セカンドLLM (賢いクラウドモデル) も壁ドンループ・連続委任・盲目編集から守られる。
 */

import * as path from "node:path";
import type { ToolCall } from "../providers/base-provider.js";

/**
 * ハーネス介入の状態。 1 セッション = 1 インスタンス。
 * メインの AgentLoop と、 セカンドLLMの runAsAgent / runAsEvaluator がそれぞれ独自に持つ。
 *
 * 注意: メインとセカンドで状態を共有したい場合は将来的に shared インスタンスを渡す設計も可能だが、
 * 第2ラウンドではセカンド側にも「自前の」状態を持たせるだけでも非対称性は大幅に解消する。
 */
export class HarnessState {
  /** 同 (toolName, 主要引数) で連続失敗回数 — 壁ドンループ検出用 */
  wallHitFailCounts = new Map<string, number>();
  /** file_edit のファイルパスごと連続失敗回数 — Phase 2 既存 */
  fileEditFailCounts = new Map<string, number>();
  /** file_read された絶対パス (LRU 風、最大 32 件) — Read→Edit 契約用 */
  recentReads = new Set<string>();
  /** 直近の委任系ツール呼び出し時刻 (5 分以内のみ保持) — 連続委任ガード用 */
  recentDelegations: { tool: string; ts: number }[] = [];
  /** 直近のツール呼び出し名列 (最新 20 個) — 高次無限ループ検出用 (Phase 5-Q8) */
  recentToolSeq: string[] = [];
  /** 無限ループ警告を直近で出したか (重複抑制用) */
  loopWarningCooldown = 0;
  /** Phase 5-F1: 一度でも file_write/file_edit 成功があったか (= 実装モード突入) */
  hasEverWritten = false;
  /** Phase 5-F1: 直近の "進捗" tool (file_write/file_edit 成功) からの非進捗 tool 数 */
  toolsSinceLastWrite = 0;
  /** Phase 5-F1: 進捗ゼロ警告のクールダウン (連発抑制) */
  silentWarningCooldown = 0;
  /** Phase 5-D3: enter_plan_mode 承認直後フラグ — 次に todo_write を期待 */
  expectingTodoAfterPlan = false;
}

/**
 * ツール実行結果を、 ハーネス警告/ヒントで増補して返す。
 *
 * 呼び出し側の使い方:
 *   const enriched = enrichToolResult(toolCall, result.success, result.output ?? "", state);
 *   messages.push({ role: "tool", content: enriched, tool_call_id: tc.id });
 *
 * 副次的に state を変更する (連続失敗カウンタの更新等)。
 */
export function enrichToolResult(
  toolCall: ToolCall,
  success: boolean,
  rawContent: string,
  state: HarnessState,
): string {
  let content = rawContent;
  const toolName = toolCall.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments ?? "{}");
  } catch { /* ignore */ }

  // ── (1) file_edit 連続失敗追跡 (Phase 2) ──────────────────────
  if (toolName === "file_edit") {
    const filePath = (args.file_path ?? args.path ?? "") as string;
    if (!success && filePath) {
      const cnt = (state.fileEditFailCounts.get(filePath) ?? 0) + 1;
      state.fileEditFailCounts.set(filePath, cnt);
      if (cnt >= 2) {
        content +=
          `\n\n[システム] このファイルへの file_edit が ${cnt} 回連続で失敗しています。 ` +
          `file_write でファイル全体を書き直してください。`;
      }
    } else if (success && filePath) {
      state.fileEditFailCounts.delete(filePath);
    }
  }

  // ── (2) 壁ドンループ検出 (Phase 5-D) — file_read/glob/grep/bash/file_write も対象 ──
  if (!success) {
    const key = wallHitKey(toolCall);
    if (key) {
      const cnt = (state.wallHitFailCounts.get(key) ?? 0) + 1;
      state.wallHitFailCounts.set(key, cnt);
      if (cnt >= 2) {
        content +=
          `\n\n[システム][壁ドンループ警告] 同じツール×同じ引数で ${cnt} 回連続失敗。 ` +
          `同じ呼び出しを繰り返さないこと。 別アプローチに切替えるか、 ask_user で状況共有を。 ` +
          `(key=${key.slice(0, 80)})`;
      }
    }
  } else {
    const key = wallHitKey(toolCall);
    if (key) state.wallHitFailCounts.delete(key);
  }

  // ── (3) Read→Edit 契約 (Phase 5-H) — file_edit が直近 file_read 履歴を持たない場合 ──
  if (toolName === "file_edit") {
    const filePath = (args.file_path ?? args.path ?? "") as string;
    if (filePath) {
      const abs = path.resolve(filePath);
      if (!state.recentReads.has(abs)) {
        content +=
          `\n\n[システム][Read→Edit契約] このセッションで file_read していないパスに file_edit を実行しました: ${filePath}` +
          `\n→ 次回からは編集前に file_read で現状を確認してください。 古い情報での編集は old_string 不一致の主因です。`;
      }
    }
  }

  // ── (4) file_read 成功時に recentReads を更新 ──
  if (toolName === "file_read" && success) {
    const filePath = (args.file_path ?? args.path ?? "") as string;
    if (filePath) {
      const abs = path.resolve(filePath);
      state.recentReads.delete(abs);
      state.recentReads.add(abs);
      if (state.recentReads.size > 32) {
        const first = state.recentReads.values().next().value;
        if (first) state.recentReads.delete(first);
      }
    }
  }

  // ── (4.5) 旧版エラーガイダンス (汎用ヒント、 ローカルLLM向け) ──
  if (!success) {
    const lower = content.toLowerCase();
    if (toolName === "file_read" && lower.includes("is a directory")) {
      content +=
        "\n\n[ガイド] パスはディレクトリです。 glob でディレクトリ内のファイル一覧を取得してください。";
    } else if (toolName === "bash" && lower.includes("exit code")) {
      content +=
        "\n\n[ガイド] コマンドが失敗しました。 STDERR のエラーメッセージを読んで原因を特定し、 修正してください。";
    }
  }

  // ── (4.7) Phase 5 第4ラウンド (課題Q2): セカンドLLM 失敗の経路保持警告 ──
  // ユーザーが second_llm_consult / second_llm_agent を使うようにメインに指示している場合、
  // 失敗時にメインが勝手に「自分でやる」 と切替えるのは意図違反。 ハーネスから 3 択提示を促す。
  if (
    !success &&
    (toolName === "second_llm_consult" || toolName === "second_llm_agent") &&
    /\[セカンドLLM失敗:([A-Z_]+)\]/.test(content)
  ) {
    const m = content.match(/\[セカンドLLM失敗:([A-Z_]+)\]/);
    const cat = m?.[1] ?? "UNKNOWN";
    const catSpecific = (() => {
      switch (cat) {
        case "RATE_LIMIT":
          return "Azure 側の TPM/RPM クォータを超過。 数十秒〜数分待ってリトライが第一選択。 連続発生なら別モデルへの切替を検討。";
        case "AUTH":
          return "API Key が無効/期限切れ/権限不足。 /second status で現在の保存形式を確認、 /second setup azure-* で再設定。";
        case "NOT_FOUND":
          return "endpoint URL の path / deployment 名 / model 名が不一致。 Azure Portal で正確な値を確認、 /second setup で再設定。";
        case "BAD_REQUEST":
          return "リクエスト形式の不適合。 model 名や endpoint パスが古い API バージョンの可能性。 /second status で確認。";
        case "SERVER_ERROR":
          return "サーバ側障害。 数分待ってリトライ。 継続するなら Azure 側の障害を疑う。";
        case "TIMEOUT":
          return "応答タイムアウト。 大きいプロンプトなら分割、 短時間ならリトライ。";
        case "NETWORK":
          return "ネットワーク到達不能。 endpoint URL のホスト名/プロキシを確認。";
        default:
          return "原因不明。 エラー本文を確認して /second status で設定確認。";
      }
    })();
    content +=
      `\n\n[システム][経路保持原則] ユーザーが「セカンドLLMで」 と指示している場合、` +
      ` 失敗を理由にメインが独断で「自分でやる」 と切替えるのは意図違反。 必ず ask_user で 3 択を提示する:` +
      `\n  (a) リトライする (一時的な失敗の可能性)` +
      `\n  (b) メイン側で実行 (ユーザーが許可する場合のみ)` +
      `\n  (c) モデル設定を見直す (/second status / /second setup azure-*)` +
      `\n[エラーカテゴリ: ${cat}] ${catSpecific}`;
  }

  // ── (4.8) Phase 5 第5ラウンド (課題Q7): セカンド成功時のテキスト返却検出 ──
  // セカンドが file_write せずにコードブロック (```...```) のテキストを返した場合、
  // それは未完了の徴候。 メインに「これを自分で file_write しないこと、 委任を再構成すべき」 を伝える。
  if (
    success &&
    (toolName === "second_llm_agent" || toolName === "task") &&
    /```[a-zA-Z0-9]*\n[\s\S]{200,}\n```/.test(content) &&
    !/\[file_write\]|File written:/.test(content)
  ) {
    content +=
      `\n\n[システム][委任先テキスト返却警告] 委任先がコードブロックをテキストで返しましたが、 ` +
      `file_write した形跡がありません (副次情報 [file_write] が含まれていない)。` +
      `\n→ メイン側で勝手に file_write してフォールバックするのは禁止 (経路の二重化)。 ` +
      `\n→ 正しい対応: (a) 委任を再実行し、 prompt に「成果物は <保存先パス> に file_write してから完了」 を明示する。 ` +
      `(b) 委任先の作業フォルダ (sandbox/ 等) を file_read で確認して既に保存済か検証。 ` +
      `(c) どうしても自分で保存する必要があるなら ask_user で確認を取ってから。`;
  }

  // ── (4.9) Phase 5-Q8: 高次無限ループ検出 — 同パターンの直近反復を検出 ──
  state.recentToolSeq.push(toolName);
  if (state.recentToolSeq.length > 20) state.recentToolSeq.shift();
  if (state.loopWarningCooldown > 0) state.loopWarningCooldown--;
  // 末尾 N 個が直前の N 個と完全一致なら 周期 N の反復ループ
  // 周期 2〜5 を順に試して検出。 連続 3 周期以上が要件 (= 末尾 3*N 個で同パターン)
  if (state.loopWarningCooldown === 0 && state.recentToolSeq.length >= 6) {
    for (let period = 2; period <= 5; period++) {
      if (state.recentToolSeq.length < period * 3) continue;
      const tail = state.recentToolSeq.slice(-period * 3);
      const a = tail.slice(0, period).join("|");
      const b = tail.slice(period, period * 2).join("|");
      const c = tail.slice(period * 2, period * 3).join("|");
      if (a === b && b === c) {
        content +=
          `\n\n[システム][無限ループ警告] 直近 ${period * 3} ツール呼び出しで同一パターン (周期 ${period}) が 3 周期以上繰り返されています: [${a}]` +
          `\n→ 別アプローチに切替えるか、 ask_user で状況を共有して指示を仰ぐこと。 同じパターンを続けるのは禁止。`;
        state.loopWarningCooldown = period * 3; // 警告を一定期間抑制
        break;
      }
    }
  }

  // ── (5) 連続委任ガード (Phase 5-B2) — second_llm_agent / task の連発を検出 ──
  if (toolName === "second_llm_agent" || toolName === "task") {
    const now = Date.now();
    state.recentDelegations.push({ tool: toolName, ts: now });
    state.recentDelegations = state.recentDelegations.filter((d) => now - d.ts < 5 * 60_000);
    const sameToolRecent = state.recentDelegations.filter((d) => d.tool === toolName).length;
    if (sameToolRecent >= 3) {
      content +=
        `\n\n[システム][連続委任警告] ${toolName} を直近 ${sameToolRecent} 回連続で呼び出しています。 ` +
        `修正リストを集約して 1 回の委任で完結させる方が効率的です (Delegation Cascade 回避)。 ` +
        `次の委任が必要なら、 まず収まり切らない理由を整理してから。`;
    }
  }

  // ── (6) Phase 5-F1: progressTracker (進捗ゼロターン検出) ──
  // file_write / file_edit が成功した = 実装が前進した。 それ以外は「観察」 とみなす。
  // 一度でも書込が成功した後は、 観察 8 回連続で警告 (情報収集ループに陥っている可能性)。
  const isProgressTool = success && (toolName === "file_write" || toolName === "file_edit");
  if (isProgressTool) {
    state.toolsSinceLastWrite = 0;
    state.hasEverWritten = true;
  } else {
    state.toolsSinceLastWrite++;
  }
  if (state.silentWarningCooldown > 0) state.silentWarningCooldown--;
  const SILENT_THRESHOLD = 8;
  if (
    state.hasEverWritten &&
    state.toolsSinceLastWrite >= SILENT_THRESHOLD &&
    state.silentWarningCooldown === 0
  ) {
    content +=
      `\n\n[システム][進捗ゼロ警告] 直近 ${state.toolsSinceLastWrite} 回のツール呼び出しで file_write/file_edit が成功していません。 ` +
      `情報収集が長すぎる、 検証ループに陥っている、 または同じ場所を何度も読んでいる可能性。 ` +
      `\n→ 何が分かっていて何が不足しているか整理し、 次の 1 手を決めてから書き込みに入ること。 ` +
      `判断材料が足りなければ ask_user で状況共有を。`;
    state.silentWarningCooldown = SILENT_THRESHOLD; // 8 回置きにのみ警告
  }

  // ── (7) Phase 5-P2: HTML 生成後の動作確認サジェスト ──
  // .html / .htm を file_write した直後、 「ファイル存在=完了」 と判定しないよう次の手を提示。
  if (success && toolName === "file_write") {
    const filePath = (args.file_path ?? args.path ?? "") as string;
    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".html" || ext === ".htm") {
      content +=
        `\n\n[システム][HTML検証ヒント] HTML 生成は「ファイル存在=完了」 ではありません。 段階別に検証:\n` +
        `  (1) **構造確認**: file_read で <canvas>/<script>/<body>/主要要素が含まれているか目視確認\n` +
        `  (2) **JS 構文確認**: <script> ブロック内 JS の syntax error は file_write の構文チェック対象外。 ` +
        `bash で 'grep -oP' (または sed) で JS 部分抽出 → tmp.js に出力 → \`node --check tmp.js\` で検証\n` +
        `  (3) **動作確認**: production レジスターでは可能なら browser_screenshot、 不可なら「動作確認不可」 と完了報告に明記\n` +
        `  (4) **仕様遵守**: 仕様ファイルがあれば grep で重要キーワード (色指定/状態名/操作キー等) の取り込みを確認`;
    }
  }

  // ── (8) Phase 5-D3: enter_plan_mode 承認直後 → todo_write に落とす誘導 ──
  if (success && toolName === "exit_plan_mode") {
    // exit_plan_mode は output が JSON 文字列。 approved=true の場合のみフラグを立てる。
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed && parsed.approved === true) {
        state.expectingTodoAfterPlan = true;
      }
    } catch { /* output が JSON でなければ無視 */ }
  } else if (state.expectingTodoAfterPlan && toolName !== "exit_plan_mode") {
    // 計画承認後の最初の "exit_plan_mode 以外" のツール呼び出しを検査
    if (toolName === "todo_write") {
      // 期待通り: 計画を todo に落としてくれた
      state.expectingTodoAfterPlan = false;
    } else {
      // 期待外: 警告を 1 度出してリセット (連発させない)
      content +=
        `\n\n[システム][計画→ToDo誘導] 直前に enter_plan_mode で計画が承認されました。 ` +
        `計画蒸発を防ぐため、 **次の手は todo_write で計画を 3-5 項目の Acceptance Checklist に落とすこと** が原則です。 ` +
        `\n→ 既に todo を立てているなら本警告は無視可。 standard 以上のレジスターでは Acceptance Checklist 必須 (response_complete のゲートで弾かれます)。`;
      state.expectingTodoAfterPlan = false;
    }
  }

  return content;
}

/**
 * 壁ドンループ検出キー生成。
 * (toolName, 主要引数) を結合した識別子を返す。 識別子が等しいツール呼び出しが
 * 連続失敗した場合、 「同じ呼び出しを繰り返している」 と判断できる。
 */
export function wallHitKey(toolCall: ToolCall): string | null {
  const name = toolCall.function.name;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(toolCall.function.arguments ?? "{}");
  } catch {
    return null;
  }
  switch (name) {
    case "file_read":
    case "file_write":
      return `${name}:${args.file_path ?? ""}`;
    case "glob":
      return `glob:${args.pattern ?? ""}|${args.path ?? ""}`;
    case "grep":
      return `grep:${args.pattern ?? ""}|${args.path ?? ""}`;
    case "bash": {
      const cmd = String(args.command ?? "").slice(0, 80);
      return `bash:${cmd}`;
    }
    default:
      return null;
  }
}

/**
 * セカンドLLM (sub-agent) 用のシステムプロンプト共通部品。
 * メインの system-prompt.ts に書かれた Phase 5 戦略原則のうち、
 * セカンドが委任を受けた立場で守るべきものをコンパクトに集約する。
 *
 * 「メインとセカンドで原則を共有する」 ためのもの。
 * runAsAgent / runAsEvaluator / consult のいずれからも参照可能。
 */
export function buildSubAgentStrategyPrompt(): string {
  return `# あなたの立場
メインLLMから委任されたサブエージェント。 タスクの完成までを **この 1 回の委任で完結** させる責務がある。
細切れに別の委任に分けず、 必要な作業はこのセッション内で全部やり切る。

# 対話レジスターの継承 [必須]
委任メッセージにはレジスター (rough / standard / production) と Acceptance Criteria が含まれている。 それに従って完了基準を切り替える:
- **rough**: 最小実装 + 構文チェック OK で完了
- **standard**: 計画 → 実装 → 検証 (構文 + 動作) → Criteria 全項目を満たすまで継続
- **production**: standard + エッジケース + 多面的テスト

レジスターが明示されていない場合は **standard** として扱う。 「rough で済ませた → 動かなかった」 は最悪のパターン。 迷ったら過剰品質に倒す。

# 仕様ファイルがあるときの作法 [必須]
委任メッセージで仕様ファイルパス (.txt / .md 等) が指定された場合:
1. **着手前に必ず file_read で全体を読む**
2. 委任メッセージ本文と仕様ファイルに矛盾があれば、 仕様ファイルを優先
3. 重要な仕様キーワード (色指定、 配置、 状態機械、 等) を成果物に反映できているか、 完了前に grep で確認

# Acceptance Criteria のチェック
委任メッセージに Acceptance Criteria が含まれていれば、 全項目を満たしてから return。 満たせない項目があれば、 最終応答にその旨を明記:
- 「以下の Criteria は満たした: [...]」
- 「以下は満たせなかった (理由): [...]」

# ツール使用の原則
- 各ツールの description は「使うべき場面」「使うべきでない場面」「よくある誤用」を含む。 迷ったら description を再読
- 編集前に file_read で必ず読む。 古い情報での編集は失敗の主因
- ファイル内容確認は file_read (bash の cat/head ではなく)、 ファイル一覧は glob、 中身検索は grep

# 検証ルール [必須]
コード/成果物を生成したら必ず検証:
- .ts/.js → bash で \`node --check <file>\`
- HTML/Three.js → file_read で主要要素 (色指定、 配置、 状態機械、 イベント等) を確認。 仕様ファイルがあれば grep でキーワード遵守チェック
- standard 以上のレジスターでは「ファイル存在 = 完了」 とは絶対に判定しない
- production レジスターでは可能なら browser_screenshot で実際の表示確認

# 失敗時のエスカレーション [必須]
同じツール×同じ引数で 2 回失敗したら、 3 回目を試す前に **必ず** 別アプローチへ切替える:
- file_read で File not found → エラーに同梱の候補/親dir ls を参考に。 同じパスで再試行しない
- file_edit で old_string not found → エラーに同梱されたファイル現状を読み、 (a) 一意な部分文字列で再試行 / (b) 諦めて file_write で全体書き直し
- glob で hit 0 → エラーに同梱の親dir/拡張子ヒントから pattern を変える、 または bash の find に切替
- bash で異常 exitCode → 別コマンドや別経路を試す。 同じコマンドを繰り返さない
3 回連続で同種失敗が続いたら、 状況を整理して return (ユーザーへの確認はメイン側に委ねる)

# ハーネス警告への対応 [必須]
tool_result に \`[システム][...]\` 形式のメッセージが含まれることがある。 これはハーネスからの介入で、 ユーザー発言ではない:
- \`[壁ドンループ警告]\` → 直近の同じ呼び出しを再試行しない。 アプローチを変える
- \`[Read→Edit契約]\` → file_edit する前に file_read で現状確認
- \`[連続委任警告]\` → 委任の集約を考える
- \`[進捗ゼロ警告]\` (Phase 5-F1) → 観察ループ脱出。 何が分かっていて何が不足か整理し、 次の書き込みに進む
- \`[HTML検証ヒント]\` (Phase 5-P2) → file_write した HTML は file_read で要素確認 + script ブロックの JS 構文チェック
- \`[計画→ToDo誘導]\` (Phase 5-D3) → 計画承認直後は必ず todo_write で 3-5 項目の Checklist に落とす

委任メッセージで「Output ONLY ...」 のような出力形式縛りがあっても、 ハーネス警告を受けたら **末尾コメントや補足セクション** で警告内容を報告すること (純粋な形式縛りより警告応答が優先)。

# 成果物の保存責任 [必須] — テキスト返却は未完了
**コードや HTML や JSON などの "成果物" は、 必ず file_write/file_edit で実ファイルに保存してから return すること。** テキストのコードブロック (\`\`\`html ... \`\`\` 等) を返すだけでは未完了:
- 「メイン側で保存してくれるだろう」 と思って返してはいけない。 メインは保存責任を負わない
- "Output ONLY HTML" のような形式縛りがあっても、 委任先のあなたが file_write で保存し、 テキスト返答にはそのファイルパス + サマリを書く
- 保存先パスが委任メッセージで明示されていればそこに、 無ければ妥当な場所 (sandbox/ 配下や cwd の作業フォルダ) に書く
- 完了時の return 文字列例: \`File written: <path> (<bytes> bytes, <lines> lines). 主要要素: ...\`

# 完成までの完結 [必須]
- 中途半端な状態で return しない。 検証まで実施
- 質問や確認をユーザーに返さない。 不足情報は妥当な仮定を置いて進めて、 最終結果に「仮定したこと」を明記
- ツール実行結果に副次情報 ([file_write] bytes/lines 等) が含まれる。 silent failure 防止のため確認に活用`;
}
