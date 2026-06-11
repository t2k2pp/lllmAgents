/**
 * InteractionBridge レジストリ (docs/channel-interaction-bridge-design.md §2)
 *
 * source (slack / discord) → InteractionBridge の module singleton。
 * goal-slot / todo-write と同じ思想で、 PermissionManager や ask_user ツールへ
 * bridge をコンストラクタ経由で引き回さずに参照できるようにする。
 *
 * SlackBot / DiscordInteractionServer が start() で自分を登録し、 stop() で解除する。
 */

import type { RequestSource } from "../security/permission-manager.js";
import type { InteractionBridge } from "./agent-events.js";

const bridges = new Map<RequestSource, InteractionBridge>();

export function setInteractionBridge(source: RequestSource, bridge: InteractionBridge | null): void {
  if (bridge) {
    bridges.set(source, bridge);
  } else {
    bridges.delete(source);
  }
}

export function getInteractionBridge(source: RequestSource): InteractionBridge | null {
  return bridges.get(source) ?? null;
}

/** テスト用: 全登録を解除 */
export function clearInteractionBridges(): void {
  bridges.clear();
}
