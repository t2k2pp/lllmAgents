import * as os from "node:os";
import * as path from "node:path";

/**
 * Blender MCP の `execute_blender_code` に渡す Python を見て、 自動で通してよいかを決める検査器。
 * 設計: docs/mcp-tool-permission-design.md §4
 *
 * 方針は「控えめな見当」: 形づくりのふつうのコード (bpy・bmesh・math・mathutils・random…・
 * 作業フォルダの中への保存や書き出し) は通し、 少しでも分からない物は確認 (ask) に回す。
 * Python を実際に解析するのではなく、 コメントを除いた文字の並びを見る。 すり抜けを完全には防げないので、
 * 「通した = 安全の保証」 ではない (自律実行モードで確認の回数を減らすための物)。
 */

export interface InspectorContext {
  /** 作業フォルダ (書き込み・読み込みを許す範囲) */
  cwd: string;
  /** スキルの置き場 (部品箱 bkit.py を exec で読むのを許す範囲)。 既定は ~/.localllm/skills */
  skillsDir?: string;
}

export type InspectorResult = { decision: "allow" } | { decision: "ask"; reason: string };

/** そのまま import してよいモジュール (先頭の名前)。 これ以外は確認 */
const ALLOWED_MODULES = new Set([
  "bpy",
  "bmesh",
  "bpy_extras",
  "mathutils",
  "math",
  "cmath",
  "random",
  "colorsys",
  "itertools",
  "functools",
  "collections",
  "json",
  "re",
  "time",
  "datetime",
  "typing",
  "dataclasses",
  "copy",
  "enum",
  "statistics",
  "string",
  "textwrap",
  "heapq",
  "bisect",
  "operator",
  "numbers",
  "fractions",
  "decimal",
  "array",
  "struct",
  "numpy",
  "traceback",
  "contextlib",
  "abc",
  "types",
  "uuid",
  "hashlib",
  "base64",
  "pprint",
  "warnings",
  // 属性を絞って許す (下の OS_ATTRS / SYS_ATTRS / pathlib の書き込みの検査)
  "os",
  "sys",
  "pathlib",
]);

/** `os.` の後ろに来てよい名前。 消す・動かす・実行する・環境変数は確認 */
const OS_ATTRS = new Set([
  "path",
  "makedirs",
  "mkdir",
  "sep",
  "linesep",
  "curdir",
  "pardir",
  "extsep",
  "name",
  "fspath",
  "cpu_count",
  "listdir",
]);

/** `sys.` の後ろに来てよい名前。 sys.modules・sys.exit・settrace などは確認 */
const SYS_ATTRS = new Set([
  "path",
  "version",
  "version_info",
  "platform",
  "argv",
  "stdout",
  "stderr",
  "float_info",
  "maxsize",
  "byteorder",
  "getsizeof",
  "getrecursionlimit",
  "setrecursionlimit",
]);

