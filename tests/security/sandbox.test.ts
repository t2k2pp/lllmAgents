import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

// platform.ts のモック用
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
  };
});

describe("Sandbox Security", () => {
  describe("safeResolvePath", () => {
    let safeResolvePath: typeof import("../../src/utils/platform.js").safeResolvePath;

    beforeEach(async () => {
      vi.resetModules();
      const platform = await import("../../src/utils/platform.js");
      safeResolvePath = platform.safeResolvePath;
    });

    it("should resolve relative paths", () => {
      const result = safeResolvePath("./test/file.txt");
      expect(path.isAbsolute(result)).toBe(true);
    });

    it("should resolve directory traversal (../)", () => {
      const result = safeResolvePath("/home/user/project/../../../etc/passwd");
      expect(result).not.toContain("..");
    });

    it("should call fs.realpathSync to resolve symlinks", () => {
      const mockRealpath = vi.mocked(fs.realpathSync);
      mockRealpath.mockReturnValueOnce("/real/path/file.txt" as unknown as Buffer);
      const result = safeResolvePath("/sym/link/file.txt");
      expect(mockRealpath).toHaveBeenCalled();
      expect(result).toContain("real");
    });

    it("should handle non-existent files by resolving parent", () => {
      const mockRealpath = vi.mocked(fs.realpathSync);
      // First call fails (file doesn't exist)
      mockRealpath.mockImplementationOnce(() => {
        throw new Error("ENOENT");
      });
      // Second call succeeds (parent exists)
      mockRealpath.mockReturnValueOnce("/real/parent" as unknown as Buffer);

      const result = safeResolvePath("/sym/parent/newfile.txt");
      expect(result).toContain("newfile.txt");
    });

    it("should handle non-existent parent gracefully", () => {
      const mockRealpath = vi.mocked(fs.realpathSync);
      // Both calls fail
      mockRealpath.mockImplementation(() => {
        throw new Error("ENOENT");
      });

      // Should not throw
      expect(() => safeResolvePath("/nonexistent/path/file.txt")).not.toThrow();
    });
  });

  describe("pathStartsWith", () => {
    let pathStartsWith: typeof import("../../src/utils/platform.js").pathStartsWith;
    let isWindows: boolean;

    beforeEach(async () => {
      vi.resetModules();
      const platform = await import("../../src/utils/platform.js");
      pathStartsWith = platform.pathStartsWith;
      isWindows = platform.isWindows;
    });

    it("should match exact directory", () => {
      const dir = path.resolve("/home/user/project");
      expect(pathStartsWith(dir, dir)).toBe(true);
    });

    it("should match subdirectory", () => {
      const dir = path.resolve("/home/user/project");
      const sub = path.join(dir, "src", "file.ts");
      expect(pathStartsWith(sub, dir)).toBe(true);
    });

    it("should NOT match sibling directory with similar prefix", () => {
      // /home/user/project-evil should NOT match /home/user/project
      const dir = path.resolve("/home/user/project");
      const evil = dir + "-evil" + path.sep + "file.ts";
      expect(pathStartsWith(evil, dir)).toBe(false);
    });

    it("should NOT match parent directory", () => {
      const dir = path.resolve("/home/user/project");
      const parent = path.resolve("/home/user");
      expect(pathStartsWith(parent, dir)).toBe(false);
    });
  });

  describe("normalizeWindowsPath", () => {
    let normalizeWindowsPath: typeof import("../../src/utils/platform.js").normalizeWindowsPath;

    beforeEach(async () => {
      vi.resetModules();
      const platform = await import("../../src/utils/platform.js");
      normalizeWindowsPath = platform.normalizeWindowsPath;
    });

    it("should lowercase drive letters", () => {
      const result = normalizeWindowsPath("C:\\Users\\test");
      expect(result).toBe("c:\\users\\test");
    });

    it("should handle case-insensitive paths", () => {
      const a = normalizeWindowsPath("C:\\Users\\Test\\FILE.txt");
      const b = normalizeWindowsPath("c:\\users\\test\\file.txt");
      expect(a).toBe(b);
    });

    it("should strip \\\\?\\ extended path prefix", () => {
      const result = normalizeWindowsPath("\\\\?\\C:\\Users\\test");
      expect(result).toBe("c:\\users\\test");
    });

    it("should strip \\\\.\\  device path prefix", () => {
      const result = normalizeWindowsPath("\\\\.\\C:\\Users\\test");
      expect(result).toBe("c:\\users\\test");
    });

    it("should normalize forward slashes to backslashes", () => {
      const result = normalizeWindowsPath("C:/Users/test/file.txt");
      expect(result).toBe("c:\\users\\test\\file.txt");
    });
  });

  describe("Sandbox.isPathAllowed (integration)", () => {
    let Sandbox: typeof import("../../src/security/sandbox.js").Sandbox;

    beforeEach(async () => {
      vi.resetModules();
      // realpathSync をパススルーに戻す
      vi.mocked(fs.realpathSync).mockImplementation((p) => p as string);
      const sandboxModule = await import("../../src/security/sandbox.js");
      Sandbox = sandboxModule.Sandbox;
    });

    it("should allow paths within cwd", () => {
      const sandbox = new Sandbox({
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: [],
        requireApprovalTools: [],
      });
      const testPath = path.join(process.cwd(), "src", "test.ts");
      expect(sandbox.isPathAllowed(testPath)).toBe(true);
    });

    it("should deny paths outside allowed directories", () => {
      const sandbox = new Sandbox({
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: [],
        requireApprovalTools: [],
      });
      // /tmp は通常 cwd や ~/.localllm と異なる
      const outsidePath = path.resolve(os.tmpdir(), "evil", "payload.sh");
      // cwd や ~/.localllm 配下でなければ拒否される
      const cwdPart = process.cwd();
      const localllmPart = path.join(os.homedir(), ".localllm");
      if (!outsidePath.startsWith(cwdPart) && !outsidePath.startsWith(localllmPart)) {
        expect(sandbox.isPathAllowed(outsidePath)).toBe(false);
      }
    });

    it("should block directory traversal escape", () => {
      const sandbox = new Sandbox({
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: [],
        requireApprovalTools: [],
      });
      // 相対パスで cwd を脱出しようとする
      const traversal = path.join(process.cwd(), "..", "..", "..", "etc", "passwd");
      const resolved = path.resolve(traversal);
      // resolved が cwd 配下でなければブロックされるべき
      if (!resolved.startsWith(process.cwd())) {
        expect(sandbox.isPathAllowed(traversal)).toBe(false);
      }
    });

    it("should allow dynamically added directories", () => {
      const sandbox = new Sandbox({
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: [],
        requireApprovalTools: [],
      });
      const newDir = path.resolve(os.tmpdir(), "allowed-sandbox-test");
      sandbox.addAllowedDir(newDir);
      expect(sandbox.isPathAllowed(path.join(newDir, "file.txt"))).toBe(true);
    });

    it("should block symlink escape when realpathSync resolves differently", async () => {
      // symlink /cwd/link → /etc/secrets
      const cwdPath = process.cwd();
      const symlinkPath = path.join(cwdPath, "link", "secret.txt");
      const realTarget = path.resolve("/etc/secrets/secret.txt");

      vi.mocked(fs.realpathSync).mockImplementation((p) => {
        const pStr = String(p);
        if (pStr.includes("link")) {
          return realTarget;
        }
        return pStr;
      });

      // re-import with new mock (ESM dynamic import)
      vi.resetModules();
      const { Sandbox: FreshSandbox } = await import("../../src/security/sandbox.js");
      const sandbox = new FreshSandbox({
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: [],
        requireApprovalTools: [],
      });

      // symlinkPath は cwd 配下に見えるが、実パスは /etc/secrets
      // → サンドボックスはブロックすべき
      expect(sandbox.isPathAllowed(symlinkPath)).toBe(false);
    });

    it("should not allow prefix-matching without path separator", () => {
      const sandbox = new Sandbox({
        allowedDirectories: [],
        blockedCommands: [],
        autoApproveTools: [],
        requireApprovalTools: [],
      });
      // /home/user/project-evil は /home/user/project にマッチしてはいけない
      const evilPath = process.cwd() + "-evil" + path.sep + "steal.sh";
      expect(sandbox.isPathAllowed(evilPath)).toBe(false);
    });
  });
});
