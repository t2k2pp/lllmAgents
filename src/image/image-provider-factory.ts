import type { ImageGenProfile } from "../config/types.js";
import type { ImageProvider } from "./image-provider.js";
import { AzureImageProvider } from "./azure-image.js";
import { SdWebuiProvider } from "./sd-webui.js";
import { ComfyUIProvider } from "./comfyui.js";
import { CredentialVault } from "../security/credential-vault.js";

/**
 * ImageGenProfile → ImageProvider のファクトリ。
 * azure-image は apiKey の解決 (env: / encrypted: / 平文) も担う。
 * 設計: docs/image-generation.md §4
 */
export function createImageProvider(profile: ImageGenProfile, passphrase?: string): ImageProvider {
  switch (profile.providerType) {
    case "azure-image": {
      if (!profile.endpoint || !profile.apiKey || !profile.model) {
        throw new Error(`画像プロファイル "${profile.name}": endpoint / apiKey / model が必要です`);
      }
      const token = CredentialVault.resolve(profile.apiKey, passphrase);
      if (!token) {
        throw new Error(`画像プロファイル "${profile.name}": API Key の解決に失敗しました (env:/encrypted:/平文)`);
      }
      return new AzureImageProvider({
        endpoint: profile.endpoint,
        apiKey: token,
        model: profile.model,
        defaultSize: profile.defaultSize,
        defaultQuality: profile.defaultQuality,
      });
    }
    case "sd-webui": {
      if (!profile.baseUrl) {
        throw new Error(`画像プロファイル "${profile.name}": baseUrl が必要です`);
      }
      return new SdWebuiProvider({
        baseUrl: profile.baseUrl,
        defaultSize: profile.defaultSize,
        negativePrompt: profile.negativePrompt,
        steps: profile.steps,
      });
    }
    case "comfyui": {
      if (!profile.baseUrl) {
        throw new Error(`画像プロファイル "${profile.name}": baseUrl が必要です`);
      }
      return new ComfyUIProvider({
        baseUrl: profile.baseUrl,
        workflowTemplate: profile.workflowTemplate,
        checkpoint: profile.checkpoint,
        defaultSize: profile.defaultSize,
        negativePrompt: profile.negativePrompt,
        steps: profile.steps,
      });
    }
    default:
      throw new Error(`Unknown image provider type: ${(profile as ImageGenProfile).providerType}`);
  }
}
