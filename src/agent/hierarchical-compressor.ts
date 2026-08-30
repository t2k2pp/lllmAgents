/**
 * Hierarchical Compressor — 階層的コンテキスト圧縮
 *
 * 3層のグラデーション:
 *   Layer 0: 生データ（直近メッセージ）
 *   Layer 1: ブロック単位の重み付き要約（ユーザー発言優先）
 *   Layer 2: キーワード+制約のみの圧縮要約
 */
import type { LLMProvider, Message } from "../providers/base-provider.js";
import { collectResponse } from "../providers/base-provider.js";
import { estimateTokens } from "./token-counter.js";
import * as logger from "../utils/logger.js";

export interface SummaryBlock {
  id: string;
  layer: 1 | 2;
  summary: string;
  keyFacts: string[];
  tokenCount: number;
  createdAt: number;
}

/** メッセージをブロック分割するサイズ */
const BLOCK_SIZE = 10;

/** Layer 1 ブロックがこの数を超えたら Layer 2 に統合 */
const MAX_LAYER1_BLOCKS = 5;

/**
 * Layer 1 圧縮 (個別メッセージブロックの要約) のサンプリング設定。
 *  temperature=0.3: 多少の表現揺れは許容、 但し決定論寄り。
 *  maxTokens=1000: 1 ブロックあたりの要約上限。 これ以上はノイズが増える傾向。
 */
const COMPRESSOR_LAYER1_TEMPERATURE = 0.3;
const COMPRESSOR_LAYER1_MAX_TOKENS = 1000;

/**
 * Layer 2 圧縮 (Layer 1 結果の統合要約) のサンプリング設定。
 *  maxTokens=1500: 統合要約は Layer 1 より長くてよい。 ただし context 圧迫しない上限。
 */
const COMPRESSOR_LAYER2_TEMPERATURE = 0.3;
const COMPRESSOR_LAYER2_MAX_TOKENS = 1500;

// ─── 要約プロンプト ───

const LAYER1_PROMPT = `以下の会話ブロックを要約してください。

## 優先度ルール（厳守）
1. **ユーザーの指示・制約**: 「〜して」「〜しないで」等の命令は原文のまま保持
2. **固有名詞・パス・コード**: ファイルパス、関数名、変数名、具体的な数値は省略しない
3. **未解決事項**: まだ完了していないタスク、保留中の判断は詳細に残す
4. **解決済み事項**: 結論のみ1行で（過程は不要）
5. **ユーザー発言は厚めに、AI応答は結論のみ**
6. **Goal Seek mode の goal/acceptance_criteria は別途保持されているため要約に含めなくてよい** (docs/goal-seek-mode-design.md §3.10)

## 出力形式
以下のJSON形式のみ返してください。他のテキストは不要です:
{"summary": "要約テキスト", "keyFacts": ["事実1", "事実2"]}

## 会話ブロック
`;

const LAYER2_PROMPT = `以下は過去の会話要約ブロック群です。これらを統合して、今後の作業に必要な最小限の情報に圧縮してください。

## 保持すべき情報
- ユーザーが設定した制約・ルール
- プロジェクトの重要な決定事項
- 未解決のタスクや問題
- 重要なファイルパスと変更内容

## 削除してよい情報
- 解決済みの議論の詳細
- AIの思考過程や説明
- 試行錯誤の経緯（最終結果のみ残す）
- Goal Seek mode の goal/acceptance_criteria (別保持されているため重複、 docs/goal-seek-mode-design.md §3.10)

## 出力形式
以下のJSON形式のみ返してください。他のテキストは不要です:
{"summary": "統合要約テキスト", "keyFacts": ["重要事実1", "重要事実2"]}

## 要約ブロック群
`;

