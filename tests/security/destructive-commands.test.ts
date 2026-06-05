import { describe, it, expect } from "vitest";
import { isDestructiveCommand } from "../../src/security/destructive-commands.js";
import { checkCommand } from "../../src/security/rules.js";

// Phase 3 レビュー(C-1/H-1/M-1)で見つかった「破壊判定の穴」の回帰防止。

describe("isDestructiveCommand (正典リスト・自動許可から除外すべきもの)", () => {
  it("force push を語順・短縮形に依らず破壊的と判定", () => {
    for (const c of [
      "git push -f origin main",
      "git push origin main --force",
      "git push --force origin main",
      "git push origin main --force-with-lease",
      "git push --force",
    ]) {
      expect(isDestructiveCommand(c), c).toBe(true);
    }
  });
  it("refspec の + (=force) と git -c 挿入も force push として検出 (R-1/R-2)", () => {
    for (const c of [
      "git push origin +main",
      "git push origin +HEAD:refs/heads/main",
      "git -c http.sslVerify=false push --force origin main",
      "git push origin +feature",
    ]) {
      expect(isDestructiveCommand(c), c).toBe(true);
    }
  });
  it("通常の push は破壊的でない", () => {
    expect(isDestructiveCommand("git push origin feature")).toBe(false);
    expect(isDestructiveCommand("git push")).toBe(false);
    expect(isDestructiveCommand("git push origin main")).toBe(false);
  });
  it("git 作業ツリー破棄・履歴改変を判定", () => {
    for (const c of ["git checkout -- src/", "git checkout .", "git reset --hard HEAD~1", "git clean -fdx"]) {
      expect(isDestructiveCommand(c), c).toBe(true);
    }
  });
  it("再帰パーミッション/所有者・削除・上書き低レベル系を判定", () => {
    for (const c of ["chmod -R 000 .", "chown -R root .", "rm file", "rm -rf dir", "shred x", "truncate -s 0 f", "dd if=/dev/zero of=x", "find . -delete"]) {
      expect(isDestructiveCommand(c), c).toBe(true);
    }
  });
  it("非破壊コマンドは false", () => {
    for (const c of ["echo hi", "npm run build", "ls -la", "git status", "cat file", "node script.js"]) {
      expect(isDestructiveCommand(c), c).toBe(false);
    }
  });
  it("頻出リダイレクト /dev/null 等は誤検知しない・実デバイス書込のみ破壊的", () => {
    for (const c of ["cmd 2>/dev/null", "cmd >/dev/null 2>&1", "echo x > /dev/stdout", "cat /dev/urandom"]) {
      expect(isDestructiveCommand(c), c).toBe(false);
    }
    for (const c of ["dd if=/dev/zero of=/dev/sda", "echo x > /dev/nvme0n1", "cat img > /dev/mmcblk0"]) {
      expect(isDestructiveCommand(c), c).toBe(true);
    }
  });
});

describe("checkCommand (rules.ts 修正の回帰)", () => {
  it("フォークボムを block（() エスケープ修正）", () => {
    expect(checkCommand(":(){ :|:& };:")?.action).toBe("block");
    expect(checkCommand(":(){ : | : & };:")?.action).toBe("block");
  });
  it("main/master への force push を語順非依存・-c挿入・refspec+ で block (R-1/R-2)", () => {
    for (const c of [
      "git push -f origin main",
      "git push origin master --force",
      "git push --force origin main",
      "git push origin +main",
      "git push origin +HEAD:refs/heads/master",
      "git -c http.sslVerify=false push --force origin main",
    ]) {
      expect(checkCommand(c)?.action, c).toBe("block");
    }
    // 通常 push は block しない
    expect(checkCommand("git push origin main")).toBeNull();
  });
  it("feature ブランチへの force push は main/master block には当たらない", () => {
    // rules.ts の block 対象は main/master のみ。 feature は null（ただし isDestructiveCommand 側で確認される）
    expect(checkCommand("git push -f origin feature")).toBeNull();
    expect(isDestructiveCommand("git push -f origin feature")).toBe(true);
  });
});
