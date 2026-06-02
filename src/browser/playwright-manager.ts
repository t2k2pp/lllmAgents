import type { Browser, BrowserContext, Page } from "playwright";
import * as logger from "../utils/logger.js";

let playwrightModule: typeof import("playwright") | null = null;

async function getPlaywright() {
  if (!playwrightModule) {
    playwrightModule = await import("playwright");
  }
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
    const onConsole = (msg: { type(): string; text(): string }) => {
      if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
    };
    const onPageError = (err: Error) => {
      pageErrors.push(String(err.stack || err.message || err).slice(0, 300));
    };
    // ロード前にリスナ登録しないと初期化時の例外を取りこぼす
    page.on("console", onConsole as never);
    page.on("pageerror", onPageError as never);

    const reasons: string[] = [];
    let blankCanvas: boolean | null = null;
    let changedAfterInput = false;

    try {
      await page.goto(url, { waitUntil: "load", timeout: 30000 });
      const settle = opts?.settleMs ?? 1500;
      await page.waitForTimeout(settle);

      const shot1 = await page.screenshot({ type: "png" });
      blankCanvas = await this.detectBlankCanvas(page);

      // 合成入力: Start 系 (Enter/Space/中央クリック) → 移動系 (矢印/WASD)。
      // ゲームの中身を知らないので、 ありがちな開始・操作キーを順に試す。
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
      await this.pressKeys(page, ["ArrowUp", "ArrowLeft", "KeyW", "KeyA", "KeyD"]);
      await page.waitForTimeout(900);

      const shot2 = await page.screenshot({ type: "png" });
      changedAfterInput = !shot1.equals(shot2);
    } catch (e) {
      pageErrors.push(`smoke navigation failed: ${String(e).slice(0, 300)}`);
    } finally {
      page.off("console", onConsole as never);
      page.off("pageerror", onPageError as never);
    }

    if (pageErrors.length > 0) reasons.push(`未捕捉例外 ${pageErrors.length} 件`);
    if (consoleErrors.length > 0) reasons.push(`console error ${consoleErrors.length} 件`);
    if (blankCanvas === true) reasons.push("canvas が空 (真っ黒/単色)");
    if (!changedAfterInput) reasons.push("入力後に画面が変化しない (フリーズ疑い)");

    const verdict: "pass" | "fail" = reasons.length === 0 ? "pass" : "fail";
    return { url, consoleErrors, pageErrors, blankCanvas, changedAfterInput, verdict, reasons };
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
  /** 合成入力の前後でスクショに変化があったか (false=フリーズ疑い) */
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
