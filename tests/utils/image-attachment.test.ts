import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Jimp } from "jimp";
import { prepareForDiscord } from "../../src/utils/image-attachment.js";

/**
 * prepareForDiscord の縮小ロジック検証。
 * ネットワークを使わず、生成した PNG を実バイト数で評価する。
 */

const created: string[] = [];

function tmpFile(name: string): string {
  const p = path.join(os.tmpdir(), `localllm-test-${Date.now()}-${Math.random().toString(36).slice(2)}-${name}`);
  created.push(p);
  return p;
}

/** 指定サイズ・ノイズ入りの PNG を作って保存し、絶対パスを返す */
async function writeNoisyPng(side: number): Promise<string> {
  const img = new Jimp({ width: side, height: side });
  // ランダムノイズで PNG が圧縮されにくくしてサイズを稼ぐ
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const r = (Math.random() * 255) & 0xff;
      const g = (Math.random() * 255) & 0xff;
      const b = (Math.random() * 255) & 0xff;
      img.setPixelColor(((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0, x, y);
    }
  }
  const p = tmpFile("src.png");
  const buf = await img.getBuffer("image/png");
  fs.writeFileSync(p, buf);
  return p;
}

afterEach(() => {
  for (const p of created.splice(0)) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
});

describe("prepareForDiscord", () => {
  it("上限以下のファイルはオリジナルをそのまま返す (無加工)", async () => {
    const src = await writeNoisyPng(64);
    const before = fs.readFileSync(src);
    const r = await prepareForDiscord(src, 10 * 1024 * 1024);
    expect(r.isTemp).toBe(false);
    expect(r.path).toBe(src);
    expect(r.note).toBeUndefined();
    // オリジナルが書き換えられていないこと
    expect(fs.readFileSync(src).equals(before)).toBe(true);
  });

  it("上限超過なら一時ファイルに縮小し、オリジナルは無加工で残す", async () => {
    // 512pxでもmaxBytesを元サイズの半分にするため縮小経路は確実に通る。
    // 1024pxノイズ画像はcoverageと並列負荷時に10秒を超え、正しさと無関係なflakeになっていた。
    const src = await writeNoisyPng(512);
    const originalSize = fs.statSync(src).size;
    const originalBytes = fs.readFileSync(src);
    // 元サイズより小さい上限を指定して縮小を強制
    const maxBytes = Math.floor(originalSize / 2);

    const r = await prepareForDiscord(src, maxBytes);
    expect(r.isTemp).toBe(true);
    expect(r.path).not.toBe(src);
    expect(r.note).toBeTruthy();
    created.push(r.path); // クリーンアップ対象に追加

    // 縮小版は目標 (上限) 以下
    const resized = fs.statSync(r.path).size;
    expect(resized).toBeLessThanOrEqual(maxBytes);
    // オリジナルは無加工
    expect(fs.statSync(src).size).toBe(originalSize);
    expect(fs.readFileSync(src).equals(originalBytes)).toBe(true);
  });

  it("存在しないファイルを送信側の別挙動へ委ねず失敗させる", async () => {
    const missing = tmpFile("nope.png");
    await expect(prepareForDiscord(missing, 1024)).rejects.toThrow("添付ファイルを読み取れません");
  });

  it("縮小しても上限に入らない画像を上限超過のまま返さない", async () => {
    const src = await writeNoisyPng(64);
    await expect(prepareForDiscord(src, 1)).rejects.toThrow("添付上限内に縮小できません");
  });
});
