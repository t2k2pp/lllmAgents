/**
 * Room モデルの共有型。 docs/room-model-design.md 参照。
 *
 * Room = 名前付き(A/B/C)の永続的な会話スロット。 サーフェス(REPL/Discord/Slack)は
 * それぞれ既定 Room を持ち、 途中で別 Room に移動して覗き見/継続できる。
 *
 * 循環依存を避けるため、 session-manager / config / room-manager から参照される
 * 純粋な型・定数だけをここに置く (実装ロジックは持たない)。
 */

/** 固定 3 Room。 増減はしない (設計 §4)。 */
export type RoomId = "A" | "B" | "C";

export const ROOM_IDS: readonly RoomId[] = ["A", "B", "C"];

/** 入力面。 */
export type Surface = "repl" | "discord" | "slack";

export const SURFACES: readonly Surface[] = ["repl", "discord", "slack"];

/** config.json に保持する Room 設定 (純粋な設定。 currentSessionId は持たない = §5/§10-4)。 */
export interface RoomConfig {
  /** サーフェス→既定 Room。 既定 REPL=A / Discord=B / Slack=C。 */
  bindings: Record<Surface, RoomId>;
  /** Room ごとの自動 Resume。 既定 B/C=true (モバイル) / A=false (PC は起動毎に新規)。 */
  autoResume: Record<RoomId, boolean>;
}

/** roomConfig 未設定時の既定値。 */
export function getDefaultRoomConfig(): RoomConfig {
  return {
    bindings: { repl: "A", discord: "B", slack: "C" },
    autoResume: { A: false, B: true, C: true },
  };
}

/** 任意値が RoomId か検証する (ユーザー入力のバリデーション用)。 */
export function isRoomId(value: unknown): value is RoomId {
  return value === "A" || value === "B" || value === "C";
}

/** "a" / "room b" / "B" 等を RoomId へ正規化。 不正なら null。 */
export function normalizeRoomId(input: string): RoomId | null {
  const m = input.trim().toUpperCase().replace(/^ROOM\s*/, "");
  return isRoomId(m) ? m : null;
}
