import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatLogConfig } from "../config/types.js";

/**
 * チャットログをObsidian Vaultに保存するロガー。
 * - セッションごとに1ファイル（日時ベースのファイル名）
 * - コンテキスト圧縮が発生するとパート番号を繰り上げて新ファイルに切替
 * - 圧縮前のファイルには圧縮サマリーを末尾に追記
 */
export class ChatLogger {
  private config: ChatLogConfig;
  private sessionDir: string;
  private sessionTimestamp: string;
  private partNumber: number = 1;
  private currentFilePath: string;
  private messageCount: number = 0;

  constructor(config: ChatLogConfig) {
    this.config = config;
    this.sessionTimestamp = ChatLogger.formatTimestamp(new Date());

    // 保存先: <vaultPath>/ChatLogs/YYYY-MM/
    const now = new Date();
    const monthDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    this.sessionDir = path.join(config.vaultPath, "ChatLogs", monthDir);

    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }

    this.currentFilePath = this.buildFilePath();
    this.writeHeader();
  }

  /** 日時文字列: YYYYMMDD-HHmmss */
  private static formatTimestamp(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  private buildFilePath(): string {
    const suffix = this.partNumber > 1 ? `_part${this.partNumber}` : "";
    return path.join(this.sessionDir, `${this.sessionTimestamp}${suffix}.md`);
  }

  private writeHeader(): void {
    const now = new Date();
    const lines = [
      "---",
      `title: "Chat Log ${this.sessionTimestamp}"`,
      `date: ${now.toISOString()}`,
      `part: ${this.partNumber}`,
      "tags:",
      "  - chatlog",
      "  - lllmagents",
      "---",
      "",
      `# Chat Log — ${now.toLocaleDateString("ja-JP")} ${now.toLocaleTimeString("ja-JP")}` +
        (this.partNumber > 1 ? ` (Part ${this.partNumber})` : ""),
      "",
    ];
    fs.writeFileSync(this.currentFilePath, lines.join("\n"), "utf-8");
  }

  /** ユーザーメッセージを記録 */
  logUser(message: string): void {
    if (!this.config.enabled) return;
    this.messageCount++;
    const timestamp = new Date().toLocaleTimeString("ja-JP");
    const entry = `## 👤 User (${timestamp})\n\n${message}\n\n`;
    fs.appendFileSync(this.currentFilePath, entry, "utf-8");
  }

  /** AI応答を記録 */
  logAssistant(message: string, toolSummary?: string): void {
    if (!this.config.enabled) return;
    this.messageCount++;
    const timestamp = new Date().toLocaleTimeString("ja-JP");
    let entry = `## 🤖 Assistant (${timestamp})\n\n`;
    if (toolSummary) {
      entry += `> **Tools:** ${toolSummary}\n\n`;
    }
    entry += `${message}\n\n`;
    fs.appendFileSync(this.currentFilePath, entry, "utf-8");
  }

  /** ツール実行を記録（簡易サマリー） */
  logToolExecution(toolName: string, success: boolean): void {
    if (!this.config.enabled) return;
    const icon = success ? "✅" : "❌";
    const entry = `> ${icon} \`${toolName}\`\n\n`;
    fs.appendFileSync(this.currentFilePath, entry, "utf-8");
  }

  /**
   * コンテキスト圧縮が発生した際に呼ぶ。
   * 現在のファイルに圧縮マーカーを追記し、新しいパートファイルに切り替える。
   */
  onCompressed(compressionSummary?: string): void {
    if (!this.config.enabled) return;

    // 現ファイルに圧縮完了マーカーを書く
    const marker = [
      "---",
      "",
      `> **📦 コンテキスト圧縮 (${new Date().toLocaleTimeString("ja-JP")})**`,
      `> ここまでの ${this.messageCount} メッセージが圧縮されました。`,
      `> 続きは Part ${this.partNumber + 1} へ。`,
      "",
    ];
    if (compressionSummary) {
      marker.push("### 圧縮サマリー", "", compressionSummary, "");
    }
    fs.appendFileSync(this.currentFilePath, marker.join("\n"), "utf-8");

    // 新パートに切り替え
    this.partNumber++;
    this.currentFilePath = this.buildFilePath();
    this.messageCount = 0;
    this.writeHeader();

    // 新パートに圧縮サマリーの要約を入れる
    if (compressionSummary) {
      const intro = ["> **前パートからの引き継ぎ:** コンテキスト圧縮後の続き", "", "---", ""];
      fs.appendFileSync(this.currentFilePath, intro.join("\n"), "utf-8");
    }
  }

  /** 有効/無効を切り替え */
  setEnabled(enabled: boolean): void {
    this.config.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  getConfig(): ChatLogConfig {
    return { ...this.config };
  }

  getCurrentFilePath(): string {
    return this.currentFilePath;
  }

  getPartNumber(): number {
    return this.partNumber;
  }
}
