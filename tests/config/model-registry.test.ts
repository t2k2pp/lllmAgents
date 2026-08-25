import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// テスト用の一時 config dir を vi.mock で注入する。
// 各テストが独立した dir を持てるよう、 dir 自体は実行時に解決する。
let testConfigDir = "";
vi.mock("../../src/config/config-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config-manager.js")>();
  return {
    ...actual,
    getConfigDir: () => testConfigDir,
  };
});

// mock 後に import
const {
  listEntries,
  getEntry,
  findEntryBySignature,
  recordEntry,
  updateEntry,
  deleteEntry,
  deleteEntries,
  touchEntry,
  getSlot,
  getSlots,
  setSlot,
  clearSlot,
  listNamedSlots,
  resolveEntryQuery,
  isValidSlotName,
  swapMainSecond,
  reconcileSlotsFromConfig,
  endpointSignature,
  generateEntryName,
  _registryFilePath,
  _legacyProfilesFilePath,
} = await import("../../src/config/model-registry.js");

const createdDirs: string[] = [];

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-registry-test-"));
  createdDirs.push(testConfigDir);
});

afterAll(() => {
  for (const d of createdDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("model-registry: signature / name", () => {
  it("endpointSignature は接続情報のみから決まり、 サンプリングパラメータは含めない", () => {
    const a = endpointSignature({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h:11434" });
    const b = endpointSignature({
      providerType: "ollama",
      model: "qwen3-32b",
      baseUrl: "http://h:11434",
      temperature: 0.5,
    });
    expect(a).toBe(b);
  });

  it("model が違えば signature も違う", () => {
    const a = endpointSignature({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h:11434" });
    const b = endpointSignature({ providerType: "ollama", model: "qwen3-14b", baseUrl: "http://h:11434" });
    expect(a).not.toBe(b);
  });

  it("apiKey 種別 (env名/encrypted/plain) は signature に反映される", () => {
    const e1 = endpointSignature({ providerType: "anthropic", model: "claude-sonnet-4-6", apiKey: "env:KEY_A" });
    const e2 = endpointSignature({ providerType: "anthropic", model: "claude-sonnet-4-6", apiKey: "env:KEY_B" });
    const e3 = endpointSignature({ providerType: "anthropic", model: "claude-sonnet-4-6", apiKey: "encrypted:abc" });
    expect(e1).not.toBe(e2);
    expect(e1).not.toBe(e3);
  });

  it("generateEntryName: ローカル系は host を含む", () => {
    const n = generateEntryName({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://192.168.1.33:11434" });
    expect(n).toBe("ollama:qwen3-32b @ 192.168.1.33:11434");
  });

  it("generateEntryName: Anthropic 直接は host 無し", () => {
    const n = generateEntryName({ providerType: "anthropic", model: "claude-sonnet-4-6" });
    expect(n).toBe("anthropic:claude-sonnet-4-6");
  });
});

describe("model-registry: CRUD", () => {
  it("不完全な endpoint (model 空) は記録しない", () => {
    const r = recordEntry({ providerType: "ollama", model: "", baseUrl: "http://h" });
    expect(r).toBeUndefined();
    expect(listEntries()).toHaveLength(0);
  });

  it("recordEntry: 新規追加で UUID id が振られる", () => {
    const e = recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h:11434" });
    expect(e).toBeDefined();
    // UUID v4: 36 文字、 ハイフン入り
    expect(e!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(listEntries()).toHaveLength(1);
  });

  it("recordEntry: 同 signature は auto-merge (id 不変、 lastUsedAt 更新)", async () => {
    const e1 = recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h:11434" })!;
    // わずかに時間を空けて 2 回目
    await new Promise((r) => setTimeout(r, 10));
    const e2 = recordEntry({
      providerType: "ollama",
      model: "qwen3-32b",
      baseUrl: "http://h:11434",
      temperature: 0.7,
    })!;
    expect(e2.id).toBe(e1.id);
    expect(listEntries()).toHaveLength(1);
    expect(e2.endpoint.temperature).toBe(0.7);
    expect(e2.lastUsedAt >= e1.lastUsedAt).toBe(true);
  });

  it("recordEntry forceNew=true は signature 一致でも別エントリを作る (Duplicate 用)", () => {
    const e1 = recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h:11434" })!;
    const e2 = recordEntry(
      { providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h:11434", temperature: 0.2 },
      { forceNew: true },
    )!;
    expect(e2.id).not.toBe(e1.id);
    expect(listEntries()).toHaveLength(2);
  });

  it("findEntryBySignature で発見できる", () => {
    const e = recordEntry({ providerType: "gemini", model: "gemini-2.5-pro" })!;
    const f = findEntryBySignature({ providerType: "gemini", model: "gemini-2.5-pro" });
    expect(f?.id).toBe(e.id);
  });

  it("updateEntry: name と endpoint を更新できる", () => {
    const e = recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h:11434" })!;
    const u = updateEntry(e.id, { name: "自宅 Ollama", endpoint: { ...e.endpoint, temperature: 0.9 } });
    expect(u?.name).toBe("自宅 Ollama");
    expect(u?.endpoint.temperature).toBe(0.9);
  });

  it("updateEntry: 存在しない id は undefined", () => {
    expect(updateEntry("nonexistent", { name: "x" })).toBeUndefined();
  });

  it("deleteEntry: slot 参照も解除される", () => {
    const e = recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h" })!;
    setSlot("main", e.id);
    expect(getSlot("main")).toBe(e.id);
    deleteEntry(e.id);
    expect(getSlot("main")).toBeUndefined();
  });

  it("deleteEntries: 複数削除 + slot 参照解除", () => {
    const e1 = recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h" })!;
    const e2 = recordEntry({ providerType: "gemini", model: "gemini-2.5-pro" })!;
    setSlot("main", e1.id);
    setSlot("second", e2.id);
    const n = deleteEntries([e1.id, e2.id]);
    expect(n).toBe(2);
    expect(getSlots().main).toBe("");
    expect(getSlots().second).toBeUndefined();
  });

  it("touchEntry: lastUsedAt 更新", async () => {
    const e = recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h" })!;
    await new Promise((r) => setTimeout(r, 10));
    touchEntry(e.id);
    const updated = getEntry(e.id)!;
    expect(updated.lastUsedAt > e.lastUsedAt).toBe(true);
  });
});

describe("model-registry: slots", () => {
  it("setSlot は entry が存在しないと false (slot 更新されない)", () => {
    expect(setSlot("main", "nonexistent")).toBe(false);
    expect(getSlots().main).toBe("");
  });

  it("setSlot main / second / named をそれぞれ独立に保持", () => {
    const a = recordEntry({ providerType: "ollama", model: "a", baseUrl: "http://h1" })!;
    const b = recordEntry({ providerType: "ollama", model: "b", baseUrl: "http://h2" })!;
    const c = recordEntry({ providerType: "gemini", model: "gemini-2.5-pro" })!;
    setSlot("main", a.id);
    setSlot("second", b.id);
    setSlot("vision", c.id);
    expect(getSlot("main")).toBe(a.id);
    expect(getSlot("second")).toBe(b.id);
    expect(getSlot("vision")).toBe(c.id);
    expect(getSlots().named?.vision).toBe(c.id);
  });

  it("clearSlot で個別に解除できる", () => {
    const a = recordEntry({ providerType: "ollama", model: "a", baseUrl: "http://h1" })!;
    setSlot("main", a.id);
    setSlot("eval", a.id);
    clearSlot("eval");
    expect(getSlot("main")).toBe(a.id);
    expect(getSlot("eval")).toBeUndefined();
  });

  it("swapMainSecond: main ⇔ second 入替、 entry そのものは無傷", () => {
    const a = recordEntry({ providerType: "ollama", model: "a", baseUrl: "http://h1" })!;
    const b = recordEntry({ providerType: "ollama", model: "b", baseUrl: "http://h2" })!;
    setSlot("main", a.id);
    setSlot("second", b.id);
    expect(swapMainSecond()).toBe(true);
    expect(getSlot("main")).toBe(b.id);
    expect(getSlot("second")).toBe(a.id);
    expect(listEntries()).toHaveLength(2); // entry 数は変わらない
  });

  it("swapMainSecond: second 未割当なら false (no-op)", () => {
    const a = recordEntry({ providerType: "ollama", model: "a", baseUrl: "http://h1" })!;
    setSlot("main", a.id);
    expect(swapMainSecond()).toBe(false);
    expect(getSlot("main")).toBe(a.id);
  });
});

describe("model-registry: named slot / entry query (Phase 6)", () => {
  it("listNamedSlots は既定で予約 slot (vision) を除いた自由 slot のみ返す", () => {
    const a = recordEntry({ providerType: "ollama", model: "a", baseUrl: "http://h1" })!;
    const b = recordEntry({ providerType: "ollama", model: "b", baseUrl: "http://h2" })!;
    setSlot("main", a.id);
    setSlot("second", b.id);
    setSlot("vision", a.id);
    setSlot("deep", a.id);
    setSlot("fast", b.id);

    expect(listNamedSlots()).toEqual([
      { slot: "deep", entryId: a.id },
      { slot: "fast", entryId: b.id },
    ]);
    expect(listNamedSlots({ includeReserved: true }).map((s) => s.slot)).toEqual(["deep", "fast", "vision"]);
  });

  it("listNamedSlots: named slot が無ければ空配列", () => {
    const a = recordEntry({ providerType: "ollama", model: "a", baseUrl: "http://h1" })!;
    setSlot("main", a.id);
    expect(listNamedSlots()).toEqual([]);
  });

  it("isValidSlotName: 英小文字始まり + 2〜20 文字のみ許可", () => {
    expect(isValidSlotName("fast")).toBe(true);
    expect(isValidSlotName("deep-2")).toBe(true);
    expect(isValidSlotName("f")).toBe(false); // 1 文字は短すぎる
    expect(isValidSlotName("Fast")).toBe(false); // 大文字
    expect(isValidSlotName("2fast")).toBe(false); // 数字始まり
    expect(isValidSlotName("速い")).toBe(false); // 日本語
    expect(isValidSlotName("a".repeat(21))).toBe(false); // 21 文字
  });

  it("resolveEntryQuery: 番号 (listEntries の 1 始まり) で特定できる", () => {
    const a = recordEntry({ providerType: "ollama", model: "a", baseUrl: "http://h1" })!;
    expect(resolveEntryQuery("1")?.id).toBe(a.id);
    expect(resolveEntryQuery("9")).toBeUndefined();
  });

  it("resolveEntryQuery: id 前方一致 / 名前部分一致 (大小無視)", () => {
    const a = recordEntry({ providerType: "ollama", model: "Qwen3-32B", baseUrl: "http://h1" })!;
    recordEntry({ providerType: "gemini", model: "gemini-2.5-pro" });
    expect(resolveEntryQuery(a.id)?.id).toBe(a.id);
    expect(resolveEntryQuery(a.id.slice(0, 8))?.id).toBe(a.id);
    expect(resolveEntryQuery("qwen3")?.id).toBe(a.id);
  });

  it("resolveEntryQuery: 数字だけのUUID前方一致を範囲外の一覧番号として捨てない", () => {
    recordEntry({ providerType: "ollama", model: "numeric-prefix", baseUrl: "http://h1" });
    const file = _registryFilePath();
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    store.entries[0].id = "12345678-d7bb-47e6-b6a7-79d250897f18";
    fs.writeFileSync(file, JSON.stringify(store), "utf8");

    expect(resolveEntryQuery("12345678")?.id).toBe("12345678-d7bb-47e6-b6a7-79d250897f18");
  });

  it("resolveEntryQuery: 一意に絞れなければ undefined (曖昧なまま採用しない)", () => {
    recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h1" });
    recordEntry({ providerType: "ollama", model: "qwen3-9b", baseUrl: "http://h2" });
    expect(resolveEntryQuery("qwen3")).toBeUndefined();
    expect(resolveEntryQuery("")).toBeUndefined();
  });
});

describe("model-registry: reconcileSlotsFromConfig (起動時マイグレーション)", () => {
  it("config.mainLLM がレジストリに無ければ新規追加 + slots.main を設定", () => {
    reconcileSlotsFromConfig({
      mainLLM: { providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h" },
      visionLLM: null,
      secondLLM: null,
    } as any);
    const list = listEntries();
    expect(list).toHaveLength(1);
    expect(getSlot("main")).toBe(list[0].id);
    expect(getSlot("second")).toBeUndefined();
  });

  it("config.secondLLM があれば second slot も設定", () => {
    reconcileSlotsFromConfig({
      mainLLM: { providerType: "ollama", model: "main", baseUrl: "http://h1" },
      visionLLM: null,
      secondLLM: {
        enabled: true,
        endpoint: { providerType: "anthropic", model: "claude-sonnet-4-6" },
        budget: null,
        cost: { referenceModels: [] },
      },
    } as any);
    const list = listEntries();
    expect(list).toHaveLength(2);
    expect(getSlot("main")).toBeDefined();
    expect(getSlot("second")).toBeDefined();
    expect(getSlot("main")).not.toBe(getSlot("second"));
  });

  it("既存 entry に signature 一致があれば再利用 (重複追加しない)", () => {
    // 先に手動で同じ endpoint を追加
    recordEntry({ providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h" });
    expect(listEntries()).toHaveLength(1);

    reconcileSlotsFromConfig({
      mainLLM: { providerType: "ollama", model: "qwen3-32b", baseUrl: "http://h" },
      visionLLM: null,
      secondLLM: null,
    } as any);

    expect(listEntries()).toHaveLength(1); // 重複追加されない
    expect(getSlot("main")).toBe(listEntries()[0].id);
  });

  it("vision slot (Phase 5): config.visionLLM があれば slots.named.vision に同期される", () => {
    reconcileSlotsFromConfig({
      mainLLM: { providerType: "ollama", model: "main", baseUrl: "http://h1" },
      visionLLM: { providerType: "anthropic", model: "claude-sonnet-4-6" },
      secondLLM: null,
    } as any);
    const list = listEntries();
    expect(list).toHaveLength(2);
    expect(getSlot("main")).toBeDefined();
    expect(getSlot("vision")).toBeDefined();
    expect(getSlot("main")).not.toBe(getSlot("vision"));
    expect(getSlots().named?.vision).toBe(getSlot("vision"));
  });

  it("vision slot: config.visionLLM が null なら slots.named.vision は未割当", () => {
    // 先に vision を入れる
    reconcileSlotsFromConfig({
      mainLLM: { providerType: "ollama", model: "main", baseUrl: "http://h" },
      visionLLM: { providerType: "gemini", model: "gemini-2.5-pro" },
      secondLLM: null,
    } as any);
    expect(getSlot("vision")).toBeDefined();
    // 次に vision を抜く
    reconcileSlotsFromConfig({
      mainLLM: { providerType: "ollama", model: "main", baseUrl: "http://h" },
      visionLLM: null,
      secondLLM: null,
    } as any);
    expect(getSlot("vision")).toBeUndefined();
    // entry 自体は残る (削除されない)
    expect(listEntries()).toHaveLength(2);
  });
});

describe("model-registry: 旧 llm-profiles.json からの移行", () => {
  it("llm-profiles.json があれば model-registry.json に移行される (entry はそのまま、 旧 id を温存)", () => {
    // 旧形式のファイルを作る
    const legacyPath = _legacyProfilesFilePath();
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(
      legacyPath,
      JSON.stringify(
        {
          profiles: [
            {
              id: "abc12345", // 旧 8 文字 hex
              name: "anthropic:claude-sonnet-4-6",
              endpoint: { providerType: "anthropic", model: "claude-sonnet-4-6" },
              createdAt: "2026-05-18T00:00:00.000Z",
              lastUsedAt: "2026-05-18T00:00:00.000Z",
            },
          ],
        },
        null,
        2,
      ),
    );

    // 初回 read で移行が起こる
    const list = listEntries();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe("abc12345"); // 旧 id 温存

    // 新ファイルが作られている
    expect(fs.existsSync(_registryFilePath())).toBe(true);
    // 旧ファイルは消えていない (rollback 用)
    expect(fs.existsSync(legacyPath)).toBe(true);
  });

  it("llm-profiles.json も model-registry.json も無ければ空 store", () => {
    expect(listEntries()).toHaveLength(0);
    expect(getSlots().main).toBe("");
  });
});
