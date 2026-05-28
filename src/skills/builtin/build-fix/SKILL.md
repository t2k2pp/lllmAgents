---
name: build-fix
description: lllmAgents プロジェクトのビルドエラー (tsc / vitest / build:deploy / build:exe) を診断して修正する。 ユーザーが「ビルドが通らない」「型エラー」「テストが落ちる」「exe ビルドが失敗」 と訴えた時、 または PR 直前のセルフチェックで `npm run lint` が落ちた時に使用する。 ESM `.js` 拡張子・SEA ビルド・deploy 同梱の罠を含む。
---

# Build Fix (lllmAgents 向け)

## まず: どのビルドが落ちているか切り分ける

このプロジェクトには **4 種類の「ビルド」** があり、 失敗時のアプローチが異なる:

| コマンド | 内容 | よく落ちる原因 |
|---------|------|--------------|
| `npm run lint` (= `tsc --noEmit`) | 型チェックのみ | import の `.js` 拡張子忘れ、 型不整合 |
| `npm test` (= `vitest run`) | テスト実行 | モック漏れ、 タイムアウト 10s 超過、 chalk/ora 周り |
| `npm run build` (= `tsc`) | dist/ への出力 | tsconfig の include / paths 問題 |
| `npm run build:deploy` | deploy/ 配下に exe + skills 同梱で組み立て | SEA ビルド固有、 同梱ファイル欠落、 Wacatac 誤検知 |
| `npm run build:exe` | dist/ のみ更新 (deploy は古いまま) | 単独使用は推奨しない。 deploy/ も含めるなら `build:deploy` |

## 切り分け手順

```bash
npm run lint            # 1) まず型を見る
npm test                # 2) テスト
npm run build           # 3) tsc の実 emit (型は通ったのに emit で落ちるケース稀にあり)
npm run build:deploy    # 4) deploy 同梱まで (最も重い)
```

**上から順に走らせ、 落ちた段階で止めて原因を潰す**。 下流のエラーは上流が原因のことが多い。

## 典型的な失敗パターンと対処

### A. `Cannot find module '../foo'` (型チェック時)

→ TypeScript ESM の `.js` 拡張子忘れ。

```ts
// ❌
import { Foo } from "../foo";
// ✅
import { Foo } from "../foo.js";
```

`grep -rn "from \"\\.\\./" src --include="*.ts" | grep -v "\\.js\"" | head` で拡張子なし import を洗える。

### B. `Property 'X' does not exist on type 'Y'`

1. `file_read` で `Y` の型定義 (`src/.../types.ts` か `src/.../base-provider.ts` 等) を確認
2. 型を拡張するのか、 使用箇所を直すのか判断
3. **型を `any` で逃げない** (CLAUDE.md 準拠の品質ライン)

### C. `vitest` テスト失敗

詳細は `../tdd/SKILL.md` を参照。 build-fix の文脈で多いのは:

- chalk/ora が出力に混じってアサーション失敗 → `vi.mock("chalk", ...)` で sanitize
- 10 秒タイムアウト → 重い処理はモック化
- `import` パスが `.js` 拡張子なしで test 側だけ落ちる (本体は通るのに) → tests 側にも `.js` 必須

### D. `npm run build:deploy` で同梱漏れ

`scripts/build-deploy.js` が `scripts/deploy-assets/` から組み立てる。 失敗の典型:

1. **skills 同梱漏れ** — `src/skills/builtin/` の新規スキルが deploy/ に入らない
   → `node scripts/sync-skills.js --verbose` で `~/.localllm/skills/` 同期と、 `scripts/build-deploy.js` の skills コピー処理を両方確認
2. **install スクリプト不整合** — `install.bat` / `install.sh` が `scripts/deploy-assets/` 側と乖離
3. **Wacatac 誤検知** — `docs/internal_design.md` で `project_wacatac_false_positive` 関連の情報を確認。 ビルド時の警告であって失敗ではないケースが多い

### E. `npm run build:exe` だけだと deploy/ が古いままになる

CLAUDE.md にも明記の罠。 **常に `npm run build:deploy` 経由でビルドする** こと。`build-exe.bat` は内部で `build:deploy` を呼ぶ。

## 修正の流れ

1. **エラーメッセージを最後まで読む** — TypeScript のエラーは長いが原因は通常最初か最後
2. **`file_read` で該当箇所を確認** — エラー出力だけで判断しない
3. **1 つずつ直す** — 複数同時に直さない (どの修正が効いたか分からなくなる)
4. **修正後に同じコマンドで再走** — 「コミット前に lint」 ではなく 「修正ごとに lint」
5. **完了したら全段階を再走** — `npm run lint && npm test && npm run build`

## CLAUDE.md 準拠の振る舞い

- **推測ではなく実証で診断** (memory: `feedback_diagnose_before_speculate`) — エラーログ・`git ls-files` 等で確認してから手を動かす
- **実装後は push** (探索フェーズなら user 合意まで保留) — build:deploy で本物の exe を作るのはコミット後でも OK

## 完了条件

- [ ] `npm run lint` 緑
- [ ] `npm test` 緑
- [ ] `npm run build` 緑 (必要な時)
- [ ] `npm run build:deploy` 緑 (exe を作りたい時)
- [ ] 推測ではなくログで原因を特定できている