function generateBlockId(): string {
  return `blk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function messagesToText(messages: Message[]): string {
  return messages
    .map((m) => {
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      // ユーザー発言を明示的にマーク（要約時の優先度付けのヒント）
      const roleLabel = m.role === "user" ? "[ユーザー]" : m.role === "assistant" ? "[AI]" : `[${m.role}]`;
      return `${roleLabel}: ${content}`;
    })
    .join("\n\n");
}

function parseSummaryResponse(raw: string): { summary: string; keyFacts: string[] } {
  // JSON抽出試行
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.summary !== "string" || !Array.isArray(parsed.keyFacts)) {
        throw new Error("summary/keyFacts shape mismatch");
      }
      return { summary: parsed.summary, keyFacts: parsed.keyFacts.filter((fact: unknown) => typeof fact === "string") };
    } catch (error) {
      throw new Error(`Context summarizer returned invalid JSON: ${String(error)}`, { cause: error });
    }
  }
  throw new Error("Context summarizer returned no JSON object; history was not replaced.");
}

export class HierarchicalCompressor {
  private summaryBlocks: SummaryBlock[] = [];

  constructor(
    private provider: LLMProvider,
    private model: string,
  ) {}

  setProvider(provider: LLMProvider, model: string): void {
    this.provider = provider;
    this.model = model;
  }

  getSummaryBlocks(): SummaryBlock[] {
    return [...this.summaryBlocks];
  }

  /**
   * 階層的圧縮を実行する。
   * 古いメッセージをブロック単位で要約し、要約ブロックとして管理する。
   *
   * @returns 圧縮結果のテキスト（メッセージ履歴の先頭に注入する用）
   */
  async compress(olderMessages: Message[]): Promise<string> {
    if (olderMessages.length === 0) return this.buildContextSummary();

    // Step 1: ブロック分割
    const blocks: Message[][] = [];
    for (let i = 0; i < olderMessages.length; i += BLOCK_SIZE) {
      blocks.push(olderMessages.slice(i, i + BLOCK_SIZE));
    }

    // Step 2: 各ブロックを Layer 1 に要約（並列実行）
    logger.info(`Compressing ${blocks.length} block(s) to Layer 1...`);
    const newLayer1Blocks = await Promise.all(blocks.map((block) => this.summarizeToLayer1(block)));
    this.summaryBlocks.push(...newLayer1Blocks);

    // Step 3: Layer 1 が多すぎたら Layer 2 に統合
    const layer1Blocks = this.summaryBlocks.filter((b) => b.layer === 1);
    if (layer1Blocks.length > MAX_LAYER1_BLOCKS) {
      logger.info(`Layer 1 blocks (${layer1Blocks.length}) exceed limit, promoting to Layer 2...`);
      await this.promoteToLayer2(layer1Blocks);
    }

    return this.buildContextSummary();
  }

  /** メッセージブロック → Layer 1 要約 */
  private async summarizeToLayer1(messages: Message[]): Promise<SummaryBlock> {
    const blockText = messagesToText(messages);
    const prompt = LAYER1_PROMPT + blockText;

    try {
      const gen = this.provider.chat({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: COMPRESSOR_LAYER1_TEMPERATURE,
        maxTokens: COMPRESSOR_LAYER1_MAX_TOKENS,
        stream: true,
      });

      const response = await collectResponse(gen);
      const { summary, keyFacts } = parseSummaryResponse(response.content);

      return {
        id: generateBlockId(),
        layer: 1,
        summary,
        keyFacts,
        tokenCount: estimateTokens(summary + keyFacts.join(" ")),
        createdAt: Date.now(),
      };
    } catch (e) {
      throw new Error(
        `Layer 1 context summarization failed; history was not replaced with a lossy substitute: ${String(e)}`,
        { cause: e },
      );
    }
  }

  /** Layer 1 ブロック群 → Layer 2 に統合 */
  private async promoteToLayer2(layer1Blocks: SummaryBlock[]): Promise<void> {
    const blockTexts = layer1Blocks
      .map((b, i) => {
        const facts = b.keyFacts.length > 0 ? `\nキーファクト: ${b.keyFacts.join(", ")}` : "";
        return `--- ブロック${i + 1} ---\n${b.summary}${facts}`;
      })
      .join("\n\n");

    const prompt = LAYER2_PROMPT + blockTexts;

    try {
      const gen = this.provider.chat({
        model: this.model,
        messages: [{ role: "user", content: prompt }],
        temperature: COMPRESSOR_LAYER2_TEMPERATURE,
        maxTokens: COMPRESSOR_LAYER2_MAX_TOKENS,
        stream: true,
      });

      const response = await collectResponse(gen);
      const { summary, keyFacts } = parseSummaryResponse(response.content);

      const layer2Block: SummaryBlock = {
        id: generateBlockId(),
        layer: 2,
        summary,
        keyFacts,
        tokenCount: estimateTokens(summary + keyFacts.join(" ")),
        createdAt: Date.now(),
      };

      // Layer 1 ブロックを削除し、Layer 2 に置き換え
      const layer1Ids = new Set(layer1Blocks.map((b) => b.id));
      this.summaryBlocks = this.summaryBlocks.filter((b) => !layer1Ids.has(b.id));
      this.summaryBlocks.push(layer2Block);

      logger.info(`Promoted ${layer1Blocks.length} Layer 1 blocks → 1 Layer 2 block`);
    } catch (e) {
      logger.warn(`Layer 2 promotion failed: ${e}`);
      // 失敗時は Layer 1 をそのまま維持
    }
  }

  /** 現在の要約ブロック群からメッセージ履歴に注入するテキストを構築 */
  buildContextSummary(): string {
    const layer2 = this.summaryBlocks.filter((b) => b.layer === 2);
    const layer1 = this.summaryBlocks.filter((b) => b.layer === 1);

    const parts: string[] = [];

    if (layer2.length > 0) {
      parts.push("=== 過去の文脈（圧縮） ===");
      for (const b of layer2) {
        parts.push(b.summary);
        if (b.keyFacts.length > 0) {
          parts.push("重要事項: " + b.keyFacts.join(" / "));
        }
      }
    }

    if (layer1.length > 0) {
      parts.push("=== 直近の文脈（詳細） ===");
      for (const b of layer1) {
        parts.push(b.summary);
        if (b.keyFacts.length > 0) {
          parts.push("キーファクト: " + b.keyFacts.join(" / "));
        }
      }
    }

    return parts.join("\n\n");
  }
}
