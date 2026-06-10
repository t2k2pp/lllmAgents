import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { ImageProvider, ImageGenRequest, ImageGenResult } from "./image-provider.js";
import { parseSize } from "./image-provider.js";
import { COMFYUI_DEFAULT_WORKFLOW, buildWorkflow } from "./comfyui-default-workflow.js";
import { getOpsLogger } from "../utils/ops-logger.js";

/**
 * ComfyUI プロバイダ (テンプレートワークフロー方式)。
 * 設計: docs/image-generation.md §4.4
 *
 * 1. POST {baseUrl}/prompt に workflow JSON (API format) を投入 → { prompt_id }
 * 2. GET {baseUrl}/history/{prompt_id} を 1 秒間隔でポーリング (タイムアウト 300 秒)
 * 3. outputs 内の images[] を GET {baseUrl}/view?filename=...&subfolder=...&type=... で取得
 *
 * ローカル想定 (認証なし)。コストは常に 0。
 */

interface ComfyUIConfig {
  /** 例: http://localhost:8188 */
  baseUrl: string;
  /** テンプレート JSON の絶対パス。未指定で組み込み txt2img */
  workflowTemplate?: string | null;
  /** 組み込みテンプレートの CheckpointLoaderSimple に注入 */
  checkpoint?: string;
  defaultSize?: string;
  negativePrompt?: string;
  steps?: number;
}

interface HistoryImageRef {
  filename: string;
  subfolder: string;
  type: string;
}

const POLL_INTERVAL_MS = 1000;
const POLL_TIMEOUT_MS = 300_000;

export class ComfyUIProvider implements ImageProvider {
  readonly providerType = "comfyui" as const;

  constructor(private config: ComfyUIConfig) {}

  private get baseUrl(): string {
    return this.config.baseUrl.trim().replace(/\/$/, "");
  }

  private loadTemplate(): string {
    const tplPath = this.config.workflowTemplate;
    if (!tplPath) return COMFYUI_DEFAULT_WORKFLOW;
    if (!fs.existsSync(tplPath)) {
      throw new Error(`ComfyUI ワークフローテンプレートが見つかりません: ${tplPath}`);
    }
    return fs.readFileSync(tplPath, "utf-8");
  }

  async generate(req: ImageGenRequest): Promise<ImageGenResult> {
    const size = req.size ?? this.config.defaultSize ?? "1024x1024";
    const dim = parseSize(size);
    if (!dim) {
      throw new Error(`Invalid size "${size}" — expected "WxH" (e.g. "1024x1024")`);
    }
    if (!this.config.workflowTemplate && !this.config.checkpoint) {
      throw new Error(
        "ComfyUI 組み込みテンプレートには checkpoint 名が必要です。/image setup comfyui で設定してください。",
      );
    }

    const workflow = buildWorkflow(this.loadTemplate(), {
      prompt: req.prompt,
      negative: req.negativePrompt ?? this.config.negativePrompt ?? "",
      width: dim.width,
      height: dim.height,
      seed: req.seed ?? Math.floor(Math.random() * 2 ** 32),
      steps: this.config.steps ?? 25,
      batchSize: req.n ?? 1,
      checkpoint: this.config.checkpoint ?? "",
    });

    const clientId = crypto.randomUUID();
    getOpsLogger().info("image", "comfyui prompt submit", { baseUrl: this.baseUrl, size });

    let queueRes: Response;
    try {
      queueRes = await fetch(`${this.baseUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: workflow, client_id: clientId }),
      });
    } catch (e) {
      throw new Error(
        `ComfyUI に接続できません (${this.baseUrl}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const queueText = await queueRes.text();
    if (!queueRes.ok) {
      throw new Error(`ComfyUI /prompt failed (HTTP ${queueRes.status}): ${queueText.slice(0, 2000)}`);
    }
    const promptId = (JSON.parse(queueText) as { prompt_id?: string }).prompt_id;
    if (!promptId) {
      throw new Error(`ComfyUI /prompt returned no prompt_id: ${queueText.slice(0, 500)}`);
    }

    const imageRefs = await this.pollHistory(promptId);
    const images: Buffer[] = [];
    for (const ref of imageRefs) {
      const params = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder ?? "",
        type: ref.type ?? "output",
      });
      const viewRes = await fetch(`${this.baseUrl}/view?${params.toString()}`);
      if (!viewRes.ok) {
        throw new Error(`ComfyUI /view failed (HTTP ${viewRes.status}) for ${ref.filename}`);
      }
      images.push(Buffer.from(await viewRes.arrayBuffer()));
    }
    if (images.length === 0) {
      throw new Error("ComfyUI ワークフローは完了しましたが出力画像がありません (SaveImage ノードを確認してください)");
    }

    return { images, model: "comfyui", costUsd: 0 };
  }

  /** /history/{promptId} をポーリングし、完了時の出力画像参照を返す */
  private async pollHistory(promptId: string): Promise<HistoryImageRef[]> {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const res = await fetch(`${this.baseUrl}/history/${promptId}`);
      if (!res.ok) continue;
      const history = (await res.json()) as Record<string, {
        status?: { status_str?: string; completed?: boolean; messages?: unknown[] };
        outputs?: Record<string, { images?: HistoryImageRef[] }>;
      }>;
      const entry = history[promptId];
      if (!entry) continue;
      if (entry.status?.status_str === "error") {
        throw new Error(
          `ComfyUI 実行エラー: ${JSON.stringify(entry.status.messages ?? entry.status).slice(0, 2000)}`,
        );
      }
      if (entry.outputs && Object.keys(entry.outputs).length > 0) {
        const refs = Object.values(entry.outputs).flatMap((o) => o.images ?? []);
        if (refs.length > 0) return refs;
        // outputs はあるが画像なし → 完了済みなら打ち切り
        if (entry.status?.completed) return [];
      }
    }
    throw new Error(`ComfyUI がタイムアウトしました (${POLL_TIMEOUT_MS / 1000}秒)。/history で prompt_id=${promptId} を確認してください。`);
  }
}
