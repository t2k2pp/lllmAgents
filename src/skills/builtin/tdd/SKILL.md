---
name: tdd
description: lllmAgents プロジェクト (vitest + TypeScript ESM) でのテスト駆動開発ワークフロー。 ユーザーが「TDD で」「テストを先に書いて」 と要求した時、 または 新機能・バグ修正で「テストで挙動を固定したい」 と判断した時に使用する。 Red-Green-Refactor サイクルに加え、 tests/ 配下の配置規約・vitest 固有の書き方・ESM `.js` 拡張子 import の罠を含む。
---

# TDD (lllmAgents 向け)

## 前提: このプロジェクトのテスト環境

- **テストランナー**: vitest (`npm test` = `vitest run` / `npm run test:watch` = ウォッチ)
- **テスト配置**: `tests/**/*.test.ts` (本体ソース構造をミラー: `src/foo/bar.ts` → `tests/foo/bar.test.ts`)
- **timeout**: 10 秒 (`vitest.config.ts`)
- **環境**: `environment: "node"` (ブラウザ DOM なし)
- **import 形式**: ESM。 ソースを参照する import は **`.js` 拡張子を付ける** (TypeScript ESM の制約)

## Red-Green-Refactor

### Red — 落ちるテストを書く

1. `file_read` で本体側 (`src/...`) の対象モジュールを確認 (もしくは「これから書く」 ものの仕様を ToDo に整理)
2. `tests/<mirrored-path>/<name>.test.ts` を `file_write` で作成
3. **vitest 固有の書き方** で書く (LLM が混ぜがちな jest 構文 `jest.fn()` ではなく `vi.fn()` を使う):

```ts
import { describe, it, expect, vi } from "vitest";
import { TargetClass } from "../../src/path/to/target.js";  // ★ .js 拡張子必須

describe("TargetClass — 短い責務記述", () => {
  it("ケース名は日本語で具体的に", () => {
    const t = new TargetClass();
    expect(t.method("arg")).toBe("expected");
  });
});
```

4. `npm test -- tests/path/<name>.test.ts` で **対象テストだけ実行して赤を確認** (全テスト走らせると遅い)

### Green — 最小実装で通す

1. `file_edit` / `file_write` で本体を実装
2. `npm test -- tests/path/<name>.test.ts` で緑を確認
3. **絶対に過剰実装しない** — テストが要求する以上の機能を足さない

### Refactor — テストを盾に整理

1. 重複排除・命名改善・型の明確化
2. リファクタごとに `npm test -- tests/path/<name>.test.ts` で緑を保つ
3. **最後に `npm test` 全走** で他テストへの巻き込みリグレッションを確認
4. `npm run lint` (= `tsc --noEmit`) で型エラーゼロ

## このプロジェクトでの落とし穴

| 罠 | 回避策 |
|----|--------|
| `import { X } from "../src/foo"` (拡張子なし) | ESM なので `.js` 必須 (TS でも `.js` と書く) |
| `jest.fn()` / `jest.mock()` を書いてしまう | vitest なので `vi.fn()` / `vi.mock()` |
| `chalk` / `ora` 等の色出力モジュールがテストを壊す | `vi.mock("chalk", () => ({ default: { red: (s) => s, ... } }))` で sanitize |
| 10 秒タイムアウト超過 | LLM 呼び出し等の重い処理はモック化。 実 API 呼び出しはテストに入れない |
| `tests/` 直下に `*.test.ts` を置く | サブディレクトリ必須 (`tests/foo/...`)。 `vitest.config.ts` の include 設定は `tests/**` 配下 |

## 既存テストへの追加

新規テストファイルを作る前に、 関連テストが既存にないか必ず確認:

```bash
# 例: tool-executor のテストがあるか
ls tests/tools/tool-executor.test.ts 2>/dev/null && echo "既存あり: 既存ファイルに追加すべき"
```

既存ファイルがあれば `describe` ブロックを追加、 もしくは新しい `describe` を末尾に追加する形にする。 同一モジュールのテストを複数ファイルに分散させない。

## 完了条件

- [ ] 新規/変更のテストが書かれている
- [ ] `npm test -- <対象>` で緑
- [ ] `npm test` 全走で緑 (リグレッションなし)
- [ ] `npm run lint` で型エラーなし
- [ ] 過剰実装していない

## このスキルを使わなくていい場面

- 1 行の typo 修正・コメント修正
- ドキュメントだけの変更
- READMEや CLAUDE.md の文言調整

## 参考

- 既存テストの書き方サンプル: `tests/second-llm/delegation-guard.test.ts`, `tests/tools/tool-executor.test.ts`
- vitest config: `vitest.config.ts`
