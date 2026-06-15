import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LLMLogger } from "../../src/agent/llm-logger.js";

// docs/async-surface-permission-delivery-design.md 5.5 — jsonl レコードに roomId/surface が
// 書き込み時に注入されることを検証する。 os.homedir() を一時ディレクトリへ隔離して実ホームを汚さない。
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
let tmpHome: string;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "llmlog-home-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
});

afterAll(() => {
  if (realHome !== undefined) process.env.HOME = realHome;
  else delete process.env.HOME;
  if (realUserProfile !== undefined) process.env.USERPROFILE = realUserProfile;
  else delete process.env.USERPROFILE;
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function readEntries(logger: LLMLogger): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(logger.getFilePath(), "utf-8").trim();
  return raw ? raw.split("\n").map((l) => JSON.parse(l)) : [];
}

describe("LLMLogger 文脈タグ (roomId/surface)", () => {
  it("setContext した値が request/response/tool_result の全レコードに入る", () => {
    const sid = "ctx-" + Math.random().toString(36).slice(2);
    const logger = new LLMLogger("main", sid);
    logger.setContext(() => ({ roomId: "B", surface: "discord" }));

    logger.nextTurn();
    logger.logRequest([{ role: "user", content: "hi" }], "m", []);
    logger.logResponse({ model: "m", text: "yo" });
    logger.logToolResult({
      toolCallId: "t1", toolName: "file_write", rawArguments: "{}",
      output: "", success: true, durationMs: 1,
    });

    const entries = readEntries(logger);
    expect(entries.map((e) => e.type)).toEqual(["request", "response", "tool_result"]);
    for (const e of entries) {
      expect(e.roomId).toBe("B");
      expect(e.surface).toBe("discord");
    }
  });

  it("Room C / slack も同じ経路で記録される (3面に分岐なし)", () => {
    const sid = "ctxC-" + Math.random().toString(36).slice(2);
    const logger = new LLMLogger("main", sid);
    logger.setContext(() => ({ roomId: "C", surface: "slack" }));
    logger.nextTurn();
    logger.logRequest([], "m");
    logger.logToolResult({
      toolCallId: "t1", toolName: "bash", rawArguments: "{}",
      output: "", success: true, durationMs: 1,
    });
    for (const e of readEntries(logger)) {
      expect(e.roomId).toBe("C");
      expect(e.surface).toBe("slack");
    }
  });

  it("プロバイダは書き込み時に評価される (run 中の Room/surface 変化を追従)", () => {
    const sid = "ctx2-" + Math.random().toString(36).slice(2);
    const logger = new LLMLogger("main", sid);
    let cur = { roomId: "A", surface: "cli" };
    logger.setContext(() => cur);

    logger.nextTurn();
    logger.logRequest([], "m");
    cur = { roomId: "B", surface: "discord" }; // 次の書き込み前に切り替え
    logger.logResponse({ model: "m" });

    const [req, res] = readEntries(logger);
    expect(req.roomId).toBe("A");
    expect(req.surface).toBe("cli");
    expect(res.roomId).toBe("B");
    expect(res.surface).toBe("discord");
  });

  it("setContext 無し / 未タグ Room では roomId・surface を出さない (後方互換)", () => {
    const sid = "ctx3-" + Math.random().toString(36).slice(2);
    const logger = new LLMLogger("main", sid);
    logger.nextTurn();
    logger.logRequest([], "m");
    // setContext しても roomId 未設定なら省かれる
    logger.setContext(() => ({ surface: "cli" }));
    logger.logResponse({ model: "m" });

    const [req, res] = readEntries(logger);
    expect("roomId" in req).toBe(false);
    expect("surface" in req).toBe(false);
    expect("roomId" in res).toBe(false); // undefined は JSON に出ない
    expect(res.surface).toBe("cli");
  });
});
