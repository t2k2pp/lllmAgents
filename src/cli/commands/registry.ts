/**
 * REPL コマンドレジストリ (docs/production-readiness.md PR-10)。
 *
 * 新規コマンドの追加手順:
 * 1. src/cli/commands/<name>.ts に ReplCommandDef を1つ定義する
 * 2. 下の COMMANDS 配列に追加する
 * これだけでディスパッチ・補完ドロップダウン・/help 表示のすべてに反映される
 * (旧方式の「repl.ts / completer.ts / displayHelp / README の4箇所を揃える」は不要。
 *  README への追記だけは引き続き手動)。
 */
import type { ReplCommandDef, ReplCommandCompletion } from "./types.js";
import { parallelCommand } from "./parallel.js";
import { autorunCommand } from "./autorun.js";
import { loglevelCommand } from "./loglevel.js";

const COMMANDS: ReplCommandDef[] = [parallelCommand, autorunCommand, loglevelCommand];

let lookupCache: Map<string, ReplCommandDef> | null = null;

/** コマンド名 (と alias) → 定義 の lookup を返す */
export function getCommandRegistry(): Map<string, ReplCommandDef> {
  if (lookupCache) return lookupCache;
  const map = new Map<string, ReplCommandDef>();
  for (const def of COMMANDS) {
    for (const key of [def.name, ...(def.aliases ?? [])]) {
      const lower = key.toLowerCase();
      if (map.has(lower)) {
        // 定義の重複はプログラミングエラー。起動時に即気づけるよう投げる
        throw new Error(`REPL コマンドの重複登録: ${lower}`);
      }
      map.set(lower, def);
    }
  }
  lookupCache = map;
  return map;
}

/** 補完ドロップダウン用の候補一覧 (completer.ts が BUILTIN_COMMAND_DEFS と合成する) */
export function getRegistryCompletions(): ReplCommandCompletion[] {
  return COMMANDS.flatMap((def) => def.completions);
}

/** /help のコマンド欄に出す { name, summary } 一覧 */
export function getRegistryHelpEntries(): Array<{ name: string; summary: string }> {
  return COMMANDS.map((def) => ({ name: def.name, summary: def.summary }));
}
