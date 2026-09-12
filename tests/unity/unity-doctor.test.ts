import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { diagnoseUnity } from "../../src/unity/unity-integration.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
let root: string;
afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  vi.resetAllMocks();
});
function project() {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "unity-doctor-")));
  fs.mkdirSync(path.join(root, "Packages"));
  fs.mkdirSync(path.join(root, "ProjectSettings"));
  fs.writeFileSync(path.join(root, "Packages/manifest.json"), "{}");
  fs.writeFileSync(path.join(root, "ProjectSettings/ProjectVersion.txt"), "fixture");
  return root;
}
describe("Unity doctor without a real Editor", () => {
  it("checks only the selected ready Editor and does not start a model or scene command", () => {
    const selected = project();
    vi.mocked(execFileSync)
      .mockReturnValueOnce("fixture-version")
      .mockReturnValueOnce(
        JSON.stringify({ success: true, data: { instances: [{ project: selected, state: "ready" }] } }),
      );
    expect(diagnoseUnity(selected)).toMatchObject({ ready: true, modelTestExecuted: false });
    expect(vi.mocked(execFileSync).mock.calls.map((call) => call[1])).toEqual([
      ["--version"],
      ["status", "--format", "json"],
    ]);
  });
  it("rejects another project's ready Editor", () => {
    const selected = project();
    vi.mocked(execFileSync)
      .mockReturnValueOnce("fixture-version")
      .mockReturnValueOnce(
        JSON.stringify({
          success: true,
          data: { instances: [{ project: path.join(selected, "other"), state: "ready" }] },
        }),
      );
    expect(() => diagnoseUnity(selected)).toThrow("not ready");
  });
  it("rejects unknown status and preserves CLI stdout errors", () => {
    const selected = project();
    vi.mocked(execFileSync).mockReturnValueOnce("fixture-version").mockReturnValueOnce("{}");
    expect(() => diagnoseUnity(selected)).toThrow("unavailable");
    vi.mocked(execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("exit 1"), { stdout: '{"errors":[{"code":"STATUS_NO_INSTANCES"}]}' });
    });
    expect(() => diagnoseUnity(selected)).toThrow("STATUS_NO_INSTANCES");
  });
});
