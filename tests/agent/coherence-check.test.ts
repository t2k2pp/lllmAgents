import { describe, it, expect } from "vitest";
import { checkCoherence, buildCoherenceNudge } from "../../src/agent/coherence-check.ts";

describe("checkCoherence — ズレ検出 (緩めパターン)", () => {
  it("thinking に「次に」 + text に「完了」 でズレ検出", () => {
    const r = checkCoherence("次にエッジケースを確認します", "実装完了しました", false);
    expect(r.mismatch).toBe(true);
    expect(r.continuationHit).toBe("次に");
    expect(r.completionHit).toMatch(/完了/);
  });

  it("thinking 続き示唆 + response_complete 呼出でズレ検出", () => {
    const r = checkCoherence("もう少し詰める予定", "", true);
    expect(r.mismatch).toBe(true);
    expect(r.completionHit).toBe("response_complete()");
  });

  it("thinking に続き示唆あるが text/RC に完了系なし → ズレなし", () => {
    const r = checkCoherence("次にリファクタリング", "コードを更新しました", false);
    expect(r.mismatch).toBe(false);
  });

  it("thinking に続き示唆なし → ズレなし (text に完了あっても)", () => {
    const r = checkCoherence("実装した", "完了しました", false);
    expect(r.mismatch).toBe(false);
  });

  it("英語パターン: still need + done", () => {
    const r = checkCoherence("I still need to check edge cases", "Done!", false);
    expect(r.mismatch).toBe(true);
  });

  it("「あとで」 系も拾う", () => {
    const r = checkCoherence("あとでテスト追加", "以上", false);
    expect(r.mismatch).toBe(true);
    expect(r.continuationHit).toMatch(/あとで/);
  });
});

describe("buildCoherenceNudge", () => {
  it("nudge にマッチ内容が含まれる", () => {
    const nudge = buildCoherenceNudge({
      mismatch: true,
      continuationHit: "次に",
      completionHit: "完了",
    });
    expect(nudge).toContain("次に");
    expect(nudge).toContain("完了");
    expect(nudge).toContain("[ハーネス通知]");
  });
});
