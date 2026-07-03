import { defineConfig } from "vitest/config";

// E2E スモークテスト専用設定 (docs/production-readiness.md PR-08)。
// アプリ全体を tsx 子プロセスで起動するため重い。ユニットテストとの
// CPU 競合による flake を避けるため、ファイル並列を止めて直列実行する。
// 実行: npm run test:e2e
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/e2e/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 180_000,
  },
});
