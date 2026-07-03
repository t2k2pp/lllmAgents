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
  },
});
