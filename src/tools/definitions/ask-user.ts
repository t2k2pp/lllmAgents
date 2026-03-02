import inquirer from "inquirer";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

export const askUserTool: ToolHandler = {
  name: "ask_user",
  definition: {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "ユーザーに質問して回答を得ます。選択肢を提示することもできます。要件の確認や方針決定に使います。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "ユーザーへの質問",
          },
          options: {
            type: "array",
            description: "選択肢のリスト（省略時は自由テキスト入力）",
            items: { type: "string" },
          },
        },
        required: ["question"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const question = params.question as string;
    const options = params.options as string[] | undefined;

    try {
      if (options && options.length > 0) {
        const { answer } = await inquirer.prompt<{ answer: string }>([
          {
            type: "list",
            name: "answer",
            message: question,
            choices: [...options, "その他（テキスト入力）"],
          },
        ]);

        if (answer === "その他（テキスト入力）") {
          const { text } = await inquirer.prompt<{ text: string }>([
            { type: "input", name: "text", message: "回答:" },
          ]);
          return { success: true, output: text };
        }
        return { success: true, output: answer };
      } else {
        const { answer } = await inquirer.prompt<{ answer: string }>([
          { type: "input", name: "answer", message: question },
        ]);
        return { success: true, output: answer };
      }
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};
