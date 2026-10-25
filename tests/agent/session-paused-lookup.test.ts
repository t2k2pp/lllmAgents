import { afterAll, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// SESSION_DIR は import 時に os.homedir() から決まるので、 import より前に一時ホームへ差し替える
const tmpHome = vi.hoisted(() => {
  const nodeFs = require("node:fs") as typeof import("node:fs");
  const nodePath = require("node:path") as typeof import("node:path");
  const nodeOs = require("node:os") as typeof import("node:os");
  return nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), "localllm-paused-lookup-"));
});
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => tmpHome, default: { ...actual, homedir: () => tmpHome } };
});

const { findPausedSessionForCwd, saveSession } = await import("../../src/agent/session-manager.js");
const { createDurableRunCheckpoint } = await import("../../src/agent/durable-run-checkpoint.js");
const { makeLiveBinding } = await import("../../src/agent/model-drift.js");
type SessionData = import("../../src/agent/session-manager.js").SessionData;

function session(id: string, checkpoint?: { cwd: string; savedAt: string; state?: "durable_paused" | "resuming" }) {
  const data: SessionData = {
    meta: { id, createdAt: "2026-10-25T00:00:00.000Z", updatedAt: "", model: "m", messageCount: 1, title: id },
    messages: [{ role: "user", content: "続けて" }],
  };
  if (checkpoint) {
    const cp = createDurableRunCheckpoint({
      sessionId: id,
      liveBinding: makeLiveBinding({ providerType: "openai-compat", model: "m", baseUrl: "http://127.0.0.1:8080/v1" }),
      run: {
        userMessageText: "続けて",
        nextIteration: 3,
        emptyResponseRetries: 0,
        codeBlockRetried: false,
        hasExecutedTools: true,
        lastToolSignature: "",
        repeatToolCount: 0,
        pendingVerification: [],
        pendingEvalFiles: [],
        selfCheckRounds: 0,
        progressGateRetries: 0,
        coherenceGateRetries: 0,
      },
    });
    cp.cwdRealpath = checkpoint.cwd;
    cp.savedAt = checkpoint.savedAt;
    if (checkpoint.state) cp.state = checkpoint.state;
    data.runCheckpoint = cp;
  }
  saveSession(data);
}

describe("findPausedSessionForCwd (起動時の「再開しますか?」 の対象探し)", () => {
  afterAll(() => fs.rmSync(tmpHome, { recursive: true, force: true }));

  it("同じフォルダで一時停止したセッションのうち、 最も新しく保存したものを返す", () => {
    session("plain");
    session("other-folder", { cwd: "C:\\work\\other", savedAt: "2026-10-25T03:00:00.000Z" });
    session("old-pause", { cwd: "C:\\work\\myppt", savedAt: "2026-10-25T01:00:00.000Z" });
    session("new-pause", { cwd: "C:\\work\\myppt", savedAt: "2026-10-25T02:00:00.000Z" });
    session("resuming", { cwd: "C:\\work\\myppt", savedAt: "2026-10-25T04:00:00.000Z", state: "resuming" });

    expect(findPausedSessionForCwd("C:\\work\\myppt")?.meta.id).toBe("new-pause");
    expect(fs.existsSync(path.join(tmpHome, ".localllm", "sessions", "new-pause.json"))).toBe(true);
  });

  it("一時停止したセッションが無いフォルダでは null", () => {
    expect(findPausedSessionForCwd(path.join(os.tmpdir(), "no-such-folder"))).toBeNull();
  });
});
