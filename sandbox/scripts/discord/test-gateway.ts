/**
 * Discord Gateway 接続の動作確認スクリプト
 * 実行: npx tsx sandbox/scripts/discord/test-gateway.ts
 * ~/.localllm/config.json の botToken で Gateway に接続し、READY 受信 → 10 秒待機
 * (heartbeat 1 回分の動作余地) → 切断する。
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DiscordGatewayClient } from "../../../src/discord/gateway-client.js";

const configPath = path.join(os.homedir(), ".localllm", "config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
const botToken: string | undefined = config.discord?.botToken;

if (!botToken) {
  console.error("botToken が未設定です");
  process.exit(1);
}

const client = new DiscordGatewayClient({
  botToken,
  onInteraction: (i) => console.log("INTERACTION:", i.type, i.data?.name),
  onStatus: (m) => console.log("STATUS:", m),
});

const t0 = Date.now();
try {
  await client.start();
  console.log(`✅ READY 受信 (${Date.now() - t0}ms) Bot: ${client.botUser} / running=${client.running}`);
} catch (e) {
  console.error("❌ 接続失敗:", e instanceof Error ? e.message : e);
  process.exit(1);
}

await new Promise((r) => setTimeout(r, 10_000));
console.log(`10 秒経過後も running=${client.running}`);
client.stop();
console.log(`stop() 後 running=${client.running}`);
process.exit(0);
