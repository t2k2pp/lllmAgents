// pre-commit フックの本体 (.githooks/pre-commit から呼ばれる)。設計書: docs/git-hooks.md
// CI の Type check & lint と同じ検査をコミット前に通す。
// - tsc --noEmit: 型はプロジェクト全体で決まるため全体を検査する
// - biome check --staged: コミットに入るファイルだけを検査する (format 差分・lint エラー)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSC = join(ROOT, "node_modules", "typescript", "bin", "tsc");
const BIOME = join(ROOT, "node_modules", "@biomejs", "biome", "bin", "biome");

for (const bin of [TSC, BIOME]) {
  if (!existsSync(bin)) {
    console.error(`[pre-commit] ${bin} がありません。npm ci を実行してからコミットしてください。`);
    process.exit(1);
  }
}

function run(label, args) {
  console.error(`[pre-commit] ${label}`);
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`[pre-commit] ${label} が失敗しました。修正してから再度コミットしてください。`);
    console.error("[pre-commit] format 差分は npx biome check --staged --write で直せます。");
    process.exit(result.status ?? 1);
  }
}

run("tsc --noEmit", [TSC, "--noEmit"]);
run("biome check --staged", [BIOME, "check", "--staged", "--no-errors-on-unmatched"]);
