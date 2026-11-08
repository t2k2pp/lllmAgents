import type { MCPServerPermissionLevel, MCPToolAnnotations, MCPToolPermissionLevel } from "../mcp/types.js";
import { type InspectorContext, type InspectorResult, inspectBlenderCode } from "./blender-code-inspector.js";

/**
 * MCP ツールの権限の決め方 (docs/mcp-tool-permission-design.md)。
 *
 * MCPManager がツールを登録するときに、 サーバーの設定 (mcp-servers.json の permissionLevel・tools) と
 * tools/list の注釈 (annotations) をここへ書き、 PermissionManager が呼び出しのたびに引く。
 *
 * 3 つの層 (この順に見る。 deny / ask ルール・CoT 不整合は PermissionManager が先に見る):
 *  3. 中身の検査器: ツールの値が "inspect" なら、 登録された検査器が引数を見て allow / ask を返す
 *  1. 設定: "auto" は常に許可・"autorun" は自律実行モードの間だけ許可・"ask" は確認
 *  2. 注釈: 設定が無いツールは、 自律実行モードの間 readOnlyHint=true なら許可。 destructiveHint=true は確認
 */

export interface McpToolPolicyInfo {
  server: string;
  tool: string;
  serverLevel?: MCPServerPermissionLevel;
  toolLevel?: MCPToolPermissionLevel;
  annotations?: MCPToolAnnotations;
}

/**
 * 判定の結果。
 * - allow: 確認せずに許可
 * - ask: 確認へ (reason は確認の画面に出す)。 ツール名だけの allow ルール・セッション中の許可は従来どおり効く
 * - null: MCP の決まりでは決めない (従来の流れ)
 */
export type McpPolicyDecision = { decision: "allow"; reason: string } | { decision: "ask"; reason?: string } | null;

export type McpContentInspector = (params: Record<string, unknown>, ctx: InspectorContext) => InspectorResult;

const SERVER_LEVELS = new Set(["ask", "auto", "autorun"]);
const TOOL_LEVELS = new Set(["ask", "auto", "autorun", "inspect"]);

export function isServerPermissionLevel(v: unknown): v is MCPServerPermissionLevel {
  return typeof v === "string" && SERVER_LEVELS.has(v);
}

export function isToolPermissionLevel(v: unknown): v is MCPToolPermissionLevel {
  return typeof v === "string" && TOOL_LEVELS.has(v);
}

const toolPolicies = new Map<string, McpToolPolicyInfo>();
const inspectors = new Map<string, McpContentInspector>();

/** 検査器の鍵: サーバーを決めるなら "server:tool"、 どのサーバーでもよいなら "*:tool" */
function inspectorKey(server: string | undefined, tool: string): string {
  return `${server ?? "*"}:${tool}`;
}

export function registerMcpContentInspector(
  target: { server?: string; tool: string },
  inspector: McpContentInspector,
): void {
  inspectors.set(inspectorKey(target.server, target.tool), inspector);
}

export function findMcpContentInspector(server: string, tool: string): McpContentInspector | undefined {
  return inspectors.get(inspectorKey(server, tool)) ?? inspectors.get(inspectorKey(undefined, tool));
}

export function registerMcpToolPolicy(fullName: string, info: McpToolPolicyInfo): void {
  toolPolicies.set(fullName, info);
}

export function unregisterMcpServerPolicies(server: string): void {
  for (const [name, info] of toolPolicies) {
    if (info.server === server) toolPolicies.delete(name);
  }
}

export function getMcpToolPolicy(fullName: string): McpToolPolicyInfo | undefined {
  return toolPolicies.get(fullName);
}

/** テスト用: 登録を全部消し、 組み込みの検査器だけ戻す */
export function resetMcpToolPolicies(): void {
  toolPolicies.clear();
  inspectors.clear();
  registerBuiltinInspectors();
}

function registerBuiltinInspectors(): void {
  // Blender MCP (mcp-for-blender) の任意 Python 実行。 サーバー名を変えても効くようにツール名だけで引く
  registerMcpContentInspector({ tool: "execute_blender_code" }, (params, ctx) => inspectBlenderCode(params.code, ctx));
}
registerBuiltinInspectors();

/**
 * MCP ツールの決まりで判定する。
 * @param autorunActive その面の自律実行モード (CLI は /autorun、 Discord/Slack は discordAutorun/slackAutorun)
 */
export function evaluateMcpToolPolicy(
  fullName: string,
  params: Record<string, unknown>,
  autorunActive: boolean,
  cwd: string = process.cwd(),
): McpPolicyDecision {
  const info = toolPolicies.get(fullName);
  if (!info) return null;
  const explicitTool = info.toolLevel !== undefined;
  const level: MCPToolPermissionLevel | undefined = info.toolLevel ?? info.serverLevel;
  const destructive = info.annotations?.destructiveHint === true;
  const readOnly = info.annotations?.readOnlyHint === true;

  // 層 3: 中身の検査器
  if (level === "inspect") {
    const inspector = findMcpContentInspector(info.server, info.tool);
    if (!inspector)
      return { decision: "ask", reason: `${info.tool} の検査器が登録されていない ("inspect" は確認として扱う)` };
    let result: InspectorResult;
    try {
      result = inspector(params, { cwd });
    } catch (e) {
      return { decision: "ask", reason: `検査器が失敗した (${e instanceof Error ? e.message : String(e)})` };
    }
    if (result.decision === "ask") return { decision: "ask", reason: `検査器: ${result.reason}` };
    // 検査を通っても、 自動で許可するのは自律実行モードの間だけ (通常モードは従来どおり確認)
    return autorunActive ? { decision: "allow", reason: "検査器が通した" } : null;
  }

  // 層 1: 設定。 サーバー全体の auto/autorun は destructiveHint のツールまでは広げない (ツールごとの指定は広げる)
  if (level === "auto" || (level === "autorun" && autorunActive)) {
    if (destructive && !explicitTool) {
      return { decision: "ask", reason: "サーバーが destructiveHint (壊す操作) と申告している" };
    }
    return {
      decision: "allow",
      reason: `mcp-servers.json の ${explicitTool ? "tools" : "permissionLevel"} = ${level}`,
    };
  }
  if (level !== undefined) return null; // "ask"、 または autorun が切れている "autorun" は従来の流れ

  // 層 2: 注釈 (設定が無いときだけ)
  if (destructive) return { decision: "ask", reason: "サーバーが destructiveHint (壊す操作) と申告している" };
  if (readOnly && autorunActive)
    return { decision: "allow", reason: "サーバーが readOnlyHint (読むだけ) と申告している" };
  return null;
}
