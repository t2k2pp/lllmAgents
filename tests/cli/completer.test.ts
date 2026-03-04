import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createCompleter,
  createCommandMenuProvider,
  createFileMenuProvider,
} from "../../src/cli/completer.js";

describe("createCompleter (readline fallback)", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "completer-test-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, "src", "cli"));
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "repl.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "renderer.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "completer.ts"), "");
    fs.mkdirSync(path.join(tmpDir, "src", "agent"));
    fs.writeFileSync(path.join(tmpDir, "src", "agent", "agent-loop.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, ".env"), "SECRET=x");
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

    it("@src/cli/ → cli内のファイル", () => {
      const [matches] = completer("@src/cli/");
      expect(matches).toContain("@src/cli/repl.ts");
      expect(matches).toContain("@src/cli/renderer.ts");
    });

    it("隠しファイルは候補に含めない", () => {
      const [matches] = completer("@");
      expect(matches).not.toContain("@.env");
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

describe("createCommandMenuProvider", () => {
  it("空のpartialで全コマンドを返す", () => {
    const provider = createCommandMenuProvider();
    const items = provider("");
    expect(items.length).toBeGreaterThanOrEqual(15);
    // 各アイテムにlabel, value, descriptionがある
    for (const item of items) {
      expect(item.label).toBeTruthy();
      expect(item.value).toBeTruthy();
      expect(item.description).toBeTruthy();
    }
  });

  it("partialでフィルタリングされる", () => {
    const provider = createCommandMenuProvider();
    const items = provider("he");
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe("/help");
    expect(items[0].description).toBe("ヘルプ表示");
  });

  it("mo → /model, /model list, /mode", () => {
    const provider = createCommandMenuProvider();
    const items = provider("mo");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/model");
    expect(labels).toContain("/model list");
    expect(labels).toContain("/mode");
  });

  it("スキルトリガーも候補に含む", () => {
    const provider = createCommandMenuProvider([
      { trigger: "/commit", description: "コミットワークフロー" },
      { trigger: "/tdd", description: "テスト駆動開発" },
    ]);
    const items = provider("com");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/commit");
    expect(labels).toContain("/compact");
  });

  it("マッチなしなら空配列", () => {
    const provider = createCommandMenuProvider();
    const items = provider("zzz");
    expect(items).toHaveLength(0);
  });
});

describe("createFileMenuProvider", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "menu-provider-test-"));
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.mkdirSync(path.join(tmpDir, "src", "cli"));
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "repl.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "src", "cli", "renderer.ts"), "");
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("空のpartialでルートのエントリを返す", () => {
    const provider = createFileMenuProvider(tmpDir);
    const items = provider("");
    expect(items.length).toBeGreaterThan(0);
    const labels = items.map((i) => i.label);
    expect(labels).toContain("src/");
    expect(labels).toContain("package.json");
  });

  it("ディレクトリは📂、ファイルは📄", () => {
    const provider = createFileMenuProvider(tmpDir);
    const items = provider("");
    const srcItem = items.find((i) => i.label === "src/");
    const pkgItem = items.find((i) => i.label === "package.json");
    expect(srcItem?.description).toBe("📂");
    expect(pkgItem?.description).toBe("📄");
  });

  it("src/cli/ でファイル一覧", () => {
    const provider = createFileMenuProvider(tmpDir);
    const items = provider("src/cli/");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("src/cli/repl.ts");
    expect(labels).toContain("src/cli/renderer.ts");
  });

  it("src/cli/re でフィルタ", () => {
    const provider = createFileMenuProvider(tmpDir);
    const items = provider("src/cli/re");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("src/cli/repl.ts");
    expect(labels).toContain("src/cli/renderer.ts");
  });

  it("存在しないパスは空配列", () => {
    const provider = createFileMenuProvider(tmpDir);
    const items = provider("nonexistent/");
    expect(items).toHaveLength(0);
  });
});
