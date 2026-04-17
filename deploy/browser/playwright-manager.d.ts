import type { Page } from "playwright";
export declare class PlaywrightManager {
    private browser;
    private context;
    private page;
    ensureBrowser(): Promise<Page>;
    getPage(): Promise<Page | null>;
    navigate(url: string): Promise<string>;
    snapshot(): Promise<string>;
    click(selector: string): Promise<void>;
    type(selector: string, text: string): Promise<void>;
    screenshot(): Promise<Buffer>;
    evaluate(expression: string): Promise<unknown>;
    close(): Promise<void>;
}
//# sourceMappingURL=playwright-manager.d.ts.map