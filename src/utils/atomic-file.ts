/**
 * アトミックなファイル書き込みと、秘密情報を含むファイルの保護。
 * 設計: docs/production-readiness.md PR-02 / PR-04
 *
 * writeFileSync で直接上書きすると、書き込み途中のプロセス死 (クラッシュ、taskkill、
 * 電源断) でファイルが半端な JSON になる。一時ファイルに書いてから rename で
 * 差し替えることで「旧版が丸ごと残る」か「新版が丸ごとある」かのどちらかを保証する。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

/**
 * ファイルをアトミックに書き込む。
 * 同ディレクトリの一時ファイルに書いて fsync 後、rename で差し替える。
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, data, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    // rename 失敗時は一時ファイルを残さない (失敗自体は呼び出し元へ伝える)
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}

/**
 * 秘密情報を含むファイルのアクセス権を自分だけに制限する。
 * POSIX: chmod 600 / Windows: icacls で継承を切り自ユーザーのみ付与。
 * writeFileAtomic の rename はファイルを作り直すため ACL が既定に戻る。
 * したがって保存のたびに呼ぶこと (キャッシュしない)。
 * 失敗しても本体処理は止めない (戻り値 false で通知は呼び出し元の判断)。
 */
export function hardenFilePermissions(filePath: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    if (process.platform === "win32") {
      const user = process.env.USERNAME;
      if (!user) return false;
      // 継承 ACL を外し、自ユーザーのフルコントロールのみ付与する
      execFileSync(
        "icacls",
        [filePath, "/inheritance:r", "/grant:r", `${user}:F`],
        { stdio: "ignore" },
      );
    } else {
      fs.chmodSync(filePath, 0o600);
    }
    return true;
  } catch {
    return false;
  }
}
