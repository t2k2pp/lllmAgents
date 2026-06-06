import type { Browser, BrowserContext, Page } from "playwright";
import { createRequire } from "node:module";
import * as path from "node:path";
import * as os from "node:os";
import * as logger from "../utils/logger.js";

/**
 * exe(SEA) では playwright を同梱しない（リーン配布）。未導入時にこのエラーを投げ、
 * 呼び出し側（game_smoke / browser_*）が ToolResult.error としてそのまま誘導文を返す。
 * docs/exe-playwright-externalization.md §3.4
 */
export class PlaywrightNotInstalledError extends Error {
  constructor() {
    super(
      "ブラウザ機能には Playwright のセットアップが必要です。" +
        "`localllm --install-browser` を実行してください" +
        "（状態確認は `localllm --check-browser`）。" +
        "※ exe 版は playwright を同梱していません（リーン配布）。",
    );
    this.name = "PlaywrightNotInstalledError";
  }
}

/**
 * playwright を解決する純粋ロジック（テスト可能）。
 * 1. 通常の import を試す（dev/tsx ＝ リポジトリ node_modules から解決。require.resolve も健全）。
 * 2. 失敗時（exe/SEA・ラッパは playwright を同梱しないため import が失敗する）、
 *    ディスク上の非バンドル playwright を createRequire で読む。解決順:
 *    ~/.localllm/node_modules → 作業フォルダ node_modules。
 * 3. いずれも無ければ null（呼び出し側で PlaywrightNotInstalledError 化）。
 *
 * import を先に試すことで SEA 判定に依存せず、実SEA・シェルラッパ・dev の全形態を統一的に扱う。
 * docs/exe-playwright-externalization.md §3.2
 */
export async function resolvePlaywright(
  importFn: () => Promise<typeof import("playwright")> = () => import("playwright"),
  roots: string[] = [path.join(os.homedir(), ".localllm"), process.cwd()],
  makeRequire: (from: string) => (id: string) => unknown = (from) => createRequire(from),
): Promise<typeof import("playwright") | null> {
  try {
    const mod = await importFn();
    if (mod && mod.chromium) return mod;
  } catch {
    /* バンドル/SEA では同梱していないので失敗する → ディスクから探す */
  }

  for (const root of roots) {
    try {
      const req = makeRequire(path.join(root, "noop.js"));
      const mod = req("playwright") as typeof import("playwright");
      if (mod && mod.chromium) {
        logger.info(`Loaded playwright from ${root}/node_modules`);
        return mod;
      }
    } catch {
      /* 次の root を試す */
    }
  }
  return null;
}

let playwrightModule: typeof import("playwright") | null = null;

async function getPlaywright(): Promise<typeof import("playwright")> {
  if (playwrightModule) return playwrightModule;
  const mod = await resolvePlaywright();
  if (!mod) throw new PlaywrightNotInstalledError();
  playwrightModule = mod;
  return playwrightModule;
}

