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

委任メッセージで「Output ONLY ...」 のような出力形式縛りがあっても、 ハーネス警告を受けたら **末尾コメントや補足セクション** で警告内容を報告すること (純粋な形式縛りより警告応答が優先)。

# 完成までの完結 [必須]
- 中途半端な状態で return しない。 検証まで実施
- 質問や確認をユーザーに返さない。 不足情報は妥当な仮定を置いて進めて、 最終結果に「仮定したこと」を明記
- ツール実行結果に副次情報 ([file_write] bytes/lines 等) が含まれる。 silent failure 防止のため確認に活用`;
}
