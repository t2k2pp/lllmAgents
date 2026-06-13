/**
 * RoomManager — 固定 3 Room(A/B/C) の永続会話スロットを管理する。
 * 設計: docs/room-model-design.md
 *
 * 役割:
 * - サーフェス(REPL/Discord/Slack)→既定 Room の binding を config 経由で保持・永続化。
 * - Room ごとの ConversationState を「ディスク永続セッション」として扱い、 単一 AgentLoop に
 *   restoreSession/saveCurrentSession で載せ替える(borrow-run-return)。
 * - 旧来の揮発な per-surface 会話ストア(in-memory)を置き換える。 PC 再起動でリモート会話が
 *   消えないよう、 各 Room の最後の会話はディスクから resume できる。
 *
 * 重要な不変条件:
 * - AgentLoop は単一インスタンス。 同時に 1 Room しかロードできない(currentAgentRoom)。
 * - 受信順グローバル FIFO キュー(room-run-queue.ts)が run を直列化している前提で swap する
 *   (run 実行中に swap してはならない)。
 * - agent の「resting room」 = REPL の binding。 背景ジョブ(Discord/Slack)は対象 Room を
 *   borrow して run し、 終わったら resting room へ restore して返す。
 */

import type { Config } from "../config/types.js";
import { saveConfig } from "../config/config-manager.js";
import { ROOM_IDS, getDefaultRoomConfig, type RoomId, type Surface } from "./room-types.js";
import {
  createSession,
  loadSession,
  latestSessionMetaOfRoom,
  type SessionData,
} from "./session-manager.js";
import type { AgentLoop } from "./agent-loop.js";

export interface RoomStatus {
  id: RoomId;
  /** この Room が今ロードされている (= agent の現セッション) か */
  active: boolean;
  /** REPL の現バインド先か */
  replBound: boolean;
  autoResume: boolean;
  sessionId: string | null;
  messageCount: number;
  title: string;
  /** バインドされているサーフェス一覧 (表示用) */
  surfaces: Surface[];
}

export class RoomManager {
  /** この process で各 Room が現在使っているセッション ID (揮発・再起動で再導出)。 */
  private activeSessionId = new Map<RoomId, string | null>();
  /** agent に今ロードされている Room (null = 未初期化)。 */
  private currentAgentRoom: RoomId | null = null;

  constructor(
    private config: Config,
    private agent: AgentLoop,
  ) {
    if (!this.config.roomConfig) {
      this.config.roomConfig = getDefaultRoomConfig();
    }
  }

  // ─── binding / 設定 ───

  bindingFor(surface: Surface): RoomId {
    return this.config.roomConfig!.bindings[surface];
  }

  autoResumeFor(room: RoomId): boolean {
    return this.config.roomConfig!.autoResume[room];
  }

  /** REPL のバインド先 = agent の resting room。 */
  restingRoom(): RoomId {
    return this.bindingFor("repl");
  }

  setAutoResume(room: RoomId, value: boolean): void {
    this.config.roomConfig!.autoResume[room] = value;
    saveConfig(this.config);
  }

  /**
   * サーフェスの既定 Room を変更して永続化する。 REPL の移動は即座に agent を載せ替える
   * (resting room が変わるため)。 Discord/Slack の移動は次のジョブから反映される。
   */
  moveSurface(surface: Surface, room: RoomId): void {
    this.config.roomConfig!.bindings[surface] = room;
    saveConfig(this.config);
    if (surface === "repl") this.swapAgentTo(room);
  }

  // ─── startup ───

  /**
   * REPL 起動時に呼ぶ。 index.ts の --resume/--continue 処理の後に実行し、 agent が現在
   * 持っているセッション(新規 or resume 済み)を REPL の Room にタグして登録する。
   * REPL は autoResume=false 既定のため、 ここで自動 resume はしない(起動時新規は index.ts が担う)。
   */
  initReplSession(): void {
    // 既に room タグ済みのセッション (--resume/--continue で復元) はそのタグを尊重し、
    // 未タグ (新規 or 旧セッション) のみ REPL の Room にタグする。
    const existing = this.agent.getCurrentSessionRoom();
    const room = existing ?? this.bindingFor("repl");
    if (!existing) this.agent.tagSessionRoom(room);
    this.activeSessionId.set(room, this.agent.getCurrentSessionId());
    this.currentAgentRoom = room;
  }

