/**
 * 委任階層トラッキング (D1: ancestorTypes ベース委任ガード)
 *
 * メイン → サブエージェント → セカンドLLM のような **異種 1 段** の委任は許可するが、
 * 孫世代での再委任 (sub→second→sub / second→sub→second) と、 同種再帰 (sub→sub /
 * second→second) は構造的に拒否する。
 *
 * 実装方針: 各エージェント実行コンテキストが祖先の系統セット (`AncestorTypes`) を保持し、
 * 子エージェント生成時に `excludedToolsFor(ancestors)` で `task` / `second_llm_*` を
 * ToolRegistry から除外する。 モデルからはツール定義そのものが見えないため、 ガード破りは
 * 原理的に不可能。
 *
 * 関連設計: `docs/main-second-subagent-comparison.md` §6.1, `docs/v030_second_llm_design.md` §2.3
 */
import type { ToolHandler, ToolRegistry } from "../tools/tool-registry.js";
import { ToolRegistry as ToolRegistryImpl } from "../tools/tool-registry.js";

/** 委任の系統。 sub = サブエージェント / second = セカンドLLM */
export type DelegationOrigin = "sub" | "second";

/** 祖先の系統セット。 メインは ∅、 sub-from-main は {sub}、 sub→second→孫 sub は {sub, second} 等 */
export type AncestorTypes = ReadonlySet<DelegationOrigin>;

/** メインLLM (オーケストレータ) の ancestors。 委任の起点 */
export const ROOT_ANCESTORS: AncestorTypes = Object.freeze(new Set<DelegationOrigin>());

/** ancestors に origin を 1 つ追加した新しいセットを返す (immutable) */
export function extendAncestors(current: AncestorTypes, origin: DelegationOrigin): AncestorTypes {
  const next = new Set<DelegationOrigin>(current);
  next.add(origin);
  return next;
}

/**
 * 与えられた祖先セットに対して、 子コンテキストで除外すべきツール名を返す。
 *
 * - 共通: `enter_plan_mode` / `exit_plan_mode` は子では常に禁止 (リーダー専権)
 * - `ancestors.has("sub")` → `task` / `task_output` / lifecycle管理toolを除外
 *   (sub 同種再帰禁止 + main orchestrator専権)
 * - `ancestors.has("second")` → `second_llm_agent` を除外
 *   (second 同種再帰禁止 + 孫からの second 起動禁止)
 */
export function excludedToolsFor(ancestors: AncestorTypes): Set<string> {
  const excluded = new Set<string>(["enter_plan_mode", "exit_plan_mode"]);
  // scheduleはmain REPLの将来turnへpromptを注入する操作。子の独立contextからは公開しない。
  if (ancestors.size > 0) {
    excluded.add("schedule_create");
    excluded.add("schedule_list");
    excluded.add("schedule_delete");
    excluded.add("task_list");
    excluded.add("task_cancel");
  }
  if (ancestors.has("sub")) {
    excluded.add("task");
    excluded.add("task_output");
  }
  if (ancestors.has("second")) {
    excluded.add("second_llm_agent");
  }
  return excluded;
}

/**
 * 親 ToolRegistry から、 子エージェント (ancestors を持つ) 用にフィルタリング済みの
 * 新 ToolRegistry を作る。
 *
 * @param registry 親 (= メインの全ツールを持つ) ToolRegistry
 * @param ancestors 子エージェントの ancestors。 これに含まれる origin の同種ツールは除外
 * @param allowedTools 明示的なホワイトリスト。 指定があればそれと excluded の両方を適用
 *   (= ホワイトリスト ∩ 非除外)
 */
export function filterRegistryForAncestors(
  registry: ToolRegistry,
  ancestors: AncestorTypes,
  allowedTools?: readonly string[],
): ToolRegistry {
  const excluded = excludedToolsFor(ancestors);
  const allowed = allowedTools && allowedTools.length > 0 ? new Set(allowedTools) : null;
  const filtered = new ToolRegistryImpl();
  for (const name of registry.getToolNames()) {
    if (excluded.has(name)) continue;
    if (allowed && !allowed.has(name)) continue;
    const handler: ToolHandler | undefined = registry.get(name);
    if (handler) filtered.register(handler);
  }
  return filtered;
}
