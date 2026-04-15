import inquirer from "inquirer";
import { nonTTYReader } from "../../utils/non-tty-reader.js";
import type { ToolHandler, ToolResult } from "../tool-registry.js";

const isTTY = process.stdin.isTTY === true;

interface AskUserOption {
  label: string;
  description: string;
}

export const askUserTool: ToolHandler = {
  name: "ask_user",
  definition: {
    type: "function",
    function: {
      name: "ask_user",
      description: `ユーザーに質問して回答を得る。要件の確認・方針決定・実装選択に使う。
ユーザーは常に「その他（自由入力）」を選べるので、選択肢で全パターンを網羅する必要はない。

## 選択肢の作り方
- 2〜4個に絞る。多すぎると選びにくい
- 推奨がある場合は先頭に置き、labelの末尾に「(推奨)」を付ける
- labelは簡潔に（1〜5語）、descriptionでトレードオフや影響を説明する
- ユーザーが言語化できていなさそうな場合こそ選択肢を用意する
- multiSelectは排他的でない選択肢（複数同時に選べるもの）に使う`,
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "ユーザーへの質問。明確・具体的に、疑問形で書く",
          },
          options: {
            type: "array",
            description:
              "選択肢のリスト（省略時は自由テキスト入力）。2〜4個推奨",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "選択肢の名前（1〜5語で簡潔に）",
                },
                description: {
                  type: "string",
                  description:
                    "この選択肢の意味・影響・トレードオフの説明",
                },
              },
              required: ["label", "description"],
            },
          },
          multiSelect: {
            type: "boolean",
            description:
              "trueで複数選択可能。排他的でない選択肢に使う。デフォルトfalse",
          },
        },
        required: ["question"],
      },
    },
  },
  async execute(params: Record<string, unknown>): Promise<ToolResult> {
    const question = params.question as string;
    const rawOptions = params.options as AskUserOption[] | string[] | undefined;
    const multiSelect = (params.multiSelect as boolean) ?? false;

    // 後方互換: string[] が来た場合は {label, description} に変換
    const options: AskUserOption[] | undefined = rawOptions
      ? rawOptions.map((o) =>
          typeof o === "string" ? { label: o, description: "" } : o,
        )
      : undefined;

    const OTHER_LABEL = "その他（自由入力）";

    try {
      if (!isTTY) {
        return await executeNonTTY(question, options, multiSelect, OTHER_LABEL);
      }
      return await executeTTY(question, options, multiSelect, OTHER_LABEL);
    } catch (e) {
      return { success: false, output: "", error: String(e) };
    }
  },
};

// --- 表示ヘルパー ---

function formatOptionDisplay(opt: AskUserOption, index: number): string {
  if (opt.description) {
    return `  ${index + 1}: ${opt.label} — ${opt.description}`;
  }
  return `  ${index + 1}: ${opt.label}`;
}

function formatInquirerChoice(opt: AskUserOption): { name: string; value: string } {
  const name = opt.description
    ? `${opt.label} — ${opt.description}`
    : opt.label;
  return { name, value: opt.label };
}

// --- 非TTYモード ---

async function executeNonTTY(
  question: string,
  options: AskUserOption[] | undefined,
  multiSelect: boolean,
  otherLabel: string,
): Promise<ToolResult> {
  if (!options || options.length === 0) {
    console.log(`\n${question}`);
    console.log("回答を入力してください:");
    const answer = await nonTTYReader.readLine();
    return { success: true, output: answer };
  }

  console.log(`\n${question}`);
  options.forEach((opt, i) => console.log(formatOptionDisplay(opt, i)));
  console.log(`  ${options.length + 1}: ${otherLabel}`);

  if (multiSelect) {
    console.log("番号をカンマ区切りで入力してください（例: 1,3）:");
    const line = await nonTTYReader.readLine();
    const indices = line
      .split(",")
      .map((s) => parseInt(s.trim(), 10) - 1);
    const selected: string[] = [];
    let hasOther = false;
    for (const idx of indices) {
      if (idx >= 0 && idx < options.length) {
        selected.push(options[idx].label);
      } else if (idx === options.length) {
        hasOther = true;
      }
    }
    if (hasOther) {
      console.log("自由入力の回答を入力してください:");
      const text = await nonTTYReader.readLine();
      selected.push(text);
    }
    if (selected.length === 0) {
      return { success: true, output: options[0].label };
    }
    return { success: true, output: selected.join(", ") };
  }

  console.log("番号を入力してください:");
  const line = await nonTTYReader.readLine();
  const idx = parseInt(line, 10) - 1;
  if (idx >= 0 && idx < options.length) {
    return { success: true, output: options[idx].label };
  }
  if (idx === options.length) {
    console.log("回答を入力してください:");
    const text = await nonTTYReader.readLine();
    return { success: true, output: text };
  }
  return { success: true, output: options[0].label };
}

// --- TTYモード ---

async function executeTTY(
  question: string,
  options: AskUserOption[] | undefined,
  multiSelect: boolean,
  otherLabel: string,
): Promise<ToolResult> {
  if (!options || options.length === 0) {
    const { answer } = await inquirer.prompt<{ answer: string }>([
      { type: "input", name: "answer", message: question },
    ]);
    return { success: true, output: answer };
  }

  const choices = [
    ...options.map(formatInquirerChoice),
    { name: otherLabel, value: otherLabel },
  ];

  if (multiSelect) {
    const { answer } = await inquirer.prompt<{ answer: string[] }>([
      {
        type: "checkbox",
        name: "answer",
        message: question,
        choices,
      },
    ]);
    const selected = [...answer];
    const otherIdx = selected.indexOf(otherLabel);
    if (otherIdx !== -1) {
      selected.splice(otherIdx, 1);
      const { text } = await inquirer.prompt<{ text: string }>([
        { type: "input", name: "text", message: "回答:" },
      ]);
      selected.push(text);
    }
    return { success: true, output: selected.join(", ") };
  }

  const { answer } = await inquirer.prompt<{ answer: string }>([
    {
      type: "list",
      name: "answer",
      message: question,
      choices,
    },
  ]);

  if (answer === otherLabel) {
    const { text } = await inquirer.prompt<{ text: string }>([
      { type: "input", name: "text", message: "回答:" },
    ]);
    return { success: true, output: text };
  }
  return { success: true, output: answer };
}
