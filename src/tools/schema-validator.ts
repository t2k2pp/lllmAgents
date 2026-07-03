/**
 * Phase E-4: Schema-strict tool I/O — ツール実行前の引数バリデーション
 *
 * docs/multi-tier-harness-roadmap.md §4 Phase E-4 の実装。
 *
 * ツール定義の `parameters` (JSON Schema 風オブジェクト) に基づいて、
 * 渡された params が schema に適合しているかを実行前に検証する。
 *
 * 違反時: 具体的なエラーメッセージ (どのフィールドが何で違反か) を返し、
 * モデルが「次にどう直せばよいか」 を学習できる形にする。
 *
 * 対応する制約 (フル AJV ではなく、 lllmAgents の tool 定義で実用される範囲):
 *   - required: 必須フィールドの存在
 *   - type: "string" / "number" / "boolean" / "object" / "array" のチェック
 *   - enum: 列挙値の一致
 *   - 余分な field は warning にしない (前方互換性のため)
 *
 * 哲学: 「壊れた JSON 引数」 を tool 内部で実行→ランタイムエラーで死ぬよりも、
 * 構造的な hard gate で「contract 違反」 を即座に伝える。 T3 の壊れがちな
 * 引数生成に対する safety net としても機能する。
 */

export interface ValidationError {
  /** 違反フィールド (top level なら field 名、 nested なら "a.b.c") */
  field: string;
  /** 違反の種類 */
  kind: "missing" | "type-mismatch" | "enum-mismatch";
  /** 期待値 (型名 / enum 候補) */
  expected: string;
  /** 実際の値 (型名 or 値) */
  actual: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * tool 定義の parameters に対して params をバリデート。
 *
 * @param parameters - tool definition.function.parameters (JSON Schema 風)
 * @param params     - LLM から渡された実引数 (JSON.parse 済)
 * @returns valid=true なら問題なし。 valid=false なら errors にすべての違反
 */
export function validateAgainstSchema(
  parameters: Record<string, unknown>,
  params: Record<string, unknown>,
): ValidationResult {
  const errors: ValidationError[] = [];
  const required = (parameters.required as string[] | undefined) ?? [];
  const properties = (parameters.properties as Record<string, Record<string, unknown>> | undefined) ?? {};

  // required field 検査
  for (const reqField of required) {
    if (!(reqField in params) || params[reqField] === undefined || params[reqField] === null) {
      errors.push({
        field: reqField,
        kind: "missing",
        expected: String(properties[reqField]?.type ?? "value"),
        actual: "undefined",
      });
    }
  }

  // 各 property の型 / enum 検査
  for (const [field, schema] of Object.entries(properties)) {
    if (!(field in params)) continue; // 任意 field なのでスキップ
    const value = params[field];
    if (value === undefined || value === null) continue; // undefined / null は許容 (required で別途検出)

    const expectedType = schema.type as string | undefined;
    if (expectedType) {
      const actualType = jsonTypeOf(value);
      if (!matchesType(actualType, expectedType)) {
        errors.push({
          field,
          kind: "type-mismatch",
          expected: expectedType,
          actual: actualType,
        });
        continue; // 型違反なら enum チェックは無意味
      }
    }

    const enumVals = schema.enum as unknown[] | undefined;
    if (Array.isArray(enumVals) && enumVals.length > 0) {
      if (!enumVals.includes(value)) {
        errors.push({
          field,
          kind: "enum-mismatch",
          expected: enumVals.map((v) => JSON.stringify(v)).join(" | "),
          actual: JSON.stringify(value),
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/** JSON Schema の型と JS 値の型の対応 */
function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // "string" | "number" | "boolean" | "object" | "function" | "undefined"
}

/** 期待型と実型のマッチング (integer は number でも可とする等の柔軟性) */
function matchesType(actual: string, expected: string): boolean {
  if (actual === expected) return true;
  // JSON Schema "integer" は JS の "number" にマッチ (整数判定は別途必要なら厳密化)
  if (expected === "integer" && actual === "number") return true;
  // boolean を文字列で渡される LLM 事故を許容しない (= strict)
  return false;
}

/**
 * バリデーションエラーを LLM 向けの error 文字列に整形する。
 * 「次にどう直せばよいか」 が明確になるよう、 修正例を含める。
 */
export function formatValidationError(toolName: string, errors: ValidationError[]): string {
  const lines: string[] = [`[schema validation] ${toolName} の引数が contract 違反です:`];
  for (const e of errors) {
    if (e.kind === "missing") {
      lines.push(`  - 必須フィールド "${e.field}" がありません (期待型: ${e.expected})`);
    } else if (e.kind === "type-mismatch") {
      lines.push(`  - "${e.field}" の型が違います (期待: ${e.expected}, 実際: ${e.actual})`);
    } else if (e.kind === "enum-mismatch") {
      lines.push(`  - "${e.field}" の値が許可リスト外です (許可: ${e.expected}, 実際: ${e.actual})`);
    }
  }
  lines.push(``);
  lines.push(`次の手: 上記の違反を直して再実行してください。 同じ args での再試行は無効です。`);
  return lines.join("\n");
}
