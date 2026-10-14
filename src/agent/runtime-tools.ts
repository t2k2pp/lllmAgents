import { execFileSync } from "node:child_process";
import { isWindows } from "../utils/platform.js";

/**
 * 実際に使える Python を調べる (docs/env-info-and-app-basics.md §2.1)。
 *
 * `which python` では Windows の Microsoft Store エイリアス (中身の無い python.exe) も見つかってしまい、
 * モデルが Python がある前提で手を動かして失敗する。 `--version` で実際に起動して確かめる。
 * session 内で安定な値なので、 プロセス内で 1 回だけ調べてキャッシュする (プロンプトキャッシュを壊さない)。
 */
export interface PythonInfo {
  /** 起動に使うコマンド名 (python3 / python / py) */
  command: string;
  /** "Python 3.12.4" など */
  version: string;
}

type Probe = (command: string) => string | null;

function defaultProbe(command: string): string | null {
  try {
    // Store エイリアスは exit 9009 で失敗する → catch で「無い」 扱い
    return execFileSync(command, ["--version"], {
      encoding: "utf-8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

let cached: PythonInfo | null | undefined;

export function detectPython(probe: Probe = defaultProbe): PythonInfo | null {
  if (cached !== undefined && probe === defaultProbe) return cached;
  const candidates = isWindows ? ["python3", "python", "py"] : ["python3", "python"];
  let found: PythonInfo | null = null;
  for (const command of candidates) {
    const m = probe(command)?.match(/Python\s+\d+(?:\.\d+)*/);
    if (m) {
      found = { command, version: m[0] };
      break;
    }
  }
  if (probe === defaultProbe) cached = found;
  return found;
}

/** system prompt の `# Environment` に入れる 1 行 */
export function describePython(info: PythonInfo | null): string {
  return info
    ? `- Python: \`${info.command}\` (${info.version})`
    : "- Python: not installed — use node for helper scripts";
}

/** テスト用: キャッシュを捨てる */
export function resetRuntimeToolsCache(): void {
  cached = undefined;
}
