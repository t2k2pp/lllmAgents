import inquirer from "inquirer";
import { nonTTYReader } from "../../utils/non-tty-reader.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

const isTTY = process.stdin.isTTY === true;

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
      if (!isTTY) {
        // 非TTYモード: テキストベースのメニューを表示し、nonTTYReaderで入力を読む
        if (options && options.length > 0) {
          const allChoices = [...options, "その他（テキスト入力）"];
          console.log(`\n${question}`);
          allChoices.forEach((opt, i) => {
            console.log(`  ${i + 1}: ${opt}`);
          });
          console.log("番号を入力してください:");
          const line = await nonTTYReader.readLine();
          const idx = parseInt(line, 10) - 1;
          if (idx >= 0 && idx < options.length) {
            return { success: true, output: options[idx] };
          }
          if (idx === options.length) {
            // "その他" が選ばれた場合
            console.log("回答を入力してください:");
            const text = await nonTTYReader.readLine();
            return { success: true, output: text };
          }
          // 無効な番号の場合はデフォルト（最初の選択肢）
          return { success: true, output: options[0] };
        } else {
          console.log(`\n${question}`);
          console.log("回答を入力してください:");
          const answer = await nonTTYReader.readLine();
          return { success: true, output: answer };
        }
      }

      // TTYモード: inquirerを使用
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
