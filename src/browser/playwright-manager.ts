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
    this.browser = await pw.chromium.launch({ headless: false });
    this.context = await this.browser.newContext();
    this.page = await this.context.newPage();
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

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }
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
