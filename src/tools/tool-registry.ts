import type { ToolDefinition } from "../providers/base-provider.js";
import type { AncestorTypes } from "../agent/delegation-context.js";
import type { WorkspaceContext } from "../agent/workspace-context.js";

export interface ToolResult {
  success: boolean;
  output: string;
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

  register(handler: ToolHandler): void {
    this.tools.set(handler.name, handler);
  }

  /**
   * 登録済みツールを名前で削除する。 MCP server の即時 disable などに使う。
   * 削除できれば true、 そもそも未登録なら false。
   */
  unregister(name: string): boolean {
    return this.tools.delete(name);
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
