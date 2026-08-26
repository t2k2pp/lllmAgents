import { describe, expect, it } from "vitest";
import { validateCommitMessage } from "../../scripts/commit-message-policy.js";

const validMessage = `Safe modeの復旧境界を追加

背景:
- 壊れた設定を切り分ける起動経路が必要だった。

変更:
- 外部カスタマイズを起動前に無効化した。

検証:
- unitとE2Eを実行した。
`;

describe("commit message policy", () => {
  it("日本語タイトルと背景・変更・検証を持つ本文を受理する", () => {
    expect(validateCommitMessage(validMessage)).toEqual([]);
  });

  it("英語だけのタイトルを拒否する", () => {
    expect(validateCommitMessage(validMessage.replace("Safe modeの復旧境界を追加", "feat: add safe mode"))).toContain(
      "タイトルは変更目的が分かる日本語で記述してください",
    );
  });

  it("本文なしを拒否する", () => {
    expect(validateCommitMessage("修正する")).toEqual(
      expect.arrayContaining([
        "タイトルと本文の間に空行が必要です",
        "本文に「背景:」が必要です",
        "本文に「変更:」が必要です",
        "本文に「検証:」が必要です",
      ]),
    );
  });

  it("見出しだけで具体的な箇条書きがない本文を拒否する", () => {
    const errors = validateCommitMessage(`修正する\n\n背景:\nなし\n変更:\nなし\n検証:\nなし\n`);
    expect(errors.filter((error) => error.includes("具体的な箇条書き"))).toHaveLength(3);
  });
});
