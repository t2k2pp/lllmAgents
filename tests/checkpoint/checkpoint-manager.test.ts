import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CheckpointManager } from "../../src/checkpoint/checkpoint-manager.js";

vi.mock("../../src/utils/logger.js", () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

// git が無い環境ではスキップ (CI には git がある前提)
let gitAvailable = true;
try {
  execFileSync("git", ["--version"]);
} catch {
  gitAvailable = false;
}

// os.homedir() は POSIX で HOME、 Windows で USERPROFILE を見るため両方を一時ディレクトリへ。
// 実ホームを汚さずクロスプラットフォームで隔離する。
const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
let tmpHome: string;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
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

let work: string;
let sid: string;

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "cp-work-"));
  sid = "test-" + Math.random().toString(36).slice(2);
});

const W = (name: string, content: string) => {
  const p = path.join(work, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
  return p;
};
const exists = (name: string) => fs.existsSync(path.join(work, name));
const read = (name: string) => fs.readFileSync(path.join(work, name), "utf8");
const gitDirOf = (id: string) => path.join(tmpHome, ".localllm", "checkpoints", id);
const trackedFiles = (id: string): string[] =>
  execFileSync("git", [`--git-dir=${gitDirOf(id)}`, `--work-tree=${work}`, "ls-files"], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

describe.skipIf(!gitAvailable)("CheckpointManager", () => {
  it("commit → list → restore でファイル内容が戻る", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: true });
    W("a.txt", "v1");
    await cp.commitForFile(path.join(work, "a.txt"), "v1");
    W("a.txt", "v2");
    await cp.commitForFile(path.join(work, "a.txt"), "v2");

    const list = await cp.list();
    expect(list.length).toBe(2);
    expect(list[0].n).toBe(1); // 直近

    const r = await cp.restore(2); // v1 の時点
    expect(r.ok).toBe(true);
    expect(read("a.txt")).toBe("v1");
  });

  it("restore は対象コミット以降に追加されたファイルを削除する (H2)", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: true });
    W("main.html", "v1");
    await cp.commitForFile(path.join(work, "main.html"), "w"); // #2 になる
    W("enemy.js", "enemy");
    W("main.html", "v2");
    await cp.commitForFile(path.join(work, "main.html"), "w"); // #1

    await cp.restore(2);
    expect(read("main.html")).toBe("v1");
    expect(exists("enemy.js")).toBe(false); // 後から足したファイルは消える
  });

  it("restore はリネームされたファイルも取りこぼさず削除する (H-A)", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: true });
    W("old.txt", "A");
    await cp.commitForFile(path.join(work, "old.txt"), "w"); // #2
    fs.rmSync(path.join(work, "old.txt"));
    W("renamed.txt", "A");
    await cp.commitForFile(path.join(work, "renamed.txt"), "w"); // #1

    await cp.restore(2);
    expect(exists("old.txt")).toBe(true);
    expect(exists("renamed.txt")).toBe(false); // rename 先も消える
  });

  it("restore は追加ファイル削除後に空ディレクトリも掃除する (M-B)", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: true });
    W("a.txt", "A");
    await cp.commitForFile(path.join(work, "a.txt"), "w"); // #2
    W("sub/new.js", "x");
    await cp.commitForFile(path.join(work, "sub/new.js"), "w"); // #1

    await cp.restore(2);
    expect(exists("sub/new.js")).toBe(false);
    expect(exists("sub")).toBe(false); // 空になった親dirも消える
  });

  it("スコープ外のファイル変更はコミットしない", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: true });
    // work の外のパス
    await cp.commitForFile("/etc/hosts", "should skip");
    const list = await cp.list();
    expect(list.length).toBe(0);
  });

  it("無効時はコミットしない", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: false });
    W("a.txt", "A");
    await cp.commitForFile(path.join(work, "a.txt"), "w");
    const list = await cp.list();
    expect(list.length).toBe(0);
  });

  it("機密ファイル(.env)と巨大ファイルは版管理対象外", async () => {
    const cp = new CheckpointManager({
      sessionId: sid,
      workTree: work,
      enabled: true,
      maxFileSizeMb: 1,
    });
    W("ok.txt", "hello");
    W(".env", "SECRET=xxx");
    fs.writeFileSync(path.join(work, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 1)); // 2MB > 1MB
    await cp.commitForFile(path.join(work, "ok.txt"), "w");

    const tracked = trackedFiles(sid);
    expect(tracked).toContain("ok.txt");
    expect(tracked).not.toContain(".env");
    expect(tracked).not.toContain("big.bin");
  });

  it("rebind でコミット先の名前空間が切り替わる (H1)", async () => {
    const cp = new CheckpointManager({ sessionId: "fresh-" + sid, workTree: work, enabled: true });
    cp.rebind("stable-" + sid);
    W("r.txt", "x");
    await cp.commitForFile(path.join(work, "r.txt"), "w");

    expect(fs.existsSync(path.join(gitDirOf("stable-" + sid), "HEAD"))).toBe(true);
    expect(fs.existsSync(path.join(gitDirOf("fresh-" + sid), "HEAD"))).toBe(false);
  });

  it("clearCurrent は履歴を消すが作業ファイルは残す", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: true });
    W("a.txt", "A");
    await cp.commitForFile(path.join(work, "a.txt"), "w");
    expect(fs.existsSync(gitDirOf(sid))).toBe(true);

    cp.clearCurrent();
    expect(fs.existsSync(gitDirOf(sid))).toBe(false);
    expect(exists("a.txt")).toBe(true); // 作業ファイルは無傷
  });

  it("コミットメッセージは変更ファイル群を反映する (M1)", async () => {
    const cp = new CheckpointManager({ sessionId: sid, workTree: work, enabled: true });
    W("a.txt", "A");
    W("b.txt", "B");
    await cp.commitForFile(path.join(work, "a.txt"), "file_write: a.txt");
    const list = await cp.list();
    expect(list[0].message).toContain("a.txt");
    expect(list[0].message).toContain("b.txt"); // 同ターンの b.txt も含む
  });

  describe("resolveWorkTree", () => {
    it("workTreeDir 明示指定を絶対パスに解決する", () => {
      const r = CheckpointManager.resolveWorkTree(work, "games/foo");
      expect(r).toBe(path.resolve(work, "games/foo"));
    });
    it("未指定で sandbox/output があればそこを使う", () => {
      fs.mkdirSync(path.join(work, "sandbox", "output"), { recursive: true });
      const r = CheckpointManager.resolveWorkTree(work);
      expect(r).toBe(path.join(work, "sandbox", "output"));
    });
    it("未指定で sandbox/output が無ければ cwd", () => {
      const r = CheckpointManager.resolveWorkTree(work);
      expect(r).toBe(work);
    });
  });
});
