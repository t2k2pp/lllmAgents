/**
 * OpenAI 互換のモック LLM サーバー (E2E スモークテスト用)。
 * docs/production-readiness.md PR-08
 *
 * GET /v1/models と POST /v1/chat/completions (SSE ストリーミング) だけを実装し、
 * 応答内容はテスト側が渡す reply 関数 (canned response) で決める。
 * 実 LLM を使わないことでテストを決定的・高速・全 OS 実行可能にする。
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface ChatMessage {
  role: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string } }>;
}

export interface MockToolCall {
  name: string;
  args: Record<string, unknown>;
}

export interface MockReply {
  text?: string;
  toolCalls?: MockToolCall[];
}

export class MockLLMServer {
  /** 受信した chat リクエストの記録 (デバッグ・件数検証用) */
  readonly chatRequests: Array<{ messages: ChatMessage[] }> = [];
  private server: http.Server | null = null;

  constructor(private readonly reply: (messages: ChatMessage[]) => MockReply) {}

  /** ephemeral port で listen し、baseUrl (http://127.0.0.1:<port>) を返す */
  async listen(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const { port } = this.server!.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    // keep-alive 接続が残っていても待たずに閉じる
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [{ id: "mock-model", object: "model" }] }));
      return;
    }
    if (req.method === "POST" && req.url?.startsWith("/v1/chat/completions")) {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let messages: ChatMessage[] = [];
        try {
          messages = (JSON.parse(body) as { messages?: ChatMessage[] }).messages ?? [];
        } catch {
          /* 空のまま */
        }
        this.chatRequests.push({ messages });
        this.writeSSE(res, this.reply(messages));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  }

  /** OpenAI 互換の SSE ストリームとして reply を書き出す */
  private writeSSE(res: http.ServerResponse, reply: MockReply): void {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (obj: unknown): void => {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    if (reply.text) {
      send({ choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] });
    }
    const toolCalls = reply.toolCalls ?? [];
    toolCalls.forEach((tc, i) => {
      send({
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: i,
                  id: `call_${this.chatRequests.length}_${i + 1}`,
                  type: "function",
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      });
    });
    send({
      choices: [{ index: 0, delta: {}, finish_reason: toolCalls.length > 0 ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}
