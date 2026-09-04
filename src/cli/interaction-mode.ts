export type InteractionMode = "default" | "autorun" | "plan";

export function currentInteractionMode(plan: boolean, autorun: boolean): InteractionMode {
  if (plan) return "plan";
  return autorun ? "autorun" : "default";
}

/** Claude Codeの操作順に合わせる: default → auto/autorun → plan → default。 */
export function nextInteractionMode(mode: InteractionMode): InteractionMode {
  if (mode === "default") return "autorun";
  if (mode === "autorun") return "plan";
  return "default";
}
