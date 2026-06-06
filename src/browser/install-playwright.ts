import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * exe(リーン配布) 向けに、~/.localllm へ playwright + chromium を導入する。
 * `localllm --install-browser` から呼ばれる。best-effort（失敗しても手順を表示）。
 *
 * 注: 本実装は npm/npx 依存の【暫定版】。「ユーザーに npm を要求しない」方針のため、
 *     将来は npm レジストリ tarball を HTTPS 直取得（npm 非依存）へ置換予定
 *     （docs/exe-playwright-externalization.md §A 次フェーズ）。
 *
 * Windows では `.cmd` を shell 経由で起動する（Node は shell:false だと .cmd の spawn を
 * 拒否する: CVE-2024-27980 対応）。
 */
export function installPlaywright(): number {
  const useShell = process.platform === "win32";
  const home = path.join(os.homedir(), ".localllm");
  fs.mkdirSync(home, { recursive: true });

  // npm i playwright を ~/.localllm に対して実行するため、最小 package.json を用意。
  const pkgJson = path.join(home, "package.json");
  if (!fs.existsSync(pkgJson)) {
    fs.writeFileSync(pkgJson, JSON.stringify({ name: "localllm-runtime", private: true }, null, 2));
  }

  console.log(`[install-browser] Playwright を ${home} に導入します...`);
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r1 = spawnSync(npm, ["install", "playwright"], { cwd: home, stdio: "inherit", shell: useShell });
  if (r1.status !== 0) {
    console.error(
      "[install-browser] `npm install playwright` に失敗しました。" +
        "npm が PATH にあるか、ネットワーク接続を確認してください。\n" +
        `手動手順: cd "${home}" && npm install playwright && npx playwright install chromium`,
    );
    return r1.status ?? 1;
  }

  console.log("[install-browser] Chromium をダウンロードします...");
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  const r2 = spawnSync(npx, ["playwright", "install", "chromium"], { cwd: home, stdio: "inherit", shell: useShell });
  if (r2.status !== 0) {
    console.error(
      "[install-browser] `npx playwright install chromium` に失敗しました。\n" +
        `手動手順: cd "${home}" && npx playwright install chromium`,
    );
    return r2.status ?? 1;
  }

  console.log("[install-browser] 完了。ブラウザ機能 (game_smoke / browser_*) が利用可能になりました。");
  return 0;
}
