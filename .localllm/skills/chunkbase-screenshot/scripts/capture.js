// capture.js
import { chromium } from "playwright";
import * as path from "node:path";
import * as fs from "node:fs";

async function main() {
  const seed = process.argv[2];
  if (!seed) {
    console.error("エラー: シード値が指定されていません。");
    console.error("使用方法: node capture.js <seed>");
    process.exit(1);
  }

  // 日時文字列の生成
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  const timestamp = `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
  
  // 保存先の確保
  const outDir = path.join(process.cwd(), "screenshots");
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }
  
  const filename = `minecraft-${seed}-bedrock-${timestamp}.png`;
  const outPath = path.join(outDir, filename);

  // ターゲットURLの生成
  const url = `https://www.chunkbase.com/apps/seed-map#seed=${seed}&platform=bedrock_26_0&dimension=overworld&x=38&z=109&zoom=0.1`;

  console.log(`[情報] Chunkbaseへアクセス中...`);
  console.log(`[情報] URL: ${url}`);
  
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1080 }
  });
  const page = await context.newPage();

  try {
    // タイムアウトを長めに設定
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });

    // 広告やオーバーレイなどを考慮して少し待機
    await page.waitForTimeout(3000);

    // キャンバスが見えるように1スクリーン分（ここでは600px程度）スクロール
    await page.evaluate(() => {
      window.scrollBy(0, 600);
    });

    // スクロール描画を待つ
    await page.waitForTimeout(2000);
    
    // サブフレームではなくトップレベルの要素を探す
    const locator = page.locator('#map-canvas');
    await locator.waitFor({ state: 'visible', timeout: 15000 });
    
    // キャプチャの実行
    await locator.screenshot({ path: outPath });

    console.log(`[成功] 画像を保存しました: ${outPath}`);
  } catch (error) {
    console.error(`[エラー] 画像の取得に失敗しました: ${error.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
