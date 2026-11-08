import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Jimp } from "jimp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT_ANCESTORS } from "../../src/agent/delegation-context.js";
import { createSharedWorkspace, resolveWorkspacePath } from "../../src/agent/workspace-context.js";
import { prepareImageForModel, readImageSize } from "../../src/tools/image-attachment.js";
import { fileReadTool } from "../../src/tools/definitions/file-read.js";
import type { ImageInputState, ToolExecutionContext } from "../../src/tools/tool-registry.js";

/** 先頭 (印 + IHDR) だけの PNG。 大きさの読み取りには十分 (中身は解けない) */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

/** 描画に似た (なだらか + 細かい揺らぎ) 不透明の PNG。 PNG のままだと大きい */
async function renderLikePng(width: number, height: number, alpha = 255): Promise<Buffer> {
  const image = new Jimp({ width, height, color: 0x000000ff });
  const data = image.bitmap.data;
  let seed = 7;
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const x = i % width;
    const y = Math.floor(i / width);
    const n = seed % 24;
    data[i * 4] = (x * 255) / width + n;
    data[i * 4 + 1] = (y * 255) / height + n;
    data[i * 4 + 2] = 128 + n;
    data[i * 4 + 3] = alpha;
  }
  return image.getBuffer("image/png");
}

const LIMITS = { maxLongSide: 1280, budgetBytes: 4 * 1024 * 1024 };
const ON_STATE: ImageInputState = { mode: "on", source: "provider", detail: "m: 対応", ...LIMITS };
const ON: ToolExecutionContext = { ancestors: ROOT_ANCESTORS, imageInput: ON_STATE };
const OFF: ToolExecutionContext = {
  ancestors: ROOT_ANCESTORS,
  imageInput: { ...ON_STATE, mode: "off", source: "config", detail: 'm: config の mainLLM.vision = "off"' },
};

describe("file_read の画像 (docs/in-context-vision-design.md §8)", () => {
  let dir: string;
  let png: string;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-read-image-"));
    png = path.join(dir, "render.png");
    fs.writeFileSync(png, await renderLikePng(1200, 900));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("見られるときは短い説明と (小さく書き直した) 画像の添付を返す (本文に base64 を入れない)", async () => {
    const original = fs.readFileSync(png);
    const result = await fileReadTool.execute({ file_path: png }, ON);
    expect(result.success).toBe(true);
    // 作業場所の解決はパスを正規化する (Windows は小文字・macOS は /private の実パス) ので、 同じ解決をした値と比べる
    const resolved = resolveWorkspacePath(createSharedWorkspace(), png);
    expect(result.output).toContain(resolved);
    expect(result.output).toContain("1200×900 px");
    expect(result.images).toHaveLength(1);
    const image = result.images?.[0];
    expect(image?.label.startsWith(resolved)).toBe(true);
    // 元の大きさと送る大きさを書く
    expect(image?.label).toMatch(/元 1200×900 PNG [\d.]+(KB|MB) → 送る 1200×900 JPEG [\d.]+KB/);
    expect(result.output).toContain("送る 1200×900 JPEG");
    const sent = Buffer.from(image?.data ?? "", "base64");
    expect(sent.length).toBeLessThan(original.length);
    expect(image?.mimeType).toBe("image/jpeg");
    expect(result.output).not.toContain(image?.data);
  });

  it("見られない設定なら画像を付けず、 そのことと vision_analyze を明示する", async () => {
    const result = await fileReadTool.execute({ file_path: png }, OFF);
    expect(result.success).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("メインのモデルは画像を見られない設定です");
    expect(result.output).toContain("vision_analyze");
  });

  it("判定できなかったときは、 その理由と設定の直し方を示す", async () => {
    const result = await fileReadTool.execute(
      { file_path: png },
      { ancestors: ROOT_ANCESTORS, imageInput: { ...ON_STATE, mode: "unknown", detail: "m: 接続失敗" } },
    );
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("判定できませんでした (m: 接続失敗)");
    expect(result.output).toContain("mainLLM.vision");
  });

  it("状態の無い経路 (サブエージェント等) は画像を載せないと名指しする", async () => {
    const result = await fileReadTool.execute({ file_path: png }, { ancestors: ROOT_ANCESTORS });
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("サブエージェント等");
  });

  it("1 枚で載せられる量を超える画像は載せず、 その理由を名指しする", async () => {
    const result = await fileReadTool.execute(
      { file_path: png },
      { ancestors: ROOT_ANCESTORS, imageInput: { ...ON_STATE, budgetBytes: 1000 } },
    );
    expect(result.success).toBe(true);
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("載せていません");
    expect(result.output).toContain("mainLLM.visionImageBudgetBytes");
  });

  it("文字のファイルは今までどおり行番号付きで読む", async () => {
    const txt = path.join(dir, "a.txt");
    fs.writeFileSync(txt, "hello\nworld");
    const result = await fileReadTool.execute({ file_path: txt }, ON);
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("    1\thello");
  });
});

describe("prepareImageForModel (§3.1 縮小と付け直し)", () => {
  it("長辺を上限まで縮め、 元より小さくする", async () => {
    const big = await renderLikePng(2400, 1800);
    const prepared = await prepareImageForModel(big, "image/png", "big.png", LIMITS);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const sent = Buffer.from(prepared.attachment.data, "base64");
    const decoded = await Jimp.read(sent);
    expect(Math.max(decoded.width, decoded.height)).toBe(1280);
    expect(decoded.height).toBe(960);
    expect(sent.length).toBeLessThan(big.length);
    expect(prepared.note).toContain("元 2400×1800 PNG");
    expect(prepared.note).toContain("送る 1280×960");
  });

  it("透過のある画像は PNG のまま (JPEG にしない)", async () => {
    const withAlpha = await renderLikePng(300, 200, 128);
    const prepared = await prepareImageForModel(withAlpha, "image/png", "a.png", LIMITS);
    expect(prepared.ok && prepared.attachment.mimeType).toBe("image/png");
  });

  it("解けない画像は元のまま載せ、 そのことを書く", async () => {
    const prepared = await prepareImageForModel(pngHeader(10, 10), "image/png", "h.png", LIMITS);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.note).toContain("縮小・付け直しはできませんでした");
  });
});

describe("readImageSize", () => {
  it("PNG・JPEG の大きさを先頭から読む", () => {
    expect(readImageSize(pngHeader(64, 32))).toEqual({ width: 64, height: 32 });
    // SOI + APP0 (長さ 4) + SOF0 (高さ 20, 幅 40)
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x14, 0x00, 0x28, 0x03,
    ]);
    expect(readImageSize(jpeg)).toEqual({ width: 40, height: 20 });
    expect(readImageSize(Buffer.from("not an image"))).toBeNull();
  });
});
