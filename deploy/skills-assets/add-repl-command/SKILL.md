---
name: add-repl-command
description: lllmAgentsにREPLコマンドを追加する。ユーザーが「/XXXコマンドを追加して」「新しいコマンドを実装して」と要求したときに使用する。
---

# Add REPL Command Skill

REPLコマンドを追加する際は、以下の3ファイルをすべて更新する。1つでも漏れるとコマンドが動作しないか補完・ヘルプに表示されない。

## 更新が必要な3ファイル

### 1. `src/cli/repl.ts` — コマンドハンドラー

switch文に `case "/コマンド名":` を追加する。
挿入位置: 機能的に近いコマンドの直後（例: `/compact` の後なら同じ表示系）。

```typescript
case "/newcmd": {
  if (args.length === 0) {
    // 引数なし: 現在状態を表示
    console.log(chalk.dim(`  現在の値: ...`));
    console.log(chalk.dim("  使用方法: /newcmd <arg>"));
  } else if (args[0] === "subcommand") {
    // サブコマンド処理
    // 設定変更を伴う場合は必ず saveConfig(this.config) を呼ぶ
    saveConfig(this.config);
    console.log(chalk.dim("  変更しました。（設定を保存しました）"));
  } else {
    console.log(chalk.yellow("  使用方法: /newcmd [subcommand]"));
  }
  break;
}
```

**注意**: 設定を変更する場合は `saveConfig(this.config)` を必ず呼ぶこと。呼ばないと再起動で設定がリセットされる。

### 2. `src/cli/completer.ts` — 補完候補

`BUILTIN_COMMAND_DEFS` 配列にエントリを追加する。
サブコマンドがある場合はそれぞれ別エントリとして追加する。

```typescript
{ command: "/newcmd", description: "コマンドの説明" },
{ command: "/newcmd subcommand", description: "サブコマンドの説明" },
```

挿入位置: repl.tsでの挿入位置と対応する箇所（`/compact` の後なら `compact` エントリの後）。

### 3. `src/cli/renderer.ts` — ヘルプ表示

`displayHelp()` 関数内の `console.log(...)` にエントリを追加する。

```typescript
${chalk.cyan("/newcmd")}        コマンドの説明
${chalk.cyan("/newcmd <arg>")}  引数付きの説明
```

挿入位置: 機能的に近いコマンドの近く。パディングは既存行に合わせる（20文字前後）。

## How It Works

1. ユーザーからコマンド名・機能・引数を確認する（不明な場合は `ask_user` で質問）
2. `src/cli/repl.ts` を読んで挿入位置を特定し、ハンドラーを追加
3. `src/cli/completer.ts` を読んで `BUILTIN_COMMAND_DEFS` にエントリを追加
4. `src/cli/renderer.ts` を読んで `displayHelp()` にエントリを追加
5. `npx tsc --noEmit` で型エラーがないか確認

## Rules

- 3ファイルすべてを必ず更新する（漏れがあっても型エラーにならないため自動検出できない）
- `saveConfig` が必要かどうかはコマンドの性質で判断する
  - セッション内だけで有効な設定変更 → 不要
  - 再起動後も維持したい設定変更 → 必要
- 既存コマンドのスタイル（`chalk.dim`、`chalk.yellow` の使い分け等）に合わせる
