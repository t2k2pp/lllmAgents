/**
 * ComfyUI 組み込み txt2img ワークフローテンプレート (API format)。
 * 設計: docs/image-generation.md §4.4
 *
 * プレースホルダ規約 ({{NAME}}):
 *   {{PROMPT}} {{NEGATIVE}} — 文字列値の中に置く (JSON エスケープして置換される)
 *   {{WIDTH}} {{HEIGHT}} {{SEED}} {{STEPS}} {{BATCH_SIZE}} — 数値位置に裸で置く
 *   {{CHECKPOINT}} — checkpoint ファイル名 (文字列値)
 *
 * ユーザー独自ワークフロー (profile.workflowTemplate の JSON ファイル) も同じ規約。
 * 置換はテンプレート文字列の段階で行い、その後 JSON.parse して /prompt に投入する。
 */
export const COMFYUI_DEFAULT_WORKFLOW = `{
  "3": {
    "class_type": "KSampler",
    "inputs": {
      "cfg": 7,
      "denoise": 1,
      "latent_image": ["5", 0],
      "model": ["4", 0],
      "negative": ["7", 0],
      "positive": ["6", 0],
      "sampler_name": "euler",
      "scheduler": "normal",
      "seed": {{SEED}},
      "steps": {{STEPS}}
    }
  },
  "4": {
    "class_type": "CheckpointLoaderSimple",
    "inputs": { "ckpt_name": "{{CHECKPOINT}}" }
  },
  "5": {
    "class_type": "EmptyLatentImage",
    "inputs": { "batch_size": {{BATCH_SIZE}}, "height": {{HEIGHT}}, "width": {{WIDTH}} }
  },
  "6": {
    "class_type": "CLIPTextEncode",
    "inputs": { "clip": ["4", 1], "text": "{{PROMPT}}" }
  },
  "7": {
    "class_type": "CLIPTextEncode",
    "inputs": { "clip": ["4", 1], "text": "{{NEGATIVE}}" }
  },
  "8": {
    "class_type": "VAEDecode",
    "inputs": { "samples": ["3", 0], "vae": ["4", 2] }
  },
  "9": {
    "class_type": "SaveImage",
    "inputs": { "filename_prefix": "lllmagents", "images": ["8", 0] }
  }
}`;

export interface WorkflowVars {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  seed: number;
  steps: number;
  batchSize: number;
  checkpoint: string;
}

/** 文字列値プレースホルダ用: JSON エスケープ済み文字列 (引用符なし) を返す */
function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/**
 * テンプレート文字列のプレースホルダを置換し、パース済みワークフローを返す。
 * 置換結果が JSON として不正ならエラー (テンプレート不備を顕在化)。
 */
export function buildWorkflow(template: string, vars: WorkflowVars): Record<string, unknown> {
  const substituted = template
    .replaceAll("{{PROMPT}}", jsonEscape(vars.prompt))
    .replaceAll("{{NEGATIVE}}", jsonEscape(vars.negative))
    .replaceAll("{{CHECKPOINT}}", jsonEscape(vars.checkpoint))
    .replaceAll("{{WIDTH}}", String(vars.width))
    .replaceAll("{{HEIGHT}}", String(vars.height))
    .replaceAll("{{SEED}}", String(vars.seed))
    .replaceAll("{{STEPS}}", String(vars.steps))
    .replaceAll("{{BATCH_SIZE}}", String(vars.batchSize));
  try {
    return JSON.parse(substituted) as Record<string, unknown>;
  } catch (e) {
    throw new Error(
      `ComfyUI ワークフローテンプレートの置換結果が不正な JSON です: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
