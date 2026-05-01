import { describe, it, expect } from "vitest";
import { formatSelfCheck, rephraseUserIntent, SUB_AGENT_ACTION_HINT } from "../../src/agent/self-check-messages.js";

describe("rephraseUserIntent (沈黙系依頼の翻訳)", () => {
  it("「応答を返さないで」 を翻訳する", () => {
    const result = rephraseUserIntent("続けて。 ある程度ゲームとして遊べるようになるまで応答を返さないで。");
    expect(result).toContain("継続的にツール");
    expect(result).toContain("中間報告のテキストを返さずに");
    expect(result).not.toContain("応答を返さないで");
  });

  it("「返事不要」 / 「返答不要」 を翻訳する", () => {
    expect(rephraseUserIntent("黙々と続けて。 返事不要")).toContain("継続的にツール");
    expect(rephraseUserIntent("返答不要で進めて")).toContain("継続的にツール");
  });

  it("「中間報告不要」 を翻訳する", () => {
    expect(rephraseUserIntent("最後まで終わったら教えて。 中間報告は不要")).toContain("継続的にツール");
  });

  it("「黙って」「だまって」「喋らないで」「しゃべらないで」 を翻訳する", () => {
    expect(rephraseUserIntent("黙って実装して")).toContain("継続的にツール");
    expect(rephraseUserIntent("だまって続けて")).toContain("継続的にツール");
    expect(rephraseUserIntent("途中で喋らないで実装を完了させて")).toContain("継続的にツール");
    expect(rephraseUserIntent("途中でしゃべらないで実装して")).toContain("継続的にツール");
  });

  it("沈黙系パターンを含まない通常の依頼はそのまま返す", () => {
    const intent = "main.js に Wave 進行ロジックを追加してください";
    expect(rephraseUserIntent(intent)).toBe(intent);
  });

  it("「黙認」 のような誤検出を起こさない (黙って の境界条件)", () => {
    // 「黙認」 自体は沈黙系依頼ではない (kanji boundary check)
    const intent = "問題を黙認せずに修正して";
    expect(rephraseUserIntent(intent)).toBe(intent);
  });
});

describe("formatSelfCheck", () => {
  it("通常の intent は逐語提示する", () => {
    const msg = formatSelfCheck(1, 3, "main.js を編集して", "ツール未呼出です。");
    expect(msg).toContain("[自己点検 1/3]");
    expect(msg).toContain("main.js を編集して");
    expect(msg).toContain("ツール未呼出です。");
    expect(msg).toContain("response_complete"); // デフォルト actionHint
  });

  it("沈黙系 intent は翻訳した形で提示する", () => {
    const msg = formatSelfCheck(2, 3, "応答を返さないで実装を続けて", "テキストだけです。");
    expect(msg).not.toContain("応答を返さないで");
    expect(msg).toContain("継続的にツール");
  });

  it("actionHint を渡せば response_complete 案内を上書きできる", () => {
    const msg = formatSelfCheck(1, 3, "intent", "concern", SUB_AGENT_ACTION_HINT);
    expect(msg).toContain("最終回答を出してタスクを完了");
    expect(msg).not.toContain("response_complete ツールを呼んでください");
  });

  it("intent が 200 文字を超える場合は truncate される", () => {
    const longIntent = "a".repeat(300);
    const msg = formatSelfCheck(1, 3, longIntent, "concern");
    expect(msg).toContain("...");
    // 元の 300 文字がそのまま埋め込まれていないこと (= 200 文字以下に切り詰められている)
    expect(msg).not.toContain("a".repeat(201));
    expect(msg).toContain("a".repeat(200));
  });
});
