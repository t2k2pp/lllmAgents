import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // E2E スモーク (アプリ全体を子プロセス起動) は CPU 負荷が大きく、並列実行すると
    // 他のユニットテストを timeout させる。vitest.e2e.config.ts で直列に回す。
    exclude: [...configDefaults.exclude, "tests/e2e/**"],
    // 利用者の実ログ・実設定 (~/.localllm) を汚さない/読まないよう、 ホームを一時フォルダへ向ける
    setupFiles: ["tests/setup/isolate-home.ts"],
    testTimeout: 10_000,
    // 2026-10-17 実測 (statements / branches / functions / lines = 44.45 / 38.24 / 55.16 / 44.68) を
    // 下回る大幅な回帰をCIで止める。新規コード追加時の小数点揺れを許容しつつ、閾値は改善に合わせてratchetする。
    // vitest 4 で V8 カバレッジの対応付けが AST ベースに変わり、v3 時代の値 (2026-08-25 実測
    // 35.12 / 76.20 / 58.14 / 35.12 → 閾値 34 / 75 / 57 / 34) とは測り方が違うため、v4 の実測で置き直した。
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text-summary", "html"],
      reportsDirectory: "./coverage",
      thresholds: {
        statements: 43,
        branches: 37,
        functions: 54,
        lines: 43,
      },
    },
  },
});
