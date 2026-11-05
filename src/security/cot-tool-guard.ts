/**
 * 推論ログ (Chain-of-Thought / thinking) と実際のツール呼び出しの不整合検知ガード。
 *
 * 背景 (docs/harness-egress-and-cot-guard-design.md §1 / §3.3):
 * - Cohere 社の Qwen3.8-Flash-Next 調査報告において、推論ログでは「ツールの呼び出しを伴わない簡単な応答が適切」と
 *   記録されていたにもかかわらず、実際にはシェルツールを呼び出して外部通信を試みる事象が確認された。
 * - 本環境の過去ログ (2026-10-17 Qwen3.8 Flash Next) でも、thinking に "No tools needed." と出力しながら
 *   直後に bash ツールを呼び出す事象が実測された。
 *
 * 役割:
 * - thinking 内で「ツールは不要 / 呼び出さない」と明言しているにもかかわらず、副作用や外部調査を伴う実ツールが
 *   呼び出された場合に mismatch を検出し、PermissionManager 側で自動承認 (auto / autorun) を停止して
 *   ユーザーへの明示確認 (または非対話面での拒否) を強制する。
 */

import { INHERENTLY_SAFE_TOOLS } from "./inherently-safe-tools.js";

/**
 * 思考ログ内で「ツール呼び出しは不要・行わない」と結論づけているパターン。
 * 特定ツールの否定 ("no bash tool needed" 等) と区別するため、無冠詞または any/tool calls 全般の否定に限定する。
 */
const NO_TOOLS_DECLARED_PATTERNS: ReadonlyArray<RegExp> = [
  /\bno\s+tools?\s+(?:calls?\s+)?(?:are\s+|is\s+)?(?:needed|required|necessary)\b/i,
  /\bno\s+need\s+(?:to\s+(?:call|use|invoke|run)\s+)?(?:any\s+)?tools?\b/i,
  /\bwithout\s+(?:calling|using|invoking|running)\s+(?:any\s+)?tools?\b/i,
  /\bdo\s+not\s+need\s+to\s+(?:call|use|invoke|run)\s+(?:any\s+)?tools?\b/i,
  /\bdon'?t\s+need\s+to\s+(?:call|use|invoke|run)\s+(?:any\s+)?tools?\b/i,
  /\b(?:i\s+)?(?:will|shall|should)\s+not\s+(?:call|use|invoke|run)\s+(?:any\s+)?tools?\b/i,
  /\ba\s+simple\s+response\s+without\s+tool\s+calls?\b/i,
  /ツール(?:の?(?:呼び出し|使用|実行|利用))?は?(?:一切)?(?:不要|使わない|伴わない|必要ない|行わない|呼び出さない)/,
  /ツールを(?:一切)?(?:使わずに|用いずに|呼び出さずに|伴わずに)(?:回答|応答|返答)/,
];

export interface CotToolMismatchResult {
  /** 思考ログの「ツール不要」宣言と実際のツール呼び出しが矛盾しているか */
  mismatch: boolean;
  /** 思考ログ内で一致した「ツール不要」表現 */
  matchedPhrase?: string;
  /** 矛盾して呼び出された実ツール名一覧 */
  calledTools?: string[];
}

/**
 * 思考テキストと実際に呼び出されたツール名一覧を照合し、不整合を検出する。
 * response_complete や INHERENTLY_SAFE_TOOLS (todo_write 等) のみの場合は無害として除外する。
 */
export function detectCotToolMismatch(
  thinking: string | undefined,
  toolNames: readonly string[],
): CotToolMismatchResult {
  if (!thinking?.trim() || toolNames.length === 0) {
    return { mismatch: false };
  }

  // 本質的に安全な内部状態ツール (response_complete, todo_*, ask_user 等) を除いた実ツールを抽出
  const actionableTools = toolNames.filter((name) => name !== "response_complete" && !INHERENTLY_SAFE_TOOLS.has(name));
  if (actionableTools.length === 0) {
    return { mismatch: false };
  }

  for (const pattern of NO_TOOLS_DECLARED_PATTERNS) {
    const match = thinking.match(pattern);
    if (match) {
      return {
        mismatch: true,
        matchedPhrase: match[0],
        calledTools: actionableTools,
      };
    }
  }

  return { mismatch: false };
}
