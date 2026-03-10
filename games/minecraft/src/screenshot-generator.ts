import { chromium, Browser, Page } from 'playwright';
import * as path from 'node:path';
import * as fs from 'node:fs';

interface Options {
  start: number;
  end: number;
  parallel?: boolean;
  retries?: number;
  delay?: number;
  saveDir?: string;
}

interface Result {
  seed: number;
  success: boolean;
  filePath?: string;
  error?: string;
  attempts: number;
}

export class ScreenshotGenerator {
  private options: Options;
  private browser: Browser | null = null;
  private results: Result[] = [];

  constructor(options: Options) {
    this.options = {
      start: options.start,
      end: options.end,
      parallel: options.parallel ?? false,
      retries: options.retries ?? 3,
      delay: options.delay ?? 500,
      saveDir: options.saveDir ?? 'screenshots'
    };

    if (this.options.start > this.options.end) {
      throw new Error('start seed must be less than or equal to end seed');
    }
  }

  private generateTimestamp(): string {
    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const min = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
  }

  private ensureDirectory(dir: string): void {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private async captureScreenshot(seed: number): Promise<Result> {
    const result: Result = {
      seed,
      success: false,
      attempts: 0
    };

    const url = `https://www.chunkbase.com/apps/seed-map#seed=${seed}&platform=bedrock_26_0&dimension=overworld&x=38&z=109&zoom=0.1`;
    const timestamp = this.generateTimestamp();
    const filename = `minecraft-${seed}-bedrock-${timestamp}.png`;
    const outPath = path.join(this.options.saveDir, filename);

    for (let attempt = 1; attempt <= this.options.retries; attempt++) {
      result.attempts = attempt;

      try {
        const page = await this.browser!.newPage();

        await page.setViewportSize({ width: 1380, height: 1080 });
        await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

        await page.waitForTimeout(3000);
        await page.evaluate(() => window.scrollBy(50, 600));
        await page.waitForTimeout(2000);

        const locator = page.locator('#map-canvas');
        await locator.waitFor({ state: 'visible', timeout: 15000 });
        await locator.screenshot({ path: outPath });

        await page.close();

        result.success = true;
        result.filePath = outPath;
        return result;

      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.log(`[Attempt ${attempt}/${this.options.retries}] Seed ${seed}: ${errorMsg}`);

        if (attempt < this.options.retries) {
          await new Promise(resolve => setTimeout(resolve, this.options.delay));
        }
      }
    }

    result.error = `Failed after ${this.options.retries} attempts`;
    return result;
  }

  async run(): Promise<void> {
    console.log(`\n[INFO] Starting screenshot generation...`);
    console.log(`[INFO] Seed range: ${this.options.start} - ${this.options.end}`);
    console.log(`[INFO] Parallel mode: ${this.options.parallel ? 'ON' : 'OFF'}`);
    console.log(`[INFO] Max retries: ${this.options.retries}`);
    console.log(`[INFO] Save directory: ${this.options.saveDir}\n`);

    this.ensureDirectory(this.options.saveDir);

    this.browser = await chromium.launch({ headless: true });

    try {
      const seeds = Array.from(
        { length: this.options.end - this.options.start + 1 },
        (_, i) => this.options.start + i
      );

      if (this.options.parallel) {
        await this.runParallel(seeds);
      } else {
        await this.runSequential(seeds);
      }

    } finally {
      await this.browser.close();
    }

    this.printSummary();
  }

  private async runSequential(seeds: number[]): Promise<void> {
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i];
      const progress = `${i + 1}/${seeds.length}`;

      console.log(`[${progress}] Capturing seed ${seed}...`);
      const result = await this.captureScreenshot(seed);
      this.results.push(result);

      if (result.success) {
        console.log(`  ✓ Saved: ${result.filePath}`);
      } else {
        console.log(`  ✗ Failed: ${result.error}`);
      }
      console.log('');
    }
  }

  private async runParallel(seeds: number[]): Promise<void> {
    const batchSize = 5;

    for (let i = 0; i < seeds.length; i += batchSize) {
      const batch = seeds.slice(i, i + batchSize);
      const promises = batch.map(seed => this.captureScreenshot(seed));
      const batchResults = await Promise.all(promises);

      this.results.push(...batchResults);

      batchResults.forEach((result, idx) => {
        const seed = batch[idx];
        const progress = `${i + idx + 1}/${seeds.length}`;

        if (result.success) {
          console.log(`[${progress}] ✓ Seed ${seed}: ${result.filePath}`);
        } else {
          console.log(`[${progress}] ✗ Seed ${seed}: ${result.error}`);
        }
      });
      console.log('');
    }
  }

  private printSummary(): void {
    const total = this.results.length;
    const success = this.results.filter(r => r.success).length;
    const failed = this.results.filter(r => !r.success).length;

    console.log('\n' + '='.repeat(50));
    console.log('SCREENSHOT GENERATION COMPLETE');
    console.log('='.repeat(50));
    console.log(`Total attempts:   ${total}`);
    console.log(`Successful:       ${success}`);
    console.log(`Failed:           ${failed}`);
    console.log(`Success rate:     ${((success / total) * 100).toFixed(1)}%`);
    console.log('='.repeat(50) + '\n');

    if (failed > 0) {
      console.log('Failed seeds:');
      this.results.filter(r => !r.success).forEach(r => {
        console.log(`  - Seed ${r.seed}: ${r.error}`);
      });
      console.log('');
    }
  }
}
