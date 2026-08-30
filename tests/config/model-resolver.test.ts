import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// テスト用の一時 config dir を vi.mock で注入する (model-registry.test.ts と同じ方式)。
let testConfigDir = "";
vi.mock("../../src/config/config-manager.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/config/config-manager.js")>();
  return {
    ...actual,
    getConfigDir: () => testConfigDir,
  };
});

// mock 後に import
const { recordEntry, updateEntry, setSlot, listEntries, _registryFilePath } = await import(
  "../../src/config/model-registry.js"
);
const { resolveModelRef, resolveModelRefOrMain, listResolvableSlots, setResolverPassphrase, invalidateModelCache } =
  await import("../../src/config/model-resolver.js");

const createdDirs: string[] = [];

/** ローカル系 endpoint。 provider 生成にネットワークアクセスが要らないので単体テストに使える。 */
function local(model: string, host = "http://127.0.0.1:11434") {
  return { providerType: "ollama" as const, model, baseUrl: host };
}

beforeEach(() => {
  testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "model-resolver-test-"));
  createdDirs.push(testConfigDir);
  // モジュールスコープの状態はテスト間で持ち越さない
  invalidateModelCache();
  setResolverPassphrase(undefined);
});

afterAll(() => {
  for (const d of createdDirs) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("model-resolver: ref の解決", () => {
  it("main slot を解決できる", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    setSlot("main", e.id);
    const r = resolveModelRef("main");
    expect(r).toBeDefined();
    expect(r!.entryId).toBe(e.id);
    expect(r!.model).toBe("qwen3-32b");
    expect(r!.slot).toBe("main");
    expect(r!.label).toBe(e.name);
    expect(r!.provider).toBeDefined();
  });

  it("自由 named slot を解決できる", () => {
    const e = recordEntry(local("qwen3-9b"))!;
    setSlot("fast", e.id);
    const r = resolveModelRef("fast");
    expect(r?.entryId).toBe(e.id);
    expect(r?.slot).toBe("fast");
  });

  it("id:<entry-id> で直接指定できる (slot は経由しない)", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    const r = resolveModelRef(`id:${e.id}`);
    expect(r?.entryId).toBe(e.id);
    expect(r?.slot).toBeUndefined();
  });

  it("name:<部分一致> で解決できる (大小無視)", () => {
    const e = recordEntry(local("Qwen3-32B"))!;
    recordEntry(local("gemma3-12b", "http://127.0.0.1:11435"));
    const r = resolveModelRef("name:qwen3");
    expect(r?.entryId).toBe(e.id);
  });

  it("name: が複数に一致したら曖昧なので解決しない", () => {
    recordEntry(local("qwen3-32b", "http://h1:11434"));
    recordEntry(local("qwen3-9b", "http://h2:11434"));
    expect(resolveModelRef("name:qwen3")).toBeUndefined();
  });

  it("素の文字列は slot → id → name の順に試す (slot が entry 名に勝つ)", () => {
    const slotTarget = recordEntry(local("qwen3-9b", "http://h1:11434"))!;
    const nameTarget = recordEntry(local("fast", "http://h2:11434"))!;
    // entry 名は "ollama:fast @ h2:11434" なので "fast" は名前部分一致もする
    setSlot("fast", slotTarget.id);
    const r = resolveModelRef("fast");
    expect(r?.entryId).toBe(slotTarget.id);
    expect(r?.entryId).not.toBe(nameTarget.id);
  });

  it("素の文字列: slot に無ければ id 完全一致で解決する", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    const r = resolveModelRef(e.id);
    expect(r?.entryId).toBe(e.id);
    expect(r?.slot).toBeUndefined();
  });

  it("未定義の ref は undefined", () => {
    recordEntry(local("qwen3-32b"));
    expect(resolveModelRef("deep")).toBeUndefined();
    expect(resolveModelRef("")).toBeUndefined();
    expect(resolveModelRef("  ")).toBeUndefined();
    expect(resolveModelRef("id:nonexistent")).toBeUndefined();
  });
});

describe("model-resolver: main の既定選択", () => {
  it("ref 未指定なら main を返す", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    setSlot("main", e.id);
    expect(resolveModelRefOrMain(undefined)?.entryId).toBe(e.id);
  });

  it("明示した ref を解決できなければ main に置換しない", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    setSlot("main", e.id);
    const r = resolveModelRefOrMain("deep");
    expect(r).toBeUndefined();
  });

  it("main も未割当なら undefined", () => {
    expect(resolveModelRefOrMain("deep")).toBeUndefined();
  });
});