export class PlaywrightManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  async ensureBrowser(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    const pw = await getPlaywright();
    logger.info("Launching browser...");
    this.browser = await pw.chromium.launch({ headless: true, timeout: 30000 });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(30000);
    return this.page;
  }

  async getPage(): Promise<Page | null> {
    return this.page;
  }

  async navigate(url: string): Promise<string> {
    const page = await this.ensureBrowser();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    return page.url();
  }

  async snapshot(): Promise<string> {
    const page = await this.ensureBrowser();
    // page.evaluate runs in browser context; pass code as a string to avoid TS dom-lib issues
    const snapshot = await page.evaluate(`
      (function() {
        function buildTree(el, depth) {
          if (depth > 10) return null;
          var role = el.getAttribute("role") || el.tagName.toLowerCase();
          var name = el.getAttribute("aria-label") || (el.innerText || "").slice(0, 100);
          var children = [];
          for (var i = 0; i < el.children.length; i++) {
            var node = buildTree(el.children[i], depth + 1);
            if (node) children.push(node);
          }
          return { role: role, name: name.trim(), children: children.length > 0 ? children : undefined };
        }
        return buildTree(document.body, 0);
      })()
    `) as AccessibilityNode | null;
    if (!snapshot) {
      return "No accessibility tree available.";
    }
    return formatAccessibilityTree(snapshot);
  }

  async click(selector: string): Promise<void> {
    const page = await this.ensureBrowser();
    await page.click(selector, { timeout: 10000 });
  }

  async type(selector: string, text: string): Promise<void> {
    const page = await this.ensureBrowser();
    await page.fill(selector, text, { timeout: 10000 });
  }

  async screenshot(): Promise<Buffer> {
    const page = await this.ensureBrowser();
    return await page.screenshot({ type: "png" });
  }

  async evaluate(expression: string): Promise<unknown> {
    const page = await this.ensureBrowser();
    return await page.evaluate(expression);
  }

  /**
   * ランタイムスモーク (docs/checkpoint-and-smoke-design.md §5)。
   * ブラウザ成果物 (ゲーム等) を headless で起動し、 「破滅的・機械的失敗」 だけを検知する。
   * ゲーム性・操作感・バランスは判定しない (= 人間の領域)。
   *
   * 検知対象: 未捕捉例外 / console error / 真っ黒・空 canvas / 入力後にフリーズ。
   */
  async runSmoke(url: string, opts?: { settleMs?: number }): Promise<SmokeResult> {
    const page = await this.ensureBrowser();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    // favicon/CORS/CDN 等のネットワーク系ノイズは FAIL 要因にしない (誤検知＝オオカミ少年化を防ぐ)。
    // 本当に致命なら未捕捉例外 (pageerror) や "X is not defined" として現れる。
    const NETWORK_NOISE =
      /net::ERR_|ERR_(CONNECTION|FILE_NOT_FOUND|NAME_NOT_RESOLVED)|Failed to load resource|favicon|blocked by CORS|Cross-Origin|status of (4\d\d|5\d\d)/i;
    const onConsole = (msg: { type(): string; text(): string }) => {
      if (msg.type() !== "error") return;
      const text = msg.text().slice(0, 300);
      if (NETWORK_NOISE.test(text)) return;
      consoleErrors.push(text);
    };
    const onPageError = (err: Error) => {
      pageErrors.push(String(err.stack || err.message || err).slice(0, 300));
    };
    // ロード前にリスナ登録しないと初期化時の例外を取りこぼす
    page.on("console", onConsole as never);
    page.on("pageerror", onPageError as never);

    const reasons: string[] = [];
    let blankCanvas: boolean | null = null;
    let idleAnimated = false; // 入力なしでも自走でアニメーションするか
    let respondedToInput = false; // 入力の前後/後で画面が変化したか

    try {
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      // CDN 等の読み込み待ち (best-effort)。 取りこぼしても settle で吸収
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      const settle = opts?.settleMs ?? 1500;
      await page.waitForTimeout(settle);

      // 入力前のベースライン: 自走アニメの有無を測る (これが無いとフリーズ判定が誤検知する)
      const b1 = await page.screenshot({ type: "png" });
      await page.waitForTimeout(500);
      const b2 = await page.screenshot({ type: "png" });
      idleAnimated = !b1.equals(b2);

      // 入力を canvas に確実に届ける: focus → Start 系 (Enter/Space/中央クリック) → 移動系
      await this.focusCanvas(page);
      await this.pressKeys(page, ["Enter", "Space"]);
      const vp = page.viewportSize();
      if (vp) {
        try {
          await page.mouse.click(Math.floor(vp.width / 2), Math.floor(vp.height / 2));
        } catch {
          /* クリック不可でも無視 */
        }
      }
      await page.waitForTimeout(300);
      await this.pressKeys(page, ["ArrowUp", "ArrowLeft", "KeyW", "KeyA", "KeyD", "Space"]);
      await page.waitForTimeout(700);

      const a1 = await page.screenshot({ type: "png" });
      await page.waitForTimeout(400);
      const a2 = await page.screenshot({ type: "png" });
      // 入力で画面が遷移したか (b2→a1)、 または入力後も動き続けているか (a1→a2)
      respondedToInput = !b2.equals(a1) || !a1.equals(a2);
      // blank は「最終状態」で測る (タイトル背景の単色を誤判定しないため)。 情報用 (単独では FAIL にしない)
      blankCanvas = await this.detectBlankCanvas(page);
    } catch (e) {
      pageErrors.push(`smoke navigation failed: ${String(e).slice(0, 300)}`);
    } finally {
      page.off("console", onConsole as never);
      page.off("pageerror", onPageError as never);
    }

    if (pageErrors.length > 0) reasons.push(`未捕捉例外 ${pageErrors.length} 件`);
    if (consoleErrors.length > 0) reasons.push(`console error ${consoleErrors.length} 件`);
    // 致命判定は「自走アニメも無く、 入力にも反応しない」 ときだけ (= 画面が死んでいる)。
    // 自走アニメがある場合は入力反応をピクセルで断定できないため FAIL にしない (誤検知回避)。
    // blankCanvas は左上サンプル/単色フレームで誤検知しやすいため単独 FAIL にせず情報のみ。
    if (!idleAnimated && !respondedToInput) {
      reasons.push("自走アニメも入力反応も画面変化が無い (フリーズ/未描画の疑い)");
    }

    const verdict: "pass" | "fail" = reasons.length === 0 ? "pass" : "fail";
    return {
      url,
      consoleErrors,
      pageErrors,
      blankCanvas,
      idleAnimated,
      respondedToInput,
      changedAfterInput: idleAnimated || respondedToInput,
      verdict,
      reasons,
    };
  }

  private async pressKeys(page: Page, keys: string[]): Promise<void> {
    for (const k of keys) {
      try {
        await page.keyboard.press(k);
        await page.waitForTimeout(120);
      } catch {
        /* 個別キー失敗は無視 (フォーカス無し等) */
      }
    }
  }

  /** 入力イベントが canvas / body に届くよう focus を当てる (tabindex 付与含む) */
  private async focusCanvas(page: Page): Promise<void> {
    try {
      await page.evaluate(`
        (function() {
          var c = document.querySelector('canvas');
          if (c) { try { c.setAttribute('tabindex', '0'); c.focus(); } catch (e) {} }
          try { if (document.body && document.body.focus) document.body.focus(); } catch (e) {}
        })()
      `);
    } catch {
      /* focus 不可でも無視 */
    }
  }

  /**
   * 2D canvas が単色 (= 何も描けていない) かを判定。
   * WebGL canvas は getContext('2d') が null になるため判定不能 → null を返し、
   * その場合はスクショ差分と console error で代替検知する。
   */
  private async detectBlankCanvas(page: Page): Promise<boolean | null> {
    try {
      return (await page.evaluate(`
        (function() {
          var c = document.querySelector('canvas');
          if (!c) return null;
          var ctx = null;
          try { ctx = c.getContext('2d'); } catch (e) { return null; }
          if (!ctx) return null; // WebGL 等は判定不能
          var w = c.width, h = c.height;
          if (!w || !h) return true;
          var sw = Math.min(w, 200), sh = Math.min(h, 200);
          var data = ctx.getImageData(0, 0, sw, sh).data;
          var r0 = data[0], g0 = data[1], b0 = data[2];
          for (var i = 0; i < data.length; i += 4) {
            if (data[i] !== r0 || data[i+1] !== g0 || data[i+2] !== b0) return false;
          }
          return true;
        })()
      `)) as boolean | null;
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
}

export interface SmokeResult {
  url: string;
  /** ロード〜操作中に拾った console.error の本文 (各 300 字まで) */
  consoleErrors: string[];
  /** 未捕捉例外 (pageerror) の stack/メッセージ */
  pageErrors: string[];
  /** 2D canvas が空ならtrue。 canvas 無し/WebGL 等で判定不能なら null */
  blankCanvas: boolean | null;
  /** 入力なしでも自走でアニメーションするか (true なら入力反応はピクセルで断定不能) */
  idleAnimated: boolean;
  /** 合成入力の前後/後で画面が変化したか */
  respondedToInput: boolean;
  /** idleAnimated || respondedToInput (後方互換用の総合フラグ) */
  changedAfterInput: boolean;
  verdict: "pass" | "fail";
  /** fail の理由 (日本語)。 pass なら空配列 */
  reasons: string[];
}

interface AccessibilityNode {
  role: string;
  name?: string;
  value?: string;
  children?: AccessibilityNode[];
}

function formatAccessibilityTree(node: AccessibilityNode, indent = 0): string {
  const prefix = "  ".repeat(indent);
  let line = `${prefix}[${node.role}]`;
  if (node.name) line += ` "${node.name}"`;
  if (node.value) line += ` value="${node.value}"`;
  line += "\n";

  if (node.children) {
    for (const child of node.children) {
      line += formatAccessibilityTree(child, indent + 1);
    }
  }
  return line;
}
