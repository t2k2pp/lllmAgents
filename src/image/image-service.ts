import * as fs from "node:fs";
import * as path from "node:path";
import type { Config, ImageGenProfile } from "../config/types.js";
import type { ImageGenRequest, ImageGenResult } from "./image-provider.js";
import { createImageProvider } from "./image-provider-factory.js";
import { globalTokenTracker } from "../cost/token-tracker.js";
import { getOpsLogger } from "../utils/ops-logger.js";

/**
 * 画像生成サービス: アクティブ profile の解決・生成実行・保存・コスト記録。
 * 設計: docs/image-generation.md §4.5
 *
 * config オブジェクトへの参照を保持し、REPL での profile 切替 (/image use) や
 * ON/OFF は config 書き換え + saveConfig で即反映される。
 */

export interface GenerateAndSaveResult {
  /** 保存したファイルの絶対パス */
  savedPaths: string[];
  model: string;
  providerType: string;
  costUsd: number;
  warnings: string[];
}

export class ImageService {
  constructor(
    private config: Config,
    private passphrase?: string,
  ) {}

  isEnabled(): boolean {
    return this.config.imageGen?.enabled === true && this.getActiveProfile() !== null;
  }

  getActiveProfile(): ImageGenProfile | null {
    const ig = this.config.imageGen;
    if (!ig || ig.profiles.length === 0) return null;
    if (ig.active) {
      const found = ig.profiles.find((p) => p.name === ig.active);
      if (found) return found;
    }
    return null;
  }

  /**
   * 画像を生成して outputPath (絶対パス、PNG) に保存する。
   * 複数枚時は name.png, name-2.png, ... と連番。
   * 成功時に globalTokenTracker へ slot="image" でコスト記録する。
   */
  async generateAndSave(req: ImageGenRequest, outputPath: string): Promise<GenerateAndSaveResult> {
    const profile = this.getActiveProfile();
    if (!profile) {
      throw new Error("画像生成プロファイルが未設定です。/image setup で設定してください。");
    }
    if (!path.isAbsolute(outputPath)) {
      throw new Error(`output_path は絶対パスで指定してください: ${outputPath}`);
    }

    const provider = createImageProvider(profile, this.passphrase);
    const result = await provider.generate(req);

    const savedPaths = this.saveImages(result, outputPath);

    globalTokenTracker.record({
      timestamp: new Date().toISOString(),
      provider: profile.providerType,
      model: result.model,
      slot: "image",
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      estimatedCostUsd: result.costUsd,
      imageCount: result.images.length,
    });
    getOpsLogger().info("image", "generated", {
      profile: profile.name,
      model: result.model,
      count: result.images.length,
      costUsd: result.costUsd,
      savedPaths,
    });

    return {
      savedPaths,
      model: result.model,
      providerType: profile.providerType,
      costUsd: result.costUsd,
      warnings: result.warnings ?? [],
    };
  }

  private saveImages(result: ImageGenResult, outputPath: string): string[] {
    const dir = path.dirname(outputPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const ext = path.extname(outputPath) || ".png";
    const stem = outputPath.slice(0, outputPath.length - path.extname(outputPath).length);
    const savedPaths: string[] = [];
    result.images.forEach((buf, i) => {
      const p = i === 0 ? `${stem}${ext}` : `${stem}-${i + 1}${ext}`;
      fs.writeFileSync(p, buf);
      savedPaths.push(p);
    });
    return savedPaths;
  }
}
