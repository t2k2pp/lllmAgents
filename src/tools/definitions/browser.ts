import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import type { PlaywrightManager } from "../../browser/playwright-manager.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export function createBrowserTools(manager: PlaywrightManager): ToolHandler[] {
  /**
   * P2-A: browser_snapshot 結果のキャッシュ。 同一 DOM のままキャプチャを連発する
   * (引数 `{}` で 19 連発の事例あり) ことを抑止するため、 直前の snapshot のハッシュ
   * と一致したら短い「変化なし」 レスポンスのみ返す。
   * docs/agent-loop-efficiency-review.md §4.5 参照。
   */
  let lastSnapshotHash = "";
  let lastSnapshotLen = 0;
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
        // P2-A: ナビゲーション = DOM 全更新なので snapshot キャッシュを無効化
        lastSnapshotHash = "";
        lastSnapshotLen = 0;
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
        description:
          "現在のページのアクセシビリティツリーを取得します。 ページの構造と内容をテキストで確認できます。\n" +
          "[副次情報] 直前の snapshot から DOM が変化していなければ、 短縮レスポンスのみ返す (= 連発しても情報は増えない)。",
        parameters: { type: "object", properties: {} },
      },
    },
    async execute(): Promise<ToolResult> {
      try {
        const tree = await manager.snapshot();
        // P2-A: 直前と同一なら短縮レスポンス。 click/navigate/type 系で DOM が
        // 変わったら別ハンドラ側で lastSnapshotHash をクリアする。
        const hash = crypto.createHash("sha1").update(tree).digest("hex");
        if (hash === lastSnapshotHash) {
          return {
            success: true,
            output:
              `[browser_snapshot] no changes since previous snapshot (hash=${hash.slice(0, 8)}, ${lastSnapshotLen} chars). ` +
              `前回と DOM が変わっていません。 別の操作 (click/type/navigate) を行ってから再取得するか、 別アプローチを検討してください。`,
          };
        }
        lastSnapshotHash = hash;
        lastSnapshotLen = tree.length;
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
        // P2-A: クリックは DOM 変更を起こす可能性 → snapshot キャッシュを無効化
        lastSnapshotHash = "";
        lastSnapshotLen = 0;
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
        // P2-A: 入力は DOM 変更を起こす → snapshot キャッシュを無効化
        lastSnapshotHash = "";
        lastSnapshotLen = 0;
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
            save_path: {
              type: "string",
              description:
                "指定された場合、スクリーンショットを指定したローカルパスの画像ファイル(PNG)として保存します。ファイルに保存したい場合はこの引数を使用してください。",
            },
          },
        },
      },
    },
    async execute(params): Promise<ToolResult> {
      try {
        const buf = await manager.screenshot();
        const savePath = params?.save_path as string | undefined;

        // 保存先が指定されていない場合はOSの一時ディレクトリへ保存
        const targetPath = savePath ?? path.join(os.tmpdir(), `lllmagent-screenshot-${Date.now()}.png`);

        const fs = await import("fs/promises");
        await fs.writeFile(targetPath, buf);

        return {
          success: true,
          output: `Screenshot saved to: ${targetPath}\nYou can use vision_analyze with image_path="${targetPath}" to analyze this screenshot.`,
        };
      } catch (e) {
        return { success: false, output: "", error: String(e) };
      }
    },
  };

  return [browserNavigate, browserSnapshot, browserClick, browserType, browserScreenshot];
}
