import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
import type { PlaywrightManager } from "../../browser/playwright-manager.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

/**
 * game_smoke ツール (docs/checkpoint-and-smoke-design.md §5)。
 * ブラウザ成果物 (HTML ゲーム等) を headless 起動し、「破滅的・機械的失敗」だけを検知する。
 * - 検知する: 未捕捉例外 / console error / 真っ黒・空 canvas / 入力後フリーズ
 * - 検知しない: 操作感・ゲームバランス・面白さ (= 人間が確認する領域)
 *
 * game-development スキルの完了ゲートから呼ばれることを想定。
 */
export function createGameSmokeTool(manager: PlaywrightManager): ToolHandler {
  const gameSmoke: ToolHandler = {
    name: "game_smoke",
    definition: {
      type: "function",
      function: {
        name: "game_smoke",
        description:
          "ブラウザ成果物 (HTML ゲーム等) を headless で起動し、破滅的・機械的な失敗を検知します。\n" +
          "未捕捉例外・console error・真っ黒/空 canvas・入力後フリーズを自動チェックし、PASS/FAIL を返します。\n" +
          "ゲーム性・操作感・バランスは判定しません (人間の確認領域)。\n" +
          "ゲームを保存した後、『動く』と宣言する前にこのツールで最低限の動作を確認してください。\n" +
          "CLI/ターン制ゲーム (将棋・トランプ等) で動きの少ないものには不要です。",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description:
                "検証する HTML ファイルの絶対パス (例: /.../output/games/foo/index.html)。url とどちらか一方を指定。",
            },
            url: {
              type: "string",
              description: "検証する URL (http(s):// または file://)。path とどちらか一方を指定。",
            },
            settle_ms: {
              type: "number",
              description: "ロード後に待つミリ秒 (既定 1500)。重い初期化があれば増やす。",
            },
          },
        },
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const rawPath = params.path as string | undefined;
        const rawUrl = params.url as string | undefined;

        let url: string;
        if (rawUrl) {
          url = rawUrl;
        } else if (rawPath) {
          if (!path.isAbsolute(rawPath)) {
            return {
              success: false,
              output: "",
              error: `path は絶対パスで指定してください: ${rawPath}`,
            };
          }
          if (!fs.existsSync(rawPath)) {
            return {
              success: false,
              output: "",
              error: `ファイルが見つかりません: ${rawPath}`,
            };
          }
          url = pathToFileURL(rawPath).href;
        } else {
          return {
            success: false,
            output: "",
            error: "path または url のいずれかを指定してください。",
          };
        }

        const settleMs = typeof params.settle_ms === "number" ? params.settle_ms : undefined;
        const r = await manager.runSmoke(url, settleMs ? { settleMs } : undefined);

        const lines: string[] = [];
        lines.push(`[game_smoke] ${r.verdict.toUpperCase()} — ${url}`);
        if (r.verdict === "fail") {
          lines.push(`理由: ${r.reasons.join(" / ")}`);
          lines.push(
            "※ 直前まで動いていたのに壊れた場合は、 前進修正を重ねる前に、 チェックポイントが有効なら " +
              "`/checkpoint list` → `/checkpoint restore <n>` で直前の動く版へ戻すことをユーザーに提案してください。",
          );
        } else {
          lines.push("破滅的な失敗は検知されませんでした (※ゲーム性・操作感は未検証。人間の試遊で確認してください)。");
        }
        lines.push("");
        lines.push(`- 未捕捉例外: ${r.pageErrors.length} 件`);
        for (const e of r.pageErrors.slice(0, 5)) lines.push(`    • ${e}`);
        lines.push(`- console error: ${r.consoleErrors.length} 件`);
        for (const e of r.consoleErrors.slice(0, 5)) lines.push(`    • ${e}`);
        lines.push(
          `- canvas 空判定: ${r.blankCanvas === null ? "判定不能 (canvas無し/WebGL)" : r.blankCanvas ? "空" : "描画あり"}`,
        );
        lines.push(`- 入力後の画面変化: ${r.changedAfterInput ? "あり" : "なし (フリーズ疑い)"}`);

        return { success: true, output: lines.join("\n") };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };

  return gameSmoke;
}