  /**
   * --background (Discord) / --slack で REPL を使わない起動時に呼ぶ。 当該サーフェスの Room を
   * resting room として確定する。 autoResume=true なら起動時にその Room の最後の会話を復元し、
   * 無ければ起動時の新規セッションをその Room にタグする。
   */
  initBackgroundSurface(surface: Surface): void {
    const room = this.bindingFor(surface);
    if (this.autoResumeFor(room)) {
      const meta = latestSessionMetaOfRoom(room);
      const data = meta ? loadSession(meta.id) : null;
      if (data) {
        this.agent.restoreSession(data);
        this.activeSessionId.set(room, data.meta.id);
        this.currentAgentRoom = room;
        return;
      }
    }
    this.agent.tagSessionRoom(room);
    this.activeSessionId.set(room, this.agent.getCurrentSessionId());
    this.currentAgentRoom = room;
  }

  // ─── 実行 (borrow-run-return) ───

  /**
   * 指定 Room の会話に載せ替えて fn を実行し、 結果を保存して resting room へ戻す。
   * 受信順 FIFO キューのジョブ本体から呼ぶ(直列化済み前提)。
   */
  async runInRoom<T>(room: RoomId, fn: () => Promise<T>): Promise<T> {
    const resting = this.currentAgentRoom ?? this.restingRoom();
    this.swapAgentTo(room);
    try {
      const result = await fn();
      // run 後の状態を保存(ターン毎永続化)。
      this.agent.saveCurrentSession();
      this.activeSessionId.set(room, this.agent.getCurrentSessionId());
      return result;
    } finally {
      if (resting !== room) this.swapAgentTo(resting);
    }
  }

  // ─── 手動 Resume / status ───

  /** 指定 Room の最後の会話(ディスク)を resume 対象にする。 現在その Room にいれば即載せ替え。 */
  resumeRoom(room: RoomId): boolean {
    const meta = latestSessionMetaOfRoom(room);
    if (!meta) return false;
    this.activeSessionId.set(room, meta.id);
    if (this.currentAgentRoom === room) {
      const data = loadSession(meta.id);
      if (data) this.agent.restoreSession(data);
    }
    return true;
  }

  /** 現在 agent がいる Room。 */
  current(): RoomId | null {
    return this.currentAgentRoom;
  }

  status(): RoomStatus[] {
    const bindings = this.config.roomConfig!.bindings;
    return ROOM_IDS.map((id) => {
      const sid = this.activeSessionId.get(id) ?? null;
      let meta = sid ? loadSession(sid)?.meta ?? null : null;
      if (!meta) meta = latestSessionMetaOfRoom(id);
      const surfaces = (Object.keys(bindings) as Surface[]).filter((s) => bindings[s] === id);
      return {
        id,
        active: this.currentAgentRoom === id,
        replBound: bindings.repl === id,
        autoResume: this.autoResumeFor(id),
        sessionId: meta?.id ?? null,
        messageCount: meta?.messageCount ?? 0,
        title: meta?.title ?? "",
        surfaces,
      };
    });
  }

  // ─── 内部: swap ───

  /**
   * agent を指定 Room のセッションに載せ替える。 現 Room を保存してから対象をロードする。
   * run 実行中に呼んではならない(キューで直列化されている前提)。
   */
  private swapAgentTo(room: RoomId): void {
    if (this.currentAgentRoom === room) return;
    if (this.currentAgentRoom !== null) {
      this.agent.saveCurrentSession();
      this.activeSessionId.set(this.currentAgentRoom, this.agent.getCurrentSessionId());
    }
    const data = this.resolveRoomSession(room);
    this.agent.restoreSession(data);
    this.activeSessionId.set(room, data.meta.id);
    this.currentAgentRoom = room;
  }

  /**
   * Room のセッションを解決する。
   * 1. この process で既にアクティブなセッション ID があればそれをロード(継続)。
   * 2. 初回かつ autoResume=true なら、 ディスクの最後の会話を resume。
   * 3. それも無ければ新規セッション(meta.room=room)を作る。
   */
  private resolveRoomSession(room: RoomId): SessionData {
    const sid = this.activeSessionId.get(room);
    if (sid) {
      const data = loadSession(sid);
      if (data) return data;
    }
    if (this.autoResumeFor(room)) {
      const meta = latestSessionMetaOfRoom(room);
      if (meta) {
        const data = loadSession(meta.id);
        if (data) return data;
      }
    }
    return createSession(this.agent.getModel(), room);
  }
}