describe("model-resolver: provider キャッシュ", () => {
  it("同じ entry を続けて解決すると同一 provider インスタンスを返す", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    setSlot("fast", e.id);
    const a = resolveModelRef("fast")!;
    const b = resolveModelRef("fast")!;
    expect(a.provider).toBe(b.provider);
  });

  it("endpoint が変われば signature 不一致で provider を作り直す", () => {
    const e = recordEntry(local("qwen3-32b", "http://h1:11434"))!;
    setSlot("fast", e.id);
    const a = resolveModelRef("fast")!;

    updateEntry(e.id, { endpoint: { ...e.endpoint, baseUrl: "http://h2:11434" } });
    const b = resolveModelRef("fast")!;
    expect(b.provider).not.toBe(a.provider);
    expect(b.endpoint.baseUrl).toBe("http://h2:11434");
  });

  it("接続情報が変わらない編集 (description のみ) ではキャッシュを維持する", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    setSlot("fast", e.id);
    const a = resolveModelRef("fast")!;

    updateEntry(e.id, { endpoint: { ...e.endpoint, description: "軽量・高速" } });
    const b = resolveModelRef("fast")!;
    expect(b.provider).toBe(a.provider);
  });

  it("invalidateModelCache(entryId) で該当 entry のみ作り直す", () => {
    const e1 = recordEntry(local("qwen3-32b", "http://h1:11434"))!;
    const e2 = recordEntry(local("qwen3-9b", "http://h2:11434"))!;
    setSlot("deep", e1.id);
    setSlot("fast", e2.id);
    const deepA = resolveModelRef("deep")!;
    const fastA = resolveModelRef("fast")!;

    invalidateModelCache(e1.id);
    expect(resolveModelRef("deep")!.provider).not.toBe(deepA.provider);
    expect(resolveModelRef("fast")!.provider).toBe(fastA.provider);
  });

  it("invalidateModelCache() 引数なしで全破棄", () => {
    const e = recordEntry(local("qwen3-32b"))!;
    setSlot("fast", e.id);
    const a = resolveModelRef("fast")!;
    invalidateModelCache();
    expect(resolveModelRef("fast")!.provider).not.toBe(a.provider);
  });
});

describe("model-resolver: 暗号化 apiKey と合言葉", () => {
  it("合言葉が無ければ暗号化 entry は解決しない (対話プロンプトは出さない)", () => {
    const e = recordEntry({ providerType: "anthropic", model: "claude-sonnet-4-6", apiKey: "encrypted:deadbeef" })!;
    setSlot("deep", e.id);
    expect(resolveModelRef("deep")).toBeUndefined();
  });

  it("解決できない暗号化 entry を main に置換しない", () => {
    const main = recordEntry(local("qwen3-32b"))!;
    setSlot("main", main.id);
    const enc = recordEntry({ providerType: "anthropic", model: "claude-sonnet-4-6", apiKey: "encrypted:deadbeef" })!;
    setSlot("deep", enc.id);
    expect(resolveModelRefOrMain("deep")).toBeUndefined();
  });
});

describe("model-resolver: listResolvableSlots", () => {
  it("自由 named slot のみを返す (main / second / vision は含めない)", () => {
    const a = recordEntry(local("qwen3-32b", "http://h1:11434"))!;
    const b = recordEntry(local("qwen3-9b", "http://h2:11434"))!;
    const c = recordEntry({ providerType: "gemini", model: "gemini-2.5-pro" })!;
    setSlot("main", a.id);
    setSlot("second", b.id);
    setSlot("vision", c.id);
    expect(listResolvableSlots()).toEqual([]);

    setSlot("fast", b.id);
    const slots = listResolvableSlots();
    expect(slots).toHaveLength(1);
    expect(slots[0].slot).toBe("fast");
    expect(slots[0].label).toBe(b.name);
  });

  it("entry の description を説明として返す", () => {
    const e = recordEntry({ ...local("qwen3-9b"), description: "軽量・高速。 単純な検索や要約向け" })!;
    setSlot("fast", e.id);
    expect(listResolvableSlots()[0].description).toBe("軽量・高速。 単純な検索や要約向け");
  });

  it("割当先 entry が消えている slot は列挙しない", () => {
    const e = recordEntry(local("qwen3-9b"))!;
    setSlot("fast", e.id);
    expect(listResolvableSlots()).toHaveLength(1);

    // 手編集などで slot だけ残り entry が消えた状態を作る (deleteEntry 経由だと slot も外れるため)
    const store = JSON.parse(fs.readFileSync(_registryFilePath(), "utf-8"));
    store.entries = [];
    fs.writeFileSync(_registryFilePath(), JSON.stringify(store, null, 2), "utf-8");

    expect(listEntries()).toHaveLength(0);
    expect(listResolvableSlots()).toEqual([]);
    expect(resolveModelRef("fast")).toBeUndefined();
  });
});
