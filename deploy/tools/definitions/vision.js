import * as fs from "node:fs";
import { collectResponse } from "../../providers/base-provider.js";
export class VisionService {
    provider;
    model;
    constructor(provider, model) {
        this.provider = provider;
        this.model = model;
    }
    async analyzeImage(imageBase64, prompt) {
        const gen = this.provider.chatWithVision({
            model: this.model,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: prompt },
                        { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}` } },
                    ],
                },
            ],
            temperature: 0.3,
            stream: true,
        });
        const response = await collectResponse(gen);
        return response.content;
    }
}
export function createVisionTool(visionService) {
    return {
        name: "vision_analyze",
        definition: {
            type: "function",
            function: {
                name: "vision_analyze",
                description: "画像を分析して内容を説明します。Base64エンコードされた画像データとプロンプトを渡してください。",
                parameters: {
                    type: "object",
                    properties: {
                        image_path: {
                            type: "string",
                            description: "分析する画像ファイルの絶対パス",
                        },
                        prompt: {
                            type: "string",
                            description: "画像について質問するプロンプト",
                        },
                    },
                    required: ["image_path", "prompt"],
                },
            },
        },
        async execute(params) {
            try {
                const imagePath = params.image_path;
                if (!fs.existsSync(imagePath)) {
                    return { success: false, output: "", error: `ファイルが見つかりません: ${imagePath}` };
                }
                const base64 = fs.readFileSync(imagePath, "base64");
                const result = await visionService.analyzeImage(base64, params.prompt);
                return { success: true, output: result };
            }
            catch (e) {
                return { success: false, output: "", error: String(e) };
            }
        },
    };
}
//# sourceMappingURL=vision.js.map