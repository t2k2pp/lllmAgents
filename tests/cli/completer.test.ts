import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createCompleter } from "../../src/cli/completer.js";

describe("createCompleter", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "completer-test-"));

    // テスト用ファイル構造
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, "src", "cli"));
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "repl.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "renderer.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "completer.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src", "agent"));
    fs.writeFileSync(path.join(tmpDir, "src", "agent", "agent-loop.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=x"); // 隠しファイル
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("スラッシュコマンド補完", () => {
    const completer = createCompleter({ cwd: tmpDir });

    it("/he → /help", () => {
      const [matches] = completer("/he");
      expect(matches).toContain("/help");
    });

    it("/mo → /model, /mode", () => {
      const [matches] = completer("/mo");
      expect(matches).toContain("/model");
      expect(matches).toContain("/model list");
      expect(matches).toContain("/mode");
    });

    it("/qu → /quit", () => {
      const [matches] = completer("/qu");
      expect(matches).toContain("/quit");
    });

    it("/co → /context, /compact, /continue", () => {
      const [matches] = completer("/co");
      expect(matches).toContain("/context");
      expect(matches).toContain("/compact");
      expect(matches).toContain("/continue");
    });

    it("/ → 全コマンド一覧", () => {
      const [matches] = completer("/");
      expect(matches.length).toBeGreaterThanOrEqual(15);
      expect(matches).toContain("/help");
      expect(matches).toContain("/quit");
    });

    it("/xyz → 候補なし", () => {
      const [matches] = completer("/xyz");
      expect(matches).toHaveLength(0);
    });

    it("スキルトリガーも補完される", () => {
      const withSkills = createCompleter({
        skillTriggers: ["/commit", "/tdd", "/build-fix"],
        cwd: tmpDir,
      });
      const [matches] = withSkills("/com");
      expect(matches).toContain("/commit");
      expect(matches).toContain("/compact");
    });
  });

  describe("@ファイルパス補完", () => {
    const completer = createCompleter({ cwd: tmpDir });

    it("@ → ルートのファイル/フォルダ一覧", () => {
      const [matches] = completer("見て @");
      expect(matches).toContain("@src/");
      expect(matches).toContain("@package.json");
    });

    it("@s → src/", () => {
      const [matches] = completer("@s");
      expect(matches).toContain("@src/");
    });

    it("@src/ → src内のエントリ", () => {
      const [matches] = completer("@src/");
      expect(matches).toContain("@src/cli/");
      expect(matches).toContain("@src/agent/");
    });

    it("@src/cl → src/cli/", () => {
      const [matches] = completer("@src/cl");
      expect(matches).toContain("@src/cli/");
    });

    it("@src/cli/ → cli内のファイル", () => {
      const [matches] = completer("@src/cli/");
      expect(matches).toContain("@src/cli/repl.ts");
      expect(matches).toContain("@src/cli/renderer.ts");
      expect(matches).toContain("@src/cli/completer.ts");
    });

    it("@src/cli/re → repl.ts, renderer.ts", () => {
      const [matches] = completer("@src/cli/re");
      expect(matches).toContain("@src/cli/repl.ts");
      expect(matches).toContain("@src/cli/renderer.ts");
    });

    it("隠しファイルは候補に含めない", () => {
      const [matches] = completer("@");
      expect(matches).not.toContain("@.env");
    });

    it("存在しないディレクトリは候補なし", () => {
      const [matches] = completer("@nonexistent/");
      expect(matches).toHaveLength(0);
    });

    it("文中の@パスも補完対象", () => {
      const [matches] = completer("このファイル @src/cli/re");
      expect(matches).toContain("@src/cli/repl.ts");
      expect(matches).toContain("@src/cli/renderer.ts");
    });
  });

  describe("補完なし", () => {
    const completer = createCompleter({ cwd: tmpDir });

    it("普通のテキストは補完なし", () => {
      const [matches] = completer("hello world");
      expect(matches).toHaveLength(0);
    });

    it("空文字は補完なし", () => {
      const [matches] = completer("");
      expect(matches).toHaveLength(0);
    });
  });
});
