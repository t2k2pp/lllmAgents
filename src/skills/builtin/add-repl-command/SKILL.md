---
name: add-repl-command
description: lllmAgentsにREPLコマンドを追加する。ユーザーが「/XXXコマンドを追加して」「新しいコマンドを実装して」と要求したときに使用する。
---

# Add REPL Command Skill

新しい REPL コマンドは **コマンドレジストリ方式** (`src/cli/commands/`) で追加する。
1コマンド=1ファイルで定義し、レジストリに登録するだけでディスパッチ・補完・/help のすべてに反映される (docs/production-readiness.md PR-10)。

旧方式 (repl.ts の switch + completer.ts + renderer.ts の3箇所更新) は廃止方向。新規追加には使わないこと。

## 追加手順 (2ステップ)

### 1. `src/cli/commands/<name>.ts` — コマンド定義を作成

```typescript
import chalk from "chalk";
import type { ReplCommandDef } from "./types.js";

export const newcmdCommand: ReplCommandDef = {
  name: "/newcmd",
  summary: "/help に出す1行説明",
  completions: [
    { command: "/newcmd", description: "コマンドの説明" },
    // サブコマンドは別エントリ。選択後に引数入力を続けるなら needsArg: true
    { command: "/newcmd sub", description: "サブコマンドの説明", needsArg: true },
  ],
  handler(ctx, args) {
    if (args.length === 0) {
      console.log(chalk.dim("  現在の値: ..."));
      console.log(chalk.dim("  使用方法: /newcmd <arg>"));
      return;
    }
    // 再起動後も維持したい設定変更は ctx.config を書き換えて ctx.saveConfig() を呼ぶ
    ctx.config.someKey = args[0];
    ctx.saveConfig();
    console.log(chalk.green("  変更しました (設定に保存)"));
  },
};
```

- `ctx` (ReplCommandContext) から `agent` / `config` / `saveConfig()` にアクセスできる。
  必要な依存が足りない場合は `src/cli/commands/types.ts` の ReplCommandContext に追加し、
  repl.ts のコンテキスト生成箇所 (handleCommand 内) にも渡す
- handler が `"quit"` を返すと REPL ループが終了する

### 2. `src/cli/commands/registry.ts` — COMMANDS 配列に登録

```typescript
import { newcmdCommand } from "./newcmd.js";

const COMMANDS: ReplCommandDef[] = [/* 既存 */, newcmdCommand];
```

これで完了。補完ドロップダウンと /help は自動生成される。

## 仕上げ

1. `npx tsc --noEmit` で型エラー確認
2. `tests/cli/command-registry.test.ts` に handler のテストを追加 (フェイク ctx で挙動検証)
3. README.md のコマンド一覧に1行追記 (ここだけは手動)

## Rules

- 設定変更の永続化は `ctx.saveConfig()`。呼ばないと再起動でリセットされる
  - セッション内だけで有効な変更 → 不要 / 再起動後も維持 → 必要
- 既存コマンドのスタイル (`chalk.dim` = 情報、`chalk.yellow` = 注意、`chalk.green` = 成功) に合わせる
- 既存の switch 方式コマンド (repl.ts 内) を修正するときは、可能ならついでにレジストリへ移設する
