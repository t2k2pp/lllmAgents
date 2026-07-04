/**
 * REPL コマンドレジストリの型定義 (docs/production-readiness.md PR-10)。
 *
 * 「1コマンド=1ファイル」で name / summary / 補完候補 / handler を1オブジェクトに
 * まとめる。ヘルプと補完はレジストリから自動生成されるため、旧方式の
 * 「新コマンド追加は4箇所 (repl.ts / completer.ts / displayHelp / README) を揃える」
 * チェックリストがレジストリ登録コマンドでは原理的に不要になる。
 *
 * 移行方針 (ビッグバン禁止):
 * - 新規コマンドは必ずこの方式で追加する
 * - 既存の repl.ts 内 switch コマンドは、触るついでに移設する
 */
import type { Config } from "../../config/types.js";
import type { AgentLoop } from "../../agent/agent-loop.js";

/**
 * コマンドから見える REPL の能力。REPL 本体 (repl.ts) が生成して handler に渡す。
 * 依存が増えたらここに追加する (repl.ts の private を直接参照しない)。
 */
export interface ReplCommandContext {
  agent: AgentLoop;
  config: Config;
  /** ctx.config の現在の内容を config.json に保存する */
  saveConfig(): void;
}

/** 補完候補1件。completer.ts の CommandDef と同形 */
export interface ReplCommandCompletion {
  /** 例: "/parallel"、サブコマンドは "/sandbox on" のようにスペース区切り */
  command: string;
  description: string;
  /** true なら選択後も引数入力を続ける (即確定しない) */
  needsArg?: boolean;
}

export interface ReplCommandDef {
  /** プライマリ名 (先頭スラッシュ込み、例 "/parallel")。小文字で定義する */
  name: string;
  /** 別名 (例 "/exit" に対する "/quit")。ディスパッチのみ対象で補完には completions を使う */
  aliases?: string[];
  /** /help に表示する1行説明 */
  summary: string;
  /** 補完ドロップダウン候補 (サブコマンド含む) */
  completions: ReplCommandCompletion[];
  /**
   * コマンド本体。args はコマンド名を除く空白区切りトークン。
   * "quit" を返すと REPL ループが終了する (旧 handleCommand と同じ規約)。
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: 「何も返さない」handler 実装 (推論 void) を許容するための union
  handler(ctx: ReplCommandContext, args: string[]): Promise<string | void> | string | void;
}
