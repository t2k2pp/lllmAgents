import type { ModelInfo } from "../config/types.js";

/**
 * `/model <名前>` / `/model second model <名前>` で直接指定されたモデル名の検査
 * (docs/todo-legacy-ways-cleanup.md T2)。
 *
 * 以前はどんな語でも受け付けて切り替え・保存していたため、 打ち間違いや
 * `/model foo bar` のような入力でメインモデルが実在しない名前に黙って変わっていた。
 * 切り替えるのは、 プロバイダーのモデル一覧 (= `/model list` と同じ取得元) に
 * 含まれる名前だけにする。 一覧が取れない (サーバー停止等) ときも黙って切り替えず、
 * エラーとして知らせて再試行か picker を案内する (silent なフォールバック禁止)。
 */
export type ModelNameCheck = { ok: true } | { ok: false; lines: string[] };

export interface ModelNameCheckOptions {
  /** 使い方の表示に使う書き方 (例: "/model <モデル名>") */
  usage: string;
  /** 一覧から選ぶ picker のコマンド (例: "/model list") */
  pickerCommand: string;
}

/** 引数が 1 語であることを確かめる。 余分な語があれば使い方エラー。 */
export function checkModelNameArgs(nameArgs: readonly string[], opts: ModelNameCheckOptions): ModelNameCheck {
  if (nameArgs.length === 1 && nameArgs[0].trim() !== "") return { ok: true };
  if (nameArgs.length === 0) {
    return { ok: false, lines: [`使い方: ${opts.usage}`, `一覧から選ぶ場合: ${opts.pickerCommand}`] };
  }
  return {
    ok: false,
    lines: [
      `余分な引数があります: ${nameArgs.join(" ")}`,
      `使い方: ${opts.usage}   (モデル名は 1 つだけ指定します)`,
      `一覧から選ぶ場合: ${opts.pickerCommand}`,
    ],
  };
}

/** モデル名がプロバイダーの一覧に含まれるかを確かめる。 */
export async function checkModelNameAvailable(
  name: string,
  listModels: () => Promise<ModelInfo[]>,
  opts: ModelNameCheckOptions,
): Promise<ModelNameCheck> {
  let models: ModelInfo[];
  try {
    models = await listModels();
  } catch (e) {
    return {
      ok: false,
      lines: [
        `モデル一覧を取得できなかったため、 ${name} への切り替えは行いませんでした。`,
        `原因: ${e instanceof Error ? e.message : String(e)}`,
        `サーバーの起動・接続先を確認して再試行するか、 ${opts.pickerCommand} で一覧から選んでください。`,
      ],
    };
  }
  // ローカル系プロバイダーはサーバー停止時に例外ではなく空の一覧を返すため、 空も「取得できない」 として扱う
  if (models.length === 0) {
    return {
      ok: false,
      lines: [
        `モデル一覧が空だったため、 ${name} への切り替えは行いませんでした。`,
        `サーバーが停止しているか、 モデルが読み込まれていない可能性があります。`,
        `サーバーを確認して再試行するか、 ${opts.pickerCommand} で一覧から選んでください。`,
      ],
    };
  }
  if (models.some((m) => m.name === name)) return { ok: true };
  const names = models.map((m) => m.name);
  const shown = names.slice(0, 10).join(", ");
  return {
    ok: false,
    lines: [
      `モデル ${name} は利用可能なモデルにありません。 切り替えは行いませんでした。`,
      `利用可能: ${shown}${names.length > 10 ? ` ほか ${names.length - 10} 件` : ""}`,
      `一覧から選ぶ場合: ${opts.pickerCommand}`,
    ],
  };
}