/** 書き方だけで確認に回す物 (理由の文つき) */
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/(?<![\w.])(?:eval|exec|compile)\s*\(/, "eval / exec / compile でコードを組み立てて動かす"],
  [/__import__|importlib/, "__import__ / importlib で動的に読み込む"],
  [/__builtins__|__subclasses__|__globals__|__code__|__getattribute__/, "Python の内部 (__builtins__ など) に触る"],
  [/(?:globals|locals|vars)\s*\(\s*\)\s*\[/, "globals() などを書き換える"],
  [/\bgetattr\s*\(\s*(?:os|sys|builtins|bpy\.ops)\b/, "getattr で os / sys / bpy.ops の名前を組み立てる"],
  [/bpy\.ops\.wm\.quit_blender/, "Blender を終了する"],
  [/bpy\.ops\.wm\.save_userpref|bpy\.ops\.preferences\./, "Blender の設定・アドオンを変える"],
  [/addon_install|addon_enable|addon_remove|addon_disable/, "アドオンを入れる・有効にする"],
  [/bpy\.ops\.script\.|bpy\.ops\.text\.run_script|\.as_module\s*\(|\buse_module\b/, "別のスクリプトを動かす"],
  [/bpy\.utils\.(?:register|unregister)_|bpy\.utils\.execfile/, "bpy.utils で登録・読み込みをする"],
  [/bpy\.app\.(?:handlers|timers)/, "後で勝手に動くコード (handlers / timers) を仕込む"],
  [/use_scripts_auto_execute|preferences\.filepaths/, "スクリプトの自動実行・ファイルの置き場の設定を変える"],
  [
    /bpy\.ops\.wm\.(?:open_mainfile|read_homefile|read_factory_settings|recover_\w+|url_open)/,
    "開いている場面を入れ替える・外部を開く",
  ],
  [/bpy\.ops\.file\./, "bpy.ops.file (パック・アンパック等でファイルを書く)"],
];

/** 書き出し先を確かめる操作。 filepath (または最初の引数) が作業フォルダの中の絶対パスであること */
const WRITE_CALL_RE =
  /bpy\.ops\.wm\.save_\w*\s*\(|bpy\.ops\.export_\w+\.\w+\s*\(|bpy\.ops\.wm\.\w+_export\s*\(|bpy\.ops\.image\.save\w*\s*\(|bpy\.data\.libraries\.write\s*\(|\.save_render\s*\(|\.save\s*\(|(?<![\w.])render_views\s*\(|(?<![\w.])export\s*\(|\bos\.makedirs\s*\(|\bos\.mkdir\s*\(/g;

/** 書き出し先をコードの外から決める物 (Blender のファイルの場所・ホーム・一時フォルダ・Blender の cwd) */
const DYNAMIC_PATH_RE =
  /os\.path\.expanduser|os\.getcwd|os\.path\.abspath|bpy\.data\.filepath|bpy\.path\.abspath|__file__|tempfile|bpy\.app\.tempdir|bpy\.utils\.(?:user_resource|script_path)/;

const PATHLIB_WRITE_RE =
  /\.(?:write_text|write_bytes|unlink|rmdir|rename|replace|touch|symlink_to|hardlink_to|chmod|open)\s*\(/;

interface StringLiteral {
  start: number;
  end: number;
  /** 引用符の中の文字 (raw でなければ \\ を \ に戻す。 f 文字列は最初の { の手前まで) */
  value: string;
}

/** コメントを空白に置き換え、 文字列の位置と中身を集める (三重引用符・接頭辞 r/b/f/u に対応) */
export function scanPython(code: string): { stripped: string; strings: StringLiteral[] } {
  const out = code.split("");
  const strings: StringLiteral[] = [];
  let i = 0;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "#") {
      while (i < code.length && code[i] !== "\n") {
        out[i] = " ";
        i++;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      let p = i - 1;
      let prefix = "";
      while (p >= 0 && /[rRbBuUfF]/.test(code[p]) && i - p <= 2) {
        prefix = code[p] + prefix;
        p--;
      }
      if (p >= 0 && /\w/.test(code[p])) prefix = ""; // 名前の末尾 (例: x"…" はない) の誤検出よけ
      const raw = /[rR]/.test(prefix);
      const fstr = /[fF]/.test(prefix);
      const triple = code.startsWith(ch.repeat(3), i);
      const quote = triple ? ch.repeat(3) : ch;
      const bodyStart = i + quote.length;
      let j = bodyStart;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code.startsWith(quote, j)) break;
        if (!triple && code[j] === "\n") break;
        j++;
      }
      let value = code.slice(bodyStart, Math.min(j, code.length));
      if (!raw) value = value.replace(/\\\\/g, "\\");
      if (fstr) {
        const brace = value.indexOf("{");
        if (brace >= 0) value = value.slice(0, brace);
      }
      const end = Math.min(j + quote.length, code.length);
      strings.push({ start: i, end, value });
      i = end;
      continue;
    }
    i++;
  }
  return { stripped: out.join(""), strings };
}

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 絶対パスに見える文字列か (Windows のドライブ・UNC・POSIX・~)。 "//" は Blender のファイルからの相対 */
function looksAbsolutePath(value: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^\\\\[^\\]/.test(value)) return true;
  if (value.startsWith("//")) return false;
  if (/^\/[A-Za-z0-9_.-]/.test(value)) return true;
  if (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) return true;
  return false;
}

export function isInsideDir(target: string, dir: string): boolean {
  const resolved = path.resolve(expandHome(target));
  const base = path.resolve(dir);
  const rel = path.relative(base, resolved);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** 呼び出しの ( の位置から、 対応する ) までの中身を返す (文字列の中の括弧は数えない) */
function callArgsAt(code: string, openParen: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openParen; i < code.length; i++) {
    const c = code[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return code.slice(openParen + 1, i);
    }
  }
  return code.slice(openParen + 1);
}

/** 引数の並びを一番外側のカンマで分ける */
function splitArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (quote) {
      cur += c;
      if (c === "\\" && i + 1 < args.length) {
        cur += args[++i];
      } else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if ("([{".includes(c)) depth++;
    if (")]}".includes(c)) depth--;
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** 1 つの引数の式が文字列リテラルだけならその中身 (f 文字列は { の手前まで)。 そうでなければ null */
function literalValue(expr: string): string | null {
  const m = /^([rRbBuUfF]{0,2})("""|'''|"|')([\s\S]*)\2$/.exec(expr.trim());
  if (!m) return null;
  // "a" + "b" のような連結は 1 つのリテラルではない
  if (m[3].replace(/\\./g, "").includes(m[2])) return null;
  let value = m[3];
  if (!/[rR]/.test(m[1])) value = value.replace(/\\\\/g, "\\");
  if (/[fF]/.test(m[1])) {
    const brace = value.indexOf("{");
    if (brace >= 0) value = value.slice(0, brace);
  }
  return value;
}

/** 部品箱 (bkit.py) をスキルの置き場から読み込む決まった形。 これだけは exec/open を許す */
const TRUSTED_EXEC_RE =
  /exec\s*\(\s*open\s*\(\s*([rR]?)("|')([^"'\n]+)\2\s*(?:,\s*encoding\s*=\s*("|')[\w-]+\4\s*)?\)\s*\.read\s*\(\s*\)\s*(?:,\s*globals\s*\(\s*\)\s*)?\)/g;

export function inspectBlenderCode(code: unknown, ctx: InspectorContext): InspectorResult {
  if (typeof code !== "string") return { decision: "ask", reason: "code が文字列ではない" };
  const skillsDir = ctx.skillsDir ?? path.join(os.homedir(), ".localllm", "skills");
  const reasons: string[] = [];
  const add = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r);
  };

  // 1. コメントを除き、 部品箱の読み込みの形 (スキルの置き場の .py) だけ取り除く
  let { stripped } = scanPython(code);
  stripped = stripped.replace(TRUSTED_EXEC_RE, (whole, rawFlag: string, _q: string, file: string) => {
    const value = rawFlag ? file : file.replace(/\\\\/g, "\\");
    if (/\.py$/i.test(value) && looksAbsolutePath(value) && isInsideDir(value, skillsDir)) return "None";
    return whole;
  });
  const { strings } = scanPython(stripped);

  // 2. import
  const importRe = /^[ \t]*(?:from[ \t]+([\w.]+)[ \t]+import[ \t]+([^\n]+)|import[ \t]+([^\n]+))/gm;
  for (const m of stripped.matchAll(importRe)) {
    if (m[1]) {
      const top = m[1].split(".")[0];
      if (!ALLOWED_MODULES.has(top)) add(`許していないモジュールを読み込む (${m[1]})`);
      const names = m[2]
        .replace(/[()\\]/g, "")
        .split(",")
        .map((n) => n.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (top === "os" && m[1] === "os" && names.some((n) => n === "*" || !OS_ATTRS.has(n)))
        add(`os から許していない名前を読み込む (${m[2].trim()})`);
      if (top === "sys" && names.some((n) => n === "*" || !SYS_ATTRS.has(n)))
        add(`sys から許していない名前を読み込む (${m[2].trim()})`);
    } else if (m[3]) {
      for (const item of m[3].split(";")[0].split(",")) {
        const parts = item.trim().split(/\s+/);
        const mod = parts[0];
        if (!mod) continue;
        const top = mod.split(".")[0];
        if (!ALLOWED_MODULES.has(top)) add(`許していないモジュールを読み込む (${mod})`);
        if ((top === "os" || top === "sys" || top === "pathlib") && parts[1] === "as")
          add(`${top} を別名で読み込む (属性の検査をすり抜けるため)`);
      }
    }
  }

  // 3. 書き方だけで確認に回す物
  for (const [re, why] of FORBIDDEN_PATTERNS) {
    if (re.test(stripped)) add(why);
  }
  for (const m of stripped.matchAll(/(?<![\w.])os\.(\w+)/g)) {
    if (!OS_ATTRS.has(m[1])) add(`os.${m[1]} を使う`);
  }
  for (const m of stripped.matchAll(/(?<![\w.])sys\.(\w+)/g)) {
    if (!SYS_ATTRS.has(m[1])) add(`sys.${m[1]} を使う`);
  }
  if (/\bpathlib\b/.test(stripped) && PATHLIB_WRITE_RE.test(stripped)) add("pathlib でファイルを書く・消す");

  // 4. パス: コードに書かれた絶対パスはすべて作業フォルダの中であること
  const insideLiterals: string[] = [];
  for (const s of strings) {
    if (!looksAbsolutePath(s.value)) continue;
    if (isInsideDir(s.value, ctx.cwd)) insideLiterals.push(s.value);
    else add(`作業フォルダの外のパス (${s.value})`);
  }
  const hasDynamicPath = DYNAMIC_PATH_RE.test(stripped) || strings.some((s) => s.value.startsWith("//"));

  /** 書き出し先の式を確かめる。 null = 問題なし */
  const checkTarget = (expr: string | undefined, what: string): string | null => {
    if (expr === undefined) return `${what} の書き出し先が無い (開いているファイルを上書きする)`;
    const lit = literalValue(expr);
    if (lit !== null) {
      if (!looksAbsolutePath(lit)) return `${what} の書き出し先が絶対パスでない (${lit || "空"})`;
      return null; // 中か外かは 4. で見た
    }
    if (hasDynamicPath)
      return `${what} の書き出し先をコードの外の場所 (ホーム・Blender のファイルの場所など) から作っている`;
    if (insideLiterals.length === 0)
      return `${what} の書き出し先を確かめられない (作業フォルダの絶対パスが書かれていない)`;
    return null; // 作業フォルダの中のパスから組み立てたとみなす
  };

  // 5. open(): 読み書きとも、 作業フォルダの中の絶対パスの文字列だけ
  for (const m of stripped.matchAll(/(?<![\w.])open\s*\(/g)) {
    const args = splitArgs(callArgsAt(stripped, (m.index ?? 0) + m[0].length - 1));
    const target = args.find((a) => /^file\s*=/.test(a))?.replace(/^file\s*=\s*/, "") ?? args[0];
    const modeExpr = args.find((a) => /^mode\s*=/.test(a))?.replace(/^mode\s*=\s*/, "") ?? args[1];
    const mode = modeExpr !== undefined && !/=/.test(modeExpr) ? (literalValue(modeExpr) ?? "?") : "r";
    const writing = /[wax+?]/.test(mode);
    const lit = target !== undefined ? literalValue(target) : null;
    if (lit === null || !looksAbsolutePath(lit)) {
      add(`open() の相手を確かめられない${writing ? " (書き込み)" : ""}`);
    } else if (writing && !isInsideDir(lit, ctx.cwd)) {
      add(`open() で作業フォルダの外に書く (${lit})`);
    }
  }

  // 6. 書き出す操作の行き先
  for (const m of stripped.matchAll(WRITE_CALL_RE)) {
    const name = m[0].replace(/\s*\($/, "");
    const args = splitArgs(callArgsAt(stripped, (m.index ?? 0) + m[0].length - 1));
    const named = args.find((a) => /^(?:filepath|out_dir|path|name)\s*=/.test(a));
    let target: string | undefined = named?.replace(/^\w+\s*=\s*/, "");
    if (target === undefined) {
      const positional = args.filter((a) => !/^\w+\s*=/.test(a));
      if (/render_views$|(?<![\w.])export$/.test(name)) {
        // bkit: render_views(out_dir, ...) / export(ob_name, out_dir)
        target = /export$/.test(name) ? positional[1] : positional[0];
      } else if (!/bpy\.ops\./.test(name)) {
        target = positional[0];
      }
    }
    const problem = checkTarget(target, name);
    if (problem) add(problem);
  }
  // render の書き出し (write_still / animation) は filepath を同じコードで決めていること
  if (/bpy\.ops\.render\.render\s*\([^)]*(?:write_still|animation)\s*=\s*True/.test(stripped)) {
    if (!/\.filepath\s*=(?!=)/.test(stripped)) add("render の書き出し先 (render.filepath) をこのコードで決めていない");
  }
  for (const m of stripped.matchAll(/\.filepath(?:_raw)?\s*=(?!=)\s*([^\n;]+)/g)) {
    const problem = checkTarget(m[1].trim(), "filepath への代入");
    if (problem) add(problem);
  }

  if (reasons.length === 0) return { decision: "allow" };
  const shown = reasons.slice(0, 3).join("・");
  return { decision: "ask", reason: reasons.length > 3 ? `${shown} ほか ${reasons.length - 3} 件` : shown };
}
