import path from "node:path";
import { describe, expect, it } from "vitest";
import { bashNeedsExplicitAsk } from "../../src/security/permission-manager.js";

// auto-approve 中でも bash を都度確認に回す判定 (CWD 外参照 / 広域スキャン)。
// 2026-10-14 goemon ログで、 ヒアドキュメント本文の `//` 等を CWD 外と誤判定し 30 回中 12 回確認が出ていた。
// docs/todo-request-elaboration.md 第 2 段 項目 13

const isWin = process.platform === "win32";
const cwd = isWin ? "C:\\work\\games\\goemon" : "/work/games/goemon";
const cwdFwd = cwd.replace(/\\/g, "/");

describe("bashNeedsExplicitAsk — 誤検知しない (goemon ログの実コマンド)", () => {
  it("ヒアドキュメントで node に渡したスクリプト本文の // コメントや <\\/script> は見ない", () => {
    const cmd = `cd "${cwdFwd}" && node - <<'EOF'
const html=require('fs').readFileSync('index.html','utf8');
// script開始行の計算
const m=html.match(/<script>([\\s\\S]*)<\\/script>/);
return((t^t>>>14)>>>0)/4294967296;
EOF`;
    expect(bashNeedsExplicitAsk(cmd, cwd)).toBe(false);
  });

  it("sed の正規表現 /function updCoins/ をパスとみなさない", () => {
    const cmd = `cd "${cwdFwd}" && sed -n "/function updCoins/,/^}/p" index.html`;
    expect(bashNeedsExplicitAsk(cmd, cwd)).toBe(false);
  });

  it("2>/dev/null は確認しない", () => {
    expect(bashNeedsExplicitAsk("ls 2>/dev/null", cwd)).toBe(false);
  });

  it("作業フォルダ配下の絶対パスは確認しない", () => {
    expect(bashNeedsExplicitAsk(`cat "${path.join(cwd, "index.html")}"`, cwd)).toBe(false);
  });
});

describe("bashNeedsExplicitAsk — 従来どおり確認する", () => {
  it("作業フォルダ外の絶対パス", () => {
    const outside = isWin ? "C:\\Windows\\system.ini" : "/etc/passwd";
    expect(bashNeedsExplicitAsk(`cat ${outside}`, cwd)).toBe(true);
  });

  it("ルート直下の既知ディレクトリ (単一階層) も外部扱い", () => {
    expect(bashNeedsExplicitAsk("ls /tmp", cwd)).toBe(true);
  });

  it("親ディレクトリ参照", () => {
    expect(bashNeedsExplicitAsk("cat ../../secret.txt", cwd)).toBe(true);
  });

  it("ヒアドキュメントの外側 (コマンド行) の外部パスは見る", () => {
    const outside = isWin ? "C:/Windows/out.js" : "/etc/out.js";
    expect(bashNeedsExplicitAsk(`cat > ${outside} <<'EOF'\nconsole.log(1)\nEOF`, cwd)).toBe(true);
  });

  it("シェルに渡すヒアドキュメントは本文もコマンドなので見る", () => {
    expect(bashNeedsExplicitAsk("bash <<'EOF'\ncat ../../secret.txt\nEOF", cwd)).toBe(true);
  });

  it("広域スキャン", () => {
    expect(bashNeedsExplicitAsk("find . -name '*.ts'", cwd)).toBe(true);
    expect(bashNeedsExplicitAsk("ls -R", cwd)).toBe(true);
  });

  it.runIf(isWin)("git bash のドライブ形式 /c/... も作業フォルダ外なら確認する", () => {
    expect(bashNeedsExplicitAsk("cat /c/Windows/system.ini", cwd)).toBe(true);
    expect(bashNeedsExplicitAsk("cat /c/work/games/goemon/index.html", cwd)).toBe(false);
  });
});
