import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { resolveAtMentions } from "../../src/cli/input-resolver.js";

describe("resolveAtMentions", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "input-resolver-test-"));

    // テスト用ファイル/フォルダを作成
    fs.writeFileSync(path.join(tmpDir, "hello.ts"), 'console.log("hello");');
    fs.writeFileSync(path.join(tmpDir, "config.json"), '{"key": "value"}');
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "main.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(tmpDir, "src", "util.ts"), "export const y = 2;");
    fs.mkdirSync(path.join(tmpDir, "src", "sub"));
    fs.writeFileSync(path.join(tmpDir, "src", "sub", "deep.ts"), "deep");
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("@メンション無しの入力はそのまま返す", () => {
    const { resolved, mentions } = resolveAtMentions("普通のテキスト", tmpDir);
    expect(resolved).toBe("普通のテキスト");
    expect(mentions).toHaveLength(0);
  });

  it("ファイル参照を検出して内容を展開する", () => {
    const { resolved, mentions } = resolveAtMentions("見て @hello.ts", tmpDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("file");
    expect(mentions[0].original).toBe("@hello.ts");
    expect(resolved).toContain('console.log("hello")');
    expect(resolved).toContain("--- File: @hello.ts ---");
    expect(resolved).toContain("--- end ---");
  });

  it("ディレクトリ参照を検出してファイル一覧を展開する", () => {
    const { resolved, mentions } = resolveAtMentions("@src/ の構成は？", tmpDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("directory");
    expect(resolved).toContain("--- Directory: @src/ ---");
    expect(resolved).toContain("main.ts");
    expect(resolved).toContain("util.ts");
    expect(resolved).toContain("sub/");
  });

  it("存在しないパスはnot_foundで展開されない", () => {
    const { resolved, mentions } = resolveAtMentions("@nonexistent.ts を見て", tmpDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("not_found");
    // not_foundの場合はattachmentが追加されない
    expect(resolved).not.toContain("--- File:");
  });

  it("複数の@メンションを同時に解決する", () => {
    const { resolved, mentions } = resolveAtMentions(
      "@hello.ts と @config.json を比較して",
      tmpDir,
    );
    expect(mentions).toHaveLength(2);
    expect(mentions[0].type).toBe("file");
    expect(mentions[1].type).toBe("file");
    expect(resolved).toContain("--- File: @hello.ts ---");
    expect(resolved).toContain("--- File: @config.json ---");
  });

  it("サブディレクトリのファイルを参照できる", () => {
    const { resolved, mentions } = resolveAtMentions("@src/main.ts を読んで", tmpDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("file");
    expect(resolved).toContain("export const x = 1;");
  });

  it("深いネストのパスを参照できる", () => {
    const { resolved, mentions } = resolveAtMentions("@src/sub/deep.ts", tmpDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("file");
    expect(resolved).toContain("deep");
  });

  it("同じパスが複数回出ても1回だけ展開する", () => {
    const { resolved, mentions } = resolveAtMentions(
      "@hello.ts の1行目と @hello.ts の2行目",
      tmpDir,
    );
    expect(mentions).toHaveLength(1);
    // attachmentは1つだけ
    const fileHeaders = resolved.match(/--- File: @hello\.ts ---/g);
    expect(fileHeaders).toHaveLength(1);
  });

  it("相対パス（./）を解決できる", () => {
    const { resolved, mentions } = resolveAtMentions("@./hello.ts を見て", tmpDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("file");
  });

  it("相対パス（../）を解決できる", () => {
    const subCwd = path.join(tmpDir, "src");
    const { mentions } = resolveAtMentions("@../hello.ts を見て", subCwd);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("file");
  });

  it("メールアドレスは@メンションとして検出しない", () => {
    const { mentions } = resolveAtMentions("user@example.com に連絡して", tmpDir);
    // example.com はファイルとして存在しない → not_found になるが、
    // そもそもパスとしてマッチしないことが理想
    // 現在の正規表現ではマッチしない（@の前にスペースが必要 or 行頭）
    // "user@example.com" の場合、@の前がuserなのでスペース境界にならない
    expect(mentions).toHaveLength(0);
  });

  it("ファイルが大きい場合はtruncateする", () => {
    // 200KB のファイルを作成
    const bigFile = path.join(tmpDir, "big.txt");
    fs.writeFileSync(bigFile, "x".repeat(200_000));

    const { resolved, mentions } = resolveAtMentions("@big.txt を見て", tmpDir);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].type).toBe("file");
    expect(resolved).toContain("先頭");
    expect(resolved).toContain("のみ表示");
  });

  it("元のテキストは維持される", () => {
    const { resolved } = resolveAtMentions("このファイル @hello.ts を修正して", tmpDir);
    expect(resolved).toContain("このファイル @hello.ts を修正して");
  });

  it("隠しファイルはディレクトリ一覧に含めない", () => {
    fs.writeFileSync(path.join(tmpDir, "src", ".hidden"), "secret");
    const { resolved } = resolveAtMentions("@src/ を見せて", tmpDir);
    expect(resolved).not.toContain(".hidden");
  });
});
