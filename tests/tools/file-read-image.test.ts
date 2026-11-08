import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROOT_ANCESTORS } from "../../src/agent/delegation-context.js";
import { createSharedWorkspace, resolveWorkspacePath } from "../../src/agent/workspace-context.js";
import { readImageSize } from "../../src/tools/image-attachment.js";
import { fileReadTool } from "../../src/tools/definitions/file-read.js";
import type { ToolExecutionContext } from "../../src/tools/tool-registry.js";

/** 先頭 (印 + IHDR) だけの PNG。 大きさの読み取りと添付の検査には十分 */
function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const ON: ToolExecutionContext = {
  ancestors: ROOT_ANCESTORS,
  imageInput: { mode: "on", source: "provider", detail: "m: 対応" },
};
const OFF: ToolExecutionContext = {
  ancestors: ROOT_ANCESTORS,
  imageInput: { mode: "off", source: "config", detail: 'm: config の mainLLM.vision = "off"' },
};

describe("file_read の画像 (docs/in-context-vision-design.md §8)", () => {
  let dir: string;
  let png: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-read-image-"));
    png = path.join(dir, "render.png");
    fs.writeFileSync(png, pngHeader(1200, 900));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("見られるときは短い説明と画像の添付を返す (本文に base64 を入れない)", async () => {
    const result = await fileReadTool.execute({ file_path: png }, ON);
    expect(result.success).toBe(true);
    // 作業場所の解決はパスを正規化する (Windows は小文字・macOS は /private の実パス) ので、 同じ解決をした値と比べる
    const resolved = resolveWorkspacePath(createSharedWorkspace(), png);
    expect(result.output).toContain(resolved);
    expect(result.output).toContain("1200×900 px");
    expect(result.output).toContain("33 バイト");
    expect(result.images).toHaveLength(1);
    expect(result.images?.[0].mimeType).toBe("image/png");
    expect(result.images?.[0].label).toBe(resolved);
    expect(Buffer.from(result.images?.[0].data ?? "", "base64")).toEqual(fs.readFileSync(png));
    expect(result.output).not.toContain(result.images?.[0].data);
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
      { ancestors: ROOT_ANCESTORS, imageInput: { mode: "unknown", source: "provider", detail: "m: 接続失敗" } },
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

  it("文字のファイルは今までどおり行番号付きで読む", async () => {
    const txt = path.join(dir, "a.txt");
    fs.writeFileSync(txt, "hello\nworld");
    const result = await fileReadTool.execute({ file_path: txt }, ON);
    expect(result.images).toBeUndefined();
    expect(result.output).toContain("    1\thello");
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
