import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as logger from "./logger.js";

/**
 * 添付画像のサイズ調整ユーティリティ。
 *
 * Discord webhook には 1 ファイルあたりのアップロード上限があり (サーバの boost
 * レベルで変動)、生成画像が大きいと添付が弾かれる。これを防ぐため、上限を超える
 * 画像をコードで自動縮小してから添付する。
 *
 * 方針 (docs/image-generation.md):
 * - オリジナルは決して書き換えない。縮小版は OS の一時ディレクトリに書き出す。
 * - 縮小は「リサイズ優先 → 必要時のみ JPEG 変換」。リサイズは透過と PNG 形式を
 *   保てるためまず試し、それでも目標を超える場合のみ JPEG (品質を段階的に低下) へ。
 * - 判定・段階選択はすべて実バイト数を見てコードで行う (生成 AI は使わない)。
 */

/** リサイズ時に試す最長辺の上限 (px)。大きい順に試し、目標以下になった時点で確定 */
const RESIZE_STEPS = [2048, 1536, 1280, 1024, 768];
/** JPEG 変換段階で試す品質。高い順に試す */
const JPEG_QUALITY_STEPS = [85, 70, 55, 40];
/** 実バイト数の目標に対する安全マージン (上限ギリギリを避ける) */
const SAFETY_RATIO = 0.9;

/**
 * jimp の遅延ロード。
 * SEA (exe) ビルドでは jimp が esbuild の external に指定されバンドルに含まれない。
 * playwright と同じく createRequire で node_modules から読む。
 * jimp が見つからなければ null を返し、呼び出し側が添付準備を失敗させる。
 */
let _jimpModule: typeof import("jimp") | null | undefined;
async function loadJimp(): Promise<typeof import("jimp") | null> {
  if (_jimpModule !== undefined) return _jimpModule;

  // 1) ESM import を試す (通常の tsx/node 実行)
  try {
    const mod = await import("jimp");
    _jimpModule = mod;
    return mod;
  } catch {
    // fallthrough
  }

  // 2) createRequire で探す (SEA / CJS バンドル)
  const roots = [path.join(os.homedir(), ".localllm"), process.cwd()];
  for (const root of roots) {
    try {
      const req = createRequire(path.join(root, "node_modules", "x"));
      const mod = req("jimp") as typeof import("jimp");
      _jimpModule = mod;
      return mod;
    } catch {
      // fallthrough
    }
  }

  logger.warn("jimp が見つかりません。上限超過画像は添付できません。npm install jimp で導入できます。");
  _jimpModule = null;
  return null;
}

export interface PreparedAttachment {
  /** 添付に使うファイルの絶対パス (オリジナル or 一時縮小版) */
  path: string;
  /** path が一時ファイル (送信後に破棄すべき) なら true */
  isTemp: boolean;
  /** 縮小した場合の説明 (元→新サイズ等)。無加工なら undefined */
  note?: string;
}

/** "1.2 MB" のような人間可読表記 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${bytes}B`;
}

/** 一時ファイルパスを生成する (拡張子付き) */
function makeTempPath(originalPath: string, ext: string): string {
  const base = path.basename(originalPath, path.extname(originalPath));
  const uniq = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return path.join(os.tmpdir(), `localllm-attach-${base}-${uniq}${ext}`);
}

/**
 * 添付用にファイルを準備する。
 * 元サイズが maxBytes 以下ならオリジナルをそのまま使う (無加工)。
 * 超過時は一時ディレクトリに縮小版を生成して返す。
 * 縮小に失敗、または目標に収まらない場合は理由を示して失敗させる。
 */
export async function prepareForDiscord(filePath: string, maxBytes: number): Promise<PreparedAttachment> {
  let originalSize: number;
  try {
    originalSize = fs.statSync(filePath).size;
  } catch (error) {
    throw new Error(
      `添付ファイルを読み取れません: ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }

  if (originalSize <= maxBytes) {
    return { path: filePath, isTemp: false };
  }

  // 上限超過時に縮小できなければ、送信可能に見せず停止する。
  const jimpMod = await loadJimp();
  if (!jimpMod) {
    throw new Error(`上限超過画像を縮小できません: jimp が見つかりません (${filePath})`);
  }
  const { Jimp } = jimpMod;

  const target = Math.floor(maxBytes * SAFETY_RATIO);

  try {
    const image = await Jimp.read(filePath);
    const longestSide = Math.max(image.width, image.height);

    // 1) リサイズ優先 (PNG のまま、透過を維持)。最長辺を段階的に縮小して目標以下を探す。
    for (const maxSide of RESIZE_STEPS) {
      if (maxSide >= longestSide) continue; // 元より大きいステップは無意味
      const resized = image.clone();
      if (resized.width >= resized.height) resized.resize({ w: maxSide });
      else resized.resize({ h: maxSide });
      const buf = await resized.getBuffer("image/png");
      if (buf.length <= target) {
        const out = makeTempPath(filePath, ".png");
        fs.writeFileSync(out, buf);
        return {
          path: out,
          isTemp: true,
          note: `${formatBytes(originalSize)}→${formatBytes(buf.length)}に縮小 (${maxSide}px PNG)`,
        };
      }
    }

    // 2) PNG で収まらなければ JPEG へ。最小寸法まで縮小しつつ品質を段階的に下げる。
    const minSide = RESIZE_STEPS[RESIZE_STEPS.length - 1];
    const jpegBase = image.clone();
    if (jpegBase.width >= jpegBase.height) {
      if (jpegBase.width > minSide) jpegBase.resize({ w: minSide });
    } else if (jpegBase.height > minSide) {
      jpegBase.resize({ h: minSide });
    }
    for (const quality of JPEG_QUALITY_STEPS) {
      const buf = await jpegBase.getBuffer("image/jpeg", { quality });
      if (buf.length <= target) {
        const out = makeTempPath(filePath, ".jpg");
        fs.writeFileSync(out, buf);
        return {
          path: out,
          isTemp: true,
          note: `${formatBytes(originalSize)}→${formatBytes(buf.length)}に縮小 (${minSide}px JPEG q${quality})`,
        };
      }
    }

    throw new Error(
      `画像を添付上限内に縮小できません: ${formatBytes(originalSize)} > ${formatBytes(maxBytes)} (${filePath})`,
    );
  } catch (e) {
    const message = `画像の縮小に失敗しました: ${filePath}: ${e instanceof Error ? e.message : String(e)}`;
    logger.warn(message);
    throw new Error(message, { cause: e });
  }
}
