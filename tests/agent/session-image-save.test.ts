import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// SESSION_DIR は import 時に os.homedir() から決まるので、 import より前に一時ホームへ差し替える
const tmpHome = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodePath = require("node:path") as typeof import("node:path");
  const nodeOs = require("node:os") as typeof import("node:os");
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "localllm-session-image-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});

const { saveSession, loadSession } = await import("../../src/agent/session-manager.js");
const { buildToolImageNote, countLiveImages, isToolImageNote } = await import("../../src/agent/image-content.js");
type SessionData = import("../../src/agent/session-manager.js").SessionData;

describe("セッションの保存に画像の base64 を残さない (docs/in-context-vision-design.md §7)", () => {
  afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it("画像は置き換え文にして書き、 メモリ上の履歴は書き換えない", () => {
    const data = "QUJD".repeat(10_000);
    const carrier = {
      role: "user" as const,
      content: buildToolImageNote([
        { toolName: "file_read", image: { mimeType: "image/png", data, label: "C:/r/wolf.png" } },
      ]),
      ephemeral: true,
    };
    const session: SessionData = {
      meta: {
        id: "img-save",
        createdAt: "2026-11-09T00:00:00.000Z",
        updatedAt: "",
        model: "m",
        messageCount: 0,
        title: "t",
      },
      messages: [{ role: "user", content: "狼を作って" }, carrier],
    };
    saveSession(session);

    const file = path.join(tmpHome, ".localllm", "sessions", "img-save.json");
    const raw = fs.readFileSync(file, "utf-8");
    expect(raw).not.toContain(data.slice(0, 200));
    expect(raw).toContain("C:/r/wolf.png");
    const loaded = loadSession("img-save");
    expect(loaded && countLiveImages(loaded.messages)).toBe(0);
    expect(loaded && isToolImageNote(loaded.messages[1])).toBe(true);
    // メモリ上は画像のまま
    expect(countLiveImages(session.messages)).toBe(1);
  });
});
