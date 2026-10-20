import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileEditTool } from "../../src/tools/definitions/file-edit.js";
import { fileReadTool } from "../../src/tools/definitions/file-read.js";
import { fileWriteTool } from "../../src/tools/definitions/file-write.js";
import { applyLineEnding, detectLineEnding, toLF } from "../../src/tools/line-endings.js";

const roots: string[] = [];

function tempFile(name: string, content: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-endings-"));
  roots.push(root);
  const file = path.join(root, name);
  fs.writeFileSync(file, content, "utf-8");
  return file;
}

afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe("line-endings ユーティリティ", () => {
  it("多い方の改行コードを選び、 混在を検出する", () => {
    expect(detectLineEnding("a\r\nb\r\nc")).toEqual({ eol: "\r\n", mixed: false });
    expect(detectLineEnding("a\nb\nc")).toEqual({ eol: "\n", mixed: false });
    expect(detectLineEnding("a\r\nb\r\nc\nd")).toEqual({ eol: "\r\n", mixed: true });
    expect(detectLineEnding("一行だけ")).toEqual({ eol: "\n", mixed: false });
  });

  it("LF 化と CRLF への戻しは往復で元に戻る", () => {
    const crlf = "x\r\ny\r\n";
    expect(applyLineEnding(toLF(crlf), "\r\n")).toBe(crlf);
  });
});

describe("file_edit — CRLF のファイル", () => {
  it("LF で書いた複数行の old_string が一致し、 CRLF を保って書き戻す", async () => {
    // 2026-10-18 myppt: git checkout (autocrlf=true) で CRLF 化した main.js への file_edit が連続失敗した
    const file = tempFile("main.js", "function a() {\r\n  return 1;\r\n}\r\n");
    const result = await fileEditTool.execute({
      file_path: file,
      old_string: "function a() {\n  return 1;\n}",
      new_string: "function a() {\n  return 2;\n}",
    });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("function a() {\r\n  return 2;\r\n}\r\n");
    expect(result.output).toContain("CRLF");
    // スニペットに \r を出さない (モデルに見せる表示は LF)
    expect(result.output).not.toContain("\r");
  });

  it("混在ファイルは多い方に統一し、 そのことを結果に書く", async () => {
    const file = tempFile("mixed.js", "a\r\nb\r\nc\nd\r\n");
    const result = await fileEditTool.execute({ file_path: file, old_string: "c\nd", new_string: "C\nD" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("a\r\nb\r\nC\r\nD\r\n");
    expect(result.output).toContain("混在");
  });

  it("LF のファイルは従来どおり LF のまま", async () => {
    const file = tempFile("lf.js", "a\nb\n");
    const result = await fileEditTool.execute({ file_path: file, old_string: "a\nb", new_string: "A\nB" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("A\nB\n");
    expect(result.output).not.toContain("CRLF");
  });

  it("見つからないときの添付内容にも \\r を含めない", async () => {
    const file = tempFile("nf.js", "a\r\nb\r\n");
    const result = await fileEditTool.execute({ file_path: file, old_string: "zzz", new_string: "y" });
    expect(result.success).toBe(false);
    expect(result.output).not.toContain("\r");
  });
});

describe("file_write — 既存ファイルの改行コードを保つ", () => {
  it("CRLF のファイルを LF の内容で上書きすると CRLF で書く", async () => {
    const file = tempFile("doc.md", "old\r\nline\r\n");
    const result = await fileWriteTool.execute({ file_path: file, content: "new\nline\n" });
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, "utf-8")).toBe("new\r\nline\r\n");
    expect(result.output).toContain("CRLF");
  });

  it("新規作成は渡された内容のまま書く", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "line-endings-"));
    roots.push(root);
    const file = path.join(root, "new.md");
    await fileWriteTool.execute({ file_path: file, content: "a\nb\n" });
    expect(fs.readFileSync(file, "utf-8")).toBe("a\nb\n");
  });
});

describe("file_read — 表示は LF、 CRLF であることは注記で知らせる", () => {
  it("行末の \\r を表示せず、 改行コードを末尾に示す", async () => {
    const file = tempFile("r.js", "a\r\nb\r\n");
    const result = await fileReadTool.execute({ file_path: file });
    expect(result.success).toBe(true);
    expect(result.output).not.toContain("\r");
    expect(result.output).toContain("改行コード: CRLF");
  });

  it("LF のファイルでは注記を出さない", async () => {
    const file = tempFile("r2.js", "a\nb\n");
    const result = await fileReadTool.execute({ file_path: file });
    expect(result.output).not.toContain("改行コード");
  });
});
