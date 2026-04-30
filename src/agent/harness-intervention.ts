/**
 * ハーネス介入レイヤ
 *
 * Phase 5 第8ラウンド: 「育児の比喩」 に基づき、 ハーネス哲学を Claude Code 寄りに整理。
 *
 * 第1〜7 ラウンドでは tool_result に [システム][XXX] 形式の警告を後付けで挿入する手法を
 * 多用した (壁ドンループ / Read→Edit 契約 / 連続委任 / 経路保持原則 / 委任先テキスト返却 /
 * 無限ループ / 進捗ゼロ / HTML検証ヒント / 計画→ToDo 誘導 等)。 これは「失敗のたびに横から
 * 監視官が口を出す」 形になり、 ローカルLLM/Claude を問わずモデルを萎縮させる懸念があった
 * (= 本来の力を出せなくする)。
 *
 * 第8ラウンドからの方針:
 *   1. **原則の伝達** は system-prompt / tool description / sub-agent prompt で完結
 *      (育児で言う「家のルール」 を最初に伝える)
 *   2. **構造的前提条件は tool 側で拒否** する hard gate に集約 (例: 5-B3 reason 必須、
 *      response_complete の Acceptance Checklist 未消化エラー)。 tool 自身が「私は今これを
 *      やらない」 と言うのは正当な境界線
 *   3. **後付け警告テキスト挿入は全廃**。 監視官的介入をやめてモデルの判断を信用する
 *
 * 既存の seam (HarnessState, enrichToolResult) は no-op として残し、 将来 hard gate を
 * 追加する際の足場として再利用可能にしておく。 ただしパターン検出による警告挿入は
 * 一切行わない。
 */

import type { ToolCall } from "../providers/base-provider.js";
import {
  buildRegisterRules,
  buildAcceptanceRules,
  buildVerificationRules,
  buildEscalationRules,
  buildUnexpectedSignalRules,
  buildToolUsageRules,
  buildSpecFileRules,
} from "./shared-principles.js";

/**
 * ハーネス介入の状態スロット。 第8ラウンドで監視官的介入を全廃したため、
 * 現状は何も保持しない空のクラス。 将来的に hard gate (Read→Edit のセッション内
 * Read 必須化等) を実装する際にフィールドを追加する余地として残す。
 */
export class HarnessState {
  // 意図的に空。 監視官状態を持たない。
}

/**
 * ツール実行結果を返す seam。 第8ラウンド以降は no-op (rawContent をそのまま返す)。
 *
 * ハーネスは tool_result に後付けでテキストを混ぜ込まない。 モデルへの原則伝達は
 * system-prompt / tool description / sub-agent prompt で行い、 構造的境界は tool 側の
 * hard gate (引数バリデーション等) で表現する。
 */
export function enrichToolResult(
  _toolCall: ToolCall,
  _success: boolean,
  rawContent: string,
  _state: HarnessState,
): string {
  return rawContent;
}

/**
 * セカンドLLM (sub-agent) 用のシステムプロンプト。
 *
 * ID-002 (2026-04-30): メイン側 system-prompt と原則は同一。 共有部分は
 * `shared-principles.ts` から組み立て、 サブ固有 (立場 / 成果物保存責任 / 完結) のみ
 * ここで追加する。 「メイン・サブで乖離したいポイントはない」 というユーザー判断による。
 */
export function buildSubAgentStrategyPrompt(): string {
  return `# あなたの立場
メインLLMから委任されたサブエージェント。 タスクの完成までを **この 1 回の委任で完結** させる。
細切れに別の委任に分けず、 必要な作業はこのセッション内でやり切る。 委任メッセージにはレジスター・ Acceptance Criteria・ 仕様ファイルパス・ 保存先パスが含まれているはず。

${buildRegisterRules()}

${buildAcceptanceRules()}

${buildSpecFileRules()}

${buildToolUsageRules()}

${buildVerificationRules()}

${buildEscalationRules()}

${buildUnexpectedSignalRules()}

# 成果物の保存責任 [必須] — テキスト返却は未完了
コード・ HTML・ JSON などの "成果物" は、 必ず file_write / file_edit で実ファイルに保存してから return する。 テキストのコードブロック (\`\`\`html ... \`\`\` 等) を返すだけでは未完了:
- 「メイン側で保存してくれるだろう」 と思って返してはいけない
- "Output ONLY HTML" のような形式縛りがあっても、 委任先のあなたが file_write で保存し、 テキスト返答にはファイルパス + サマリを書く
- 保存先パスが委任メッセージで明示されていればそこに、 無ければ妥当な場所 (sandbox/ 配下や cwd の作業フォルダ) に書く
- 完了時の return 文字列例: \`File written: <path> (<bytes> bytes, <lines> lines). 主要要素: ...\`

# 完成までの完結 [必須]
- 中途半端な状態で return しない。 検証まで実施
- 質問や確認をユーザーに返さない。 不足情報は妥当な仮定を置いて進めて、 最終結果に「仮定したこと」 を明記
- ツール実行結果に副次情報 ([file_write] bytes / lines 等) が含まれる。 silent failure 防止のため確認に活用`;
}
