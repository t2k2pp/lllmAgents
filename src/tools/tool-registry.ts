import type { ToolDefinition } from "../providers/base-provider.js";
import type { AncestorTypes } from "../agent/delegation-context.js";
import type { WorkspaceContext } from "../agent/workspace-context.js";

/** ツール結果に付ける画像の形式 (docs/in-context-vision-design.md §3) */
export type ImageMimeType = "image/png" | "image/jpeg" | "image/webp";

/** ツール結果に付ける画像 1 枚。 検査は src/tools/image-attachment.ts */
export interface ImageAttachment {
  mimeType: ImageMimeType;
  /** base64 (data URL の前置きは付けない) */
  data: string;
  /** 何の画像か (ファイルのパス・MCP のツール名など)。 会話の見出しと、 退役後の置き換え文に使う */
  label: string;
}

/**
 * メインのモデルが画像を見られるか (起動時と接続先・モデルの切替で判定する。 docs/in-context-vision-design.md §2)。
 * - on: ツール結果の画像を会話に載せる
 * - off: 載せない (ツールは理由と vision_analyze を案内する文を返す)
 * - unknown: 判定できなかった (provider の失敗)。 載せずに理由を示す
 */
export interface ImageInputState {
  mode: "on" | "off" | "unknown";
  /** 決め手: config の明示 (mainLLM.vision) か provider の判定か */
  source: "config" | "provider";
  /** 表示用の説明 (モデル名・判定の理由・失敗の中身) */
  detail: string;
}

export interface ToolResult {
  success: boolean;
  output: string;
  /**
   * 結果に付ける画像。 メインのモデルが画像を見られるときだけツールが入れる。 AgentLoop が同じ応答の結果を
   * 全部入れた後に 1 件のハーネスの user メッセージとして会話に載せる (docs/in-context-vision-design.md §4)
   */
  images?: ImageAttachment[];
  error?: string;
  /**
   * 失敗の種別 (P4 circuit-breaker 用)。 "permanent" = 同一 params で再試行しても結論が
   * 変わらない恒久失敗 (権限拒否等)。 未指定 = 不明 (エラー文字列ヒューリスティックで判定)。
   */
  errorKind?: "permanent" | "transient";
  abortExecution?: boolean;
  /** ユーザー向け表示データ（LLMには送らない）。file_edit/file_writeのdiff表示等に使用 */
  userDisplay?: {
    type: "edit-diff" | "write-diff";
    filePath: string;
    oldString?: string;
    newString?: string;
    oldContent?: string | null;
    newContent?: string;
    occurrences?: number;
  };
}

/**
 * ツール実行時に呼び出し元エージェントの状態を伝える context (D1: 委任階層ガード)。
 * 大半のツールは無視してよい。 `task` / `second_llm_*` のみ ancestors を読み、
 * 子エージェントに伝播させる。
 */
export interface ToolExecutionContext {
  /** 呼出元エージェントの祖先系統 (メインなら空)。 子起動時に `extendAncestors` で 1 段拡張する */
  ancestors: AncestorTypes;
  /**
   * リクエストの発生元 (cli / discord / slack)。 ask_user 等の対話ツールが
   * チャネルブリッジへ委譲するかの判定に使う (docs/channel-interaction-bridge-design.md §4)。
   * 省略時は cli 扱い。
   */
  source?: "cli" | "discord" | "slack";
  /** agent固有のfilesystem実行境界。sub-agent worktreeではprocess.cwd()と異なる。 */
  workspace?: WorkspaceContext;
  /**
   * メインのモデルが画像を見られるか。 メインの AgentLoop だけが入れる。 無い経路 (サブエージェント等) は
   * 画像を会話に載せない (docs/in-context-vision-design.md §2)
   */
  imageInput?: ImageInputState;
  /** いまのタスクの依頼の原文 (vision_analyze が問いの前置きに使う。 取れなければ無し) */
  taskRequest?: string;
}

export interface ToolHandler {
  name: string;
  definition: ToolDefinition;
  execute(params: Record<string, unknown>, context?: ToolExecutionContext): Promise<ToolResult>;
  /** worktree agentからの利用可否。未指定の非core/plugin/MCP toolはfail-closed。 */
  workspacePolicy?: "aware" | "agnostic" | "forbidden";
}

export class ToolRegistry {
  private tools = new Map<string, ToolHandler>();
  /** 登録・解除の通知先 (道具の定義は送る並びの先頭に入るので、 AgentLoop が先読みを確かめる。 context-reduction-redesign.md §9.5) */
  private changeListeners = new Set<(name: string) => void>();

  /** 登録・解除の通知先を足す */
  addChangeListener(listener: (name: string) => void): void {
    this.changeListeners.add(listener);
  }

  private notifyChange(name: string): void {
    for (const listener of this.changeListeners) listener(name);
  }

  register(handler: ToolHandler): void {
    this.tools.set(handler.name, handler);
    this.notifyChange(handler.name);
  }

  /**
   * 登録済みツールを名前で削除する。 MCP server の即時 disable などに使う。
   * 削除できれば true、 そもそも未登録なら false。
   */
  unregister(name: string): boolean {
    const removed = this.tools.delete(name);
    if (removed) this.notifyChange(name);
    return removed;
  }

  get(name: string): ToolHandler | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  getToolNames(): string[] {
    return Array.from(this.tools.keys());
  }
}
