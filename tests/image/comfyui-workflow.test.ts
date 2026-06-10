import { describe, it, expect } from "vitest";
import {
  COMFYUI_DEFAULT_WORKFLOW,
  buildWorkflow,
  type WorkflowVars,
} from "../../src/image/comfyui-default-workflow.js";

const baseVars: WorkflowVars = {
  prompt: "a red dragon",
  negative: "lowres",
  width: 1024,
  height: 768,
  seed: 42,
  steps: 25,
  batchSize: 2,
  checkpoint: "sd_xl_base_1.0.safetensors",
};

describe("comfyui-default-workflow", () => {
  it("組み込みテンプレートを置換して有効なワークフローを生成する", () => {
    const wf = buildWorkflow(COMFYUI_DEFAULT_WORKFLOW, baseVars) as Record<
      string,
      { class_type: string; inputs: Record<string, unknown> }
    >;
    expect(wf["6"].inputs.text).toBe("a red dragon");
    expect(wf["7"].inputs.text).toBe("lowres");
    expect(wf["4"].inputs.ckpt_name).toBe("sd_xl_base_1.0.safetensors");
    expect(wf["5"].inputs.width).toBe(1024);
    expect(wf["5"].inputs.height).toBe(768);
    expect(wf["5"].inputs.batch_size).toBe(2);
    expect(wf["3"].inputs.seed).toBe(42);
    expect(wf["3"].inputs.steps).toBe(25);
  });

  it("プロンプト中の引用符・改行・バックスラッシュを JSON エスケープして壊れない", () => {
    const wf = buildWorkflow(COMFYUI_DEFAULT_WORKFLOW, {
      ...baseVars,
      prompt: 'say "hello"\npath C:\\img',
    }) as Record<string, { inputs: Record<string, unknown> }>;
    expect(wf["6"].inputs.text).toBe('say "hello"\npath C:\\img');
  });

  it("置換結果が不正な JSON になるテンプレートはエラーで顕在化する", () => {
    expect(() => buildWorkflow('{ "a": {{PROMPT}} }', baseVars)).toThrow(/不正な JSON/);
  });

  it("ユーザー独自テンプレートでも同じプレースホルダ規約が使える", () => {
    const custom = '{ "1": { "class_type": "X", "inputs": { "text": "{{PROMPT}}", "steps": {{STEPS}} } } }';
    const wf = buildWorkflow(custom, baseVars) as Record<string, { inputs: Record<string, unknown> }>;
    expect(wf["1"].inputs.text).toBe("a red dragon");
    expect(wf["1"].inputs.steps).toBe(25);
  });
});
