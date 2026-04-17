import * as logger from "../utils/logger.js";
let playwrightModule = null;
async function getPlaywright() {
    if (!playwrightModule) {
        playwrightModule = await import("playwright");
    }
    return playwrightModule;
}
export class PlaywrightManager {
    browser = null;
    context = null;
    page = null;
    async ensureBrowser() {
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
    async getPage() {
        return this.page;
    }
    async navigate(url) {
        const page = await this.ensureBrowser();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        return page.url();
    }
    async snapshot() {
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
    `);
        if (!snapshot) {
            return "No accessibility tree available.";
        }
        return formatAccessibilityTree(snapshot);
    }
    async click(selector) {
        const page = await this.ensureBrowser();
        await page.click(selector, { timeout: 10000 });
    }
    async type(selector, text) {
        const page = await this.ensureBrowser();
        await page.fill(selector, text, { timeout: 10000 });
    }
    async screenshot() {
        const page = await this.ensureBrowser();
        return await page.screenshot({ type: "png" });
    }
    async evaluate(expression) {
        const page = await this.ensureBrowser();
        return await page.evaluate(expression);
    }
    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
        }
    }
}
function formatAccessibilityTree(node, indent = 0) {
    const prefix = "  ".repeat(indent);
    let line = `${prefix}[${node.role}]`;
    if (node.name)
        line += ` "${node.name}"`;
    if (node.value)
        line += ` value="${node.value}"`;
    line += "\n";
    if (node.children) {
        for (const child of node.children) {
            line += formatAccessibilityTree(child, indent + 1);
        }
    }
    return line;
}
//# sourceMappingURL=playwright-manager.js.map