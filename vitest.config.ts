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
    // 2026-08-25 実測 (35.12 / 76.20 / 58.14 / 35.12) を下回る大幅な回帰をCIで止める。
    // 新規コード追加時の小数点揺れを許容しつつ、閾値は改善に合わせてratchetする。
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 34,
        branches: 75,
        functions: 57,
        lines: 34,
      },
    },
  },
});
