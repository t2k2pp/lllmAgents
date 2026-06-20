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

    it("/mo → /model", () => {
      const [matches] = completer("/mo");
      expect(matches).toContain("/model");
      expect(matches).toContain("/model list");
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

  it("mo → /model, /model list", () => {
    const provider = createCommandMenuProvider();
    const items = provider("mo");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/model");
    expect(labels).toContain("/model list");
  });

  it("/model 系の主要サブコマンドが補完候補に出る (list/context/setup)", () => {
    // Phase 4 (2026-05-27): /model info は重複だったので削除済み
    const provider = createCommandMenuProvider();
    const items = provider("model ");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/model list");
    expect(labels).toContain("/model context");
    expect(labels).toContain("/model setup");
    // /model info は廃止
    expect(labels).not.toContain("/model info");
  });

  it("/model second 系の主要サブコマンドが補完候補に出る (Phase 4 統合後)", () => {
    // Phase 4: /second ... は /model second ... に統合
    const provider = createCommandMenuProvider();
    const items = provider("model second");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/model second");
    expect(labels).toContain("/model second enable");
    expect(labels).toContain("/model second disable");
    expect(labels).toContain("/model second setup");
    expect(labels).toContain("/model second list");
    expect(labels).toContain("/model second context");
    expect(labels).toContain("/model second description");
  });

  it("/model vision 系の主要サブコマンドが補完候補に出る (Phase 5)", () => {
    const provider = createCommandMenuProvider();
    const items = provider("model vision");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/model vision");
    expect(labels).toContain("/model vision setup");
    expect(labels).toContain("/model vision list");
    expect(labels).toContain("/model vision context");
    expect(labels).toContain("/model vision description");
    expect(labels).toContain("/model vision clear");
  });

  it("/context tools <名前> でツール名を動的補完する", () => {
    const provider = createCommandMenuProvider([], ["bash", "file_read", "file_write", "mcp__blender__ping"]);
    // "context tools ba" → bash のみ
    const ba = provider("context tools ba").map((i) => i.value);
    expect(ba).toEqual(["/context tools bash"]);
    // "context tools file" → file_read / file_write
    const file = provider("context tools file").map((i) => i.value).sort();
    expect(file).toEqual(["/context tools file_read", "/context tools file_write"]);
    // 空プレフィックスで MCP ツール含む全件
    const all = provider("context tools ").map((i) => i.value);
    expect(all).toContain("/context tools mcp__blender__ping");
  });

  it("createCompleter (readline) も /context tools のツール名を補完する", () => {
    const completer = createCompleter({ toolNames: ["bash", "file_read"] });
    const [matches] = completer("/context tools ba");
    expect(matches).toEqual(["/context tools bash"]);
  });

  it("/second は alias として補完に残るが [非推奨] 表記", () => {
    const provider = createCommandMenuProvider();
    const items = provider("second");
    const second = items.find((i) => i.label === "/second");
    expect(second).toBeDefined();
    expect(second!.description).toContain("非推奨");
    // 個別サブ (enable/disable/...) は /second 側からは消えている
    const labels = items.map((i) => i.label);
    expect(labels).not.toContain("/second enable");
    expect(labels).not.toContain("/second setup");
    expect(labels).not.toContain("/second list");
    expect(labels).not.toContain("/second context");
  });

  it("Phase 3: 個別編集系コマンドは補完候補から除外 (dispatcher 互換は維持)", () => {
    // docs/model-registry.md §4.1 — /models Edit に統合済み
    const provider = createCommandMenuProvider();
    const allLabels = provider("").map((i) => i.label);
    // 旧 /model 個別編集
    expect(allLabels).not.toContain("/model temperature");
    expect(allLabels).not.toContain("/model top_p");
    expect(allLabels).not.toContain("/model top_k");
    expect(allLabels).not.toContain("/model rep_penalty");
    expect(allLabels).not.toContain("/model url");
    expect(allLabels).not.toContain("/model provider");
    expect(allLabels).not.toContain("/model host");
    expect(allLabels).not.toContain("/model port");
    expect(allLabels).not.toContain("/model description");
    // 旧 /second 個別編集
    expect(allLabels).not.toContain("/second model");
    expect(allLabels).not.toContain("/second url");
    expect(allLabels).not.toContain("/second provider");
    expect(allLabels).not.toContain("/second description");
    expect(allLabels).not.toContain("/second temperature");
    expect(allLabels).not.toContain("/second top_p");
    // プロバイダ別 setup variants
    expect(allLabels).not.toContain("/model setup azure-openai");
    expect(allLabels).not.toContain("/model setup gemini");
    expect(allLabels).not.toContain("/second setup gemini");
  });

  it("/models コマンドが補完候補に出る", () => {
    const provider = createCommandMenuProvider();
    const items = provider("models");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/models");
    expect(labels).toContain("/models list");
    expect(labels).toContain("/models help");
  });

  it("/integrations が補完候補に出る (Phase optimize #3 統合後)", () => {
    // Phase optimize #3 (2026-05-28): /discord / /slack / /chatlog / /search は
    // /integrations の picker 配下に統合され、 補完候補からは [非推奨] alias 1 件のみ残る。
    const provider = createCommandMenuProvider();
    const items = provider("integrations");
    const labels = items.map((i) => i.label);
    expect(labels).toContain("/integrations");
    // 短縮形
    expect(provider("intg").map((i) => i.label)).toContain("/intg");
  });

  it("旧 /discord /slack /chatlog /search は補完から完全除外 (dispatcher 互換は維持)", () => {
    // cleanup 2026-06-20 (docs/integrations-command-cleanup.md): /integrations へ統廃合済みのため
    // 旧 4 系統の [非推奨] alias も補完候補から削除。dispatcher の case は内部実装として残置。
    const provider = createCommandMenuProvider();
    const allLabels = provider("").map((i) => i.label);
    // トップレベル alias も含めて補完には出ない
    expect(allLabels).not.toContain("/discord");
    expect(allLabels).not.toContain("/slack");
    expect(allLabels).not.toContain("/chatlog");
    expect(allLabels).not.toContain("/search");
    // 個別サブも従来どおり除外済み
    expect(allLabels).not.toContain("/discord url");
    expect(allLabels).not.toContain("/discord listen start");
    expect(allLabels).not.toContain("/slack url");
    expect(allLabels).not.toContain("/slack bot-token");
    expect(allLabels).not.toContain("/chatlog vault");
    expect(allLabels).not.toContain("/search searxng");
    expect(allLabels).not.toContain("/search duckduckgo");
    // 代替の /integrations は残る
    expect(allLabels).toContain("/integrations");
  });

  it("/loop の主要サブコマンドは引き続き補完候補に出る (B-2 統合後)", () => {
    // B-2 (2026-05-28): /loop list と /loop stop は /loop status の picker に集約。
    // 補完候補は /loop と /loop status の 2 件のみ。 /loop list / /loop stop は
    // dispatcher 互換維持 (補完からは外れる)。
    const provider = createCommandMenuProvider();
    const loopItems = provider("loop").map((i) => i.label);
    expect(loopItems).toContain("/loop");
    expect(loopItems).toContain("/loop status");
    expect(loopItems).not.toContain("/loop list");
    expect(loopItems).not.toContain("/loop stop");
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

  describe("部分一致候補 (Claude Code 風)", () => {
    let fuzzyDir: string;

    beforeAll(() => {
      fuzzyDir = fs.mkdtempSync(path.join(os.tmpdir(), "fuzzy-test-"));
      fs.mkdirSync(path.join(fuzzyDir, "src", "cli"), { recursive: true });
      fs.mkdirSync(path.join(fuzzyDir, "src", "agent"), { recursive: true });
      fs.mkdirSync(path.join(fuzzyDir, "tests", "cli"), { recursive: true });
      fs.mkdirSync(path.join(fuzzyDir, "docs"), { recursive: true });
      fs.writeFileSync(path.join(fuzzyDir, "src", "cli", "completer.ts"), "");
      fs.writeFileSync(path.join(fuzzyDir, "src", "cli", "repl.ts"), "");
      fs.writeFileSync(path.join(fuzzyDir, "src", "agent", "agent-loop.ts"), "");
      fs.writeFileSync(path.join(fuzzyDir, "tests", "cli", "completer.test.ts"), "");
      fs.writeFileSync(path.join(fuzzyDir, "docs", "workspace-separation.md"), "");
      fs.writeFileSync(path.join(fuzzyDir, "README.md"), "");
    });

    afterAll(() => {
      fs.rmSync(fuzzyDir, { recursive: true, force: true });
    });

    it("basename 部分一致でプロジェクト全域から候補を返す", () => {
      const provider = createFileMenuProvider(fuzzyDir);
      const items = provider("completer");
      const labels = items.map((i) => i.label);
      expect(labels).toContain("src/cli/completer.ts");
      expect(labels).toContain("tests/cli/completer.test.ts");
    });

    it("ディレクトリ名の部分一致も拾う", () => {
      const provider = createFileMenuProvider(fuzzyDir);
      const items = provider("cli");
      const labels = items.map((i) => i.label);
      expect(labels).toContain("src/cli/");
      expect(labels).toContain("tests/cli/");
    });

    it("パスの一部 (docs/work) でも候補が出る", () => {
      const provider = createFileMenuProvider(fuzzyDir);
      const items = provider("docs/work");
      const labels = items.map((i) => i.label);
      expect(labels).toContain("docs/workspace-separation.md");
    });

    it("basename 前方一致は他より上位にランクされる", () => {
      const provider = createFileMenuProvider(fuzzyDir);
      const items = provider("comp");
      // src/cli/completer.ts は basename が "comp" で始まるので先頭付近
      const idx = items.findIndex((i) => i.label === "src/cli/completer.ts");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(2);
    });

    it("末尾スラッシュはディレクトリ列挙 (部分一致ではなく直下)", () => {
      const provider = createFileMenuProvider(fuzzyDir);
      const items = provider("src/");
      const labels = items.map((i) => i.label);
      expect(labels).toContain("src/cli/");
      expect(labels).toContain("src/agent/");
      // tests/cli/ は src/ 直下ではないので含まれない
      expect(labels).not.toContain("tests/cli/");
    });
  });
});
