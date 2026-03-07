import type { PlaywrightManager } from "../../browser/playwright-manager.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export function createBrowserTools(manager: PlaywrightManager): ToolHandler[] {
  const browserNavigate: ToolHandler = {
    name: "browser_navigate",
    definition: {
      type: "function",
      function: {
        name: "browser_navigate",
        description: "ブラウザでURLを開きます。",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "開くURL" },
          },
          required: ["url"],
        },
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const url = params.url as string;
        const finalUrl = await manager.navigate(url);
        return { success: true, output: `Navigated to: ${finalUrl}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };

  const browserSnapshot: ToolHandler = {
    name: "browser_snapshot",
    definition: {
      type: "function",
      function: {
        name: "browser_snapshot",
        description: "現在のページのアクセシビリティツリーを取得します。ページの構造と内容をテキストで確認できます。",
        parameters: { type: "object", properties: {} },
      },
    },
    async execute(): Promise<ToolResult> {
      try {
        const tree = await manager.snapshot();
        return { success: true, output: tree };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };

  const browserClick: ToolHandler = {
    name: "browser_click",
    definition: {
      type: "function",
      function: {
        name: "browser_click",
        description: "ページ上の要素をCSSセレクタでクリックします。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "クリックする要素のCSSセレクタ" },
          },
          required: ["selector"],
        },
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        await manager.click(params.selector as string);
        return { success: true, output: `Clicked: ${params.selector}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };

  const browserType: ToolHandler = {
    name: "browser_type",
    definition: {
      type: "function",
      function: {
        name: "browser_type",
        description: "ページ上の入力フィールドにテキストを入力します。",
        parameters: {
          type: "object",
          properties: {
            selector: { type: "string", description: "入力フィールドのCSSセレクタ" },
            text: { type: "string", description: "入力するテキスト" },
          },
          required: ["selector", "text"],
        },
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        await manager.type(params.selector as string, params.text as string);
        return { success: true, output: `Typed into: ${params.selector}` };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };

  const browserScreenshot: ToolHandler = {
    name: "browser_screenshot",
    definition: {
      type: "function",
      function: {
        name: "browser_screenshot",
        description: "現在のページのスクリーンショットを取得します。画像認識LLMで分析されます。",
        parameters: {
          type: "object",
          properties: {
            save_path: { type: "string", description: "指定された場合、スクリーンショットを指定したローカルパスの画像ファイル(PNG)として保存します。ファイルに保存したい場合はこの引数を使用してください。" },
          },
        },
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const buf = await manager.screenshot();
        const savePath = params?.save_path as string | undefined;
        if (savePath) {
          const fs = await import("fs/promises");
          await fs.writeFile(savePath, buf);
          return {
            success: true,
            output: `Screenshot successfully saved to: ${savePath}`,
          };
        }

        return {
          success: true,
          output: `Screenshot captured (${buf.length} bytes, base64: ${buf.toString("base64").slice(0, 100)}...).`,
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };

  return [browserNavigate, browserSnapshot, browserClick, browserType, browserScreenshot];
}
