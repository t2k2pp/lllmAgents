import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // E2E スモーク (アプリ全体を子プロセス起動) は CPU 負荷が大きく、並列実行すると
    // 他のユニットテストを timeout させる。vitest.e2e.config.ts で直列に回す。
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    testTimeout: 10_000,
    // カバレッジは可視化のみ (閾値ゲートは設けない)。docs/production-readiness.md PR-09。
    // repl.ts / agent-loop.ts など巨大ファイルの素通し箇所を特定する材料にする。
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "./coverage",
    },
  },
});
