import * as os from "node:os";
import * as path from "node:path";
export function createBrowserTools(manager) {
    const browserNavigate = {
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
        async execute(params) {
            try {
                const url = params.url;
                const finalUrl = await manager.navigate(url);
                return { success: true, output: `Navigated to: ${finalUrl}` };
            }
            catch (e) {
                return { success: false, output: "", error: String(e) };
            }
        },
    };
    const browserSnapshot = {
        name: "browser_snapshot",
        definition: {
            type: "function",
            function: {
                name: "browser_snapshot",
                description: "現在のページのアクセシビリティツリーを取得します。ページの構造と内容をテキストで確認できます。",
                parameters: { type: "object", properties: {} },
            },
        },
        async execute() {
            try {
                const tree = await manager.snapshot();
                return { success: true, output: tree };
            }
            catch (e) {
                return { success: false, output: "", error: String(e) };
            }
        },
    };
    const browserClick = {
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
        async execute(params) {
            try {
                await manager.click(params.selector);
                return { success: true, output: `Clicked: ${params.selector}` };
            }
            catch (e) {
                return { success: false, output: "", error: String(e) };
            }
        },
    };
    const browserType = {
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
        async execute(params) {
            try {
                await manager.type(params.selector, params.text);
                return { success: true, output: `Typed into: ${params.selector}` };
            }
            catch (e) {
                return { success: false, output: "", error: String(e) };
            }
        },
    };
    const browserScreenshot = {
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
        async execute(params) {
            try {
                const buf = await manager.screenshot();
                const savePath = params?.save_path;
                // 保存先が指定されていない場合はOSの一時ディレクトリへ保存
                const targetPath = savePath ?? path.join(os.tmpdir(), `lllmagent-screenshot-${Date.now()}.png`);
                const fs = await import("fs/promises");
                await fs.writeFile(targetPath, buf);
                return {
                    success: true,
                    output: `Screenshot saved to: ${targetPath}\nYou can use vision_analyze with image_path="${targetPath}" to analyze this screenshot.`,
                };
            }
            catch (e) {
                return { success: false, output: "", error: String(e) };
            }
        },
    };
    return [browserNavigate, browserSnapshot, browserClick, browserType, browserScreenshot];
}
//# sourceMappingURL=browser.js.map