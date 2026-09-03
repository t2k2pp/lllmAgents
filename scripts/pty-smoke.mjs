#!/usr/bin/env node
import { spawn } from "node:child_process";
import * as http from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { interactivePtyEnv, ptyDriver } from "./pty-driver.js";
import { submitPtyLine } from "./pty-input.js";

if (process.platform === "win32") {
  console.error("Windows CIには対話console hostが無いため、このsmokeはLinux/macOSで実行します。");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = mkdtempSync(join(tmpdir(), "localllm-pty-home-"));
const tempWork = mkdtempSync(join(tmpdir(), "localllm-pty-work-"));
const configDir = join(tempHome, ".localllm");
mkdirSync(configDir, { recursive: true });
const previewHoldMs = 3_000;
let finalChunkSentAt = Number.POSITIVE_INFINITY;
let requestReceivedAt = Number.POSITIVE_INFINITY;
let responseStartedAt = Number.POSITIVE_INFINITY;
let firstChunkWrittenAt = Number.POSITIVE_INFINITY;
let postRequestCount = 0;
let secondRequestReceivedAt = Number.POSITIVE_INFINITY;
const mockServer = http.createServer((req, res) => {
  if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "pty-smoke", object: "model" }] }));
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
    res.writeHead(404);
    res.end();
    return;
  }
  requestReceivedAt = Date.now();
  postRequestCount++;
  if (postRequestCount === 2) secondRequestReceivedAt = Date.now();
  req.on("end", () => {
    responseStartedAt = Date.now();
    res.writeHead(200, { "content-type": "text/event-stream" });
    // delayed SSEの先頭byteがOS/socket bufferingに留まると、UIではなくmockの
    // flush待ちを測ってしまう。headerを確定しNagleを切ってから先頭chunkを書く。
    res.flushHeaders();
    res.socket?.setNoDelay(true);
    const send = (body) => res.write(`data: ${JSON.stringify(body)}\n\n`);
    if (postRequestCount === 1) {
      // previewを先に送り、最終本文を意図的に遅らせる。buffered modeが先頭本文を
      // live表示できなければ、PTY側の2秒timeoutがfinal到着前に失敗する。
      send({ choices: [{ index: 0, delta: { content: "PV42 応答を準備中" }, finish_reason: null }] });
      firstChunkWrittenAt = Date.now();
      setTimeout(() => {
        finalChunkSentAt = Date.now();
        send({ choices: [{ index: 0, delta: { content: " FINAL99" }, finish_reason: null }] });
        send({
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_pty_preview",
                    type: "function",
                    function: { name: "response_complete", arguments: '{"summary":"PTY preview complete"}' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        });
        send({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        });
        res.write("data: [DONE]\n\n");
        res.end();
      }, previewHoldMs).unref?.();
      return;
    }

    // 通常type-aheadが同一runへsteerされなければ、この2回目の要求には到達しない。
    send({ choices: [{ index: 0, delta: { content: "STEER_OK 同一ターンの追加入力を反映" }, finish_reason: null }] });
    send({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_pty_steer",
                type: "function",
                function: { name: "response_complete", arguments: '{"summary":"PTY steer complete"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    send({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    });
    res.write("data: [DONE]\n\n");
    res.end();
  });
  // listenerを先に登録する。短いbodyではresume直後にendへ到達し得るため、逆順だと
  // mockがrequestを受けてもSSEを1byteも返さないraceになる。
  req.resume();
});
await new Promise((resolveListen) => mockServer.listen(0, "127.0.0.1", resolveListen));
const mockAddress = mockServer.address();
if (!mockAddress || typeof mockAddress === "string") throw new Error("PTY mock LLM did not bind a TCP port");
writeFileSync(
  join(configDir, "config.json"),
  JSON.stringify({
    mainLLM: {
      providerType: "vllm",
      baseUrl: `http://127.0.0.1:${mockAddress.port}`,
      model: "pty-smoke",
      contextWindow: 8192,
    },
    modelCapabilities: { "pty-smoke": { tier: "T2", contextWindow: 8192 } },
    updateCheck: { enabled: false },
    mcpEnabled: false,
  }),
  "utf8",
);

const node = process.execPath;
const tsx = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(root, "src", "index.ts");
const driver = ptyDriver(process.platform, { node, tsx, entry });

try {
  const result = await new Promise((resolveRun, reject) => {
    const child = spawn(driver.executable, driver.args, {
      cwd: tempWork,
      env: interactivePtyEnv(process.env, {
        ...driver.env,
        HOME: tempHome,
        USERPROFILE: tempHome,
        NO_COLOR: "1",
        // failure annotationでprovider到達とAgentLoop preview到達を分離する。
        // 本文は記録せず、既存の明示HTTP debug modeをこのsmokeだけで有効化する。
        LLM_DEBUG_HTTP: "1",
      }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "";
    let sentHelp = false;
    let sentJapanese = false;
    let japaneseSeen = false;
    let sentMouseUp = false;
    let mouseUpOutputStart = 0;
    let scrollSeen = false;
    let sentMouseDown = false;
    let mouseDownOutputStart = 0;
    let sentPreview = false;
    let previewSeen = false;
    let previewSeenBeforeFinal = false;
    let previewChunkSeen = false;
    let providerTextChunkSeen = false;
    let providerFilteredChunkSeen = false;
    let agentTextChunkSeen = false;
    let agentStreamingDisplay = null;
    let waitingSpinnerStopped = false;
    let thinkingSpinnerStopped = false;
    let previewFilteredChars = null;
    let sentQuit = false;
    let sentSteer = false;
    let sentPause = false;
    let pauseAcceptedSeen = false;
    let pauseReachedSeen = false;
    let sentParallel = false;
    let parallelAppliedSeen = false;
    let sentResume = false;
    let resumeConfirmedSeen = false;
    let resumeSentAt = Number.POSITIVE_INFINITY;
    let steerAcceptedSeen = false;
    let steerAppliedSeen = false;
    let steerResponseSeen = false;
    let finalSeen = false;
    let quitQueuedSeen = false;
    let pendingQuitSeen = false;
    let goodbyeSeen = false;
    let timedOut = false;
    const capture = (chunk) => {
      output += chunk.toString();
      if (!scrollSeen && output.includes(driver.scrollMarker)) {
        scrollSeen = true;
      }
      if (!japaneseSeen && output.includes(driver.imeMarker)) japaneseSeen = true;
      if (!sentPreview && output.includes(driver.previewSubmittedMarker)) sentPreview = true;
      if (!previewSeen && (output.includes(driver.previewMarker) || output.includes(driver.previewSeenMarker))) {
        previewSeen = true;
        previewSeenBeforeFinal = Date.now() < finalChunkSentAt;
      }
      if (!previewChunkSeen && output.includes("[LLM_DEBUG_UI] response-preview first-chunk")) {
        previewChunkSeen = true;
      }
      if (!providerTextChunkSeen && output.includes("[LLM_DEBUG_HTTP] SSE text delta")) {
        providerTextChunkSeen = true;
      }
      if (!providerFilteredChunkSeen && output.includes("[LLM_DEBUG_HTTP] VLLM think-filter text")) {
        providerFilteredChunkSeen = true;
      }
      if (!agentTextChunkSeen && output.includes("[LLM_DEBUG_UI] agent-loop text-chunk")) {
        agentTextChunkSeen = true;
        agentStreamingDisplay = output.includes("streamingDisplay=true");
      }
      if (!waitingSpinnerStopped && output.includes("[LLM_DEBUG_UI] response-preview waiting-spinner-stopped")) {
        waitingSpinnerStopped = true;
      }
      if (!thinkingSpinnerStopped && output.includes("[LLM_DEBUG_UI] response-preview thinking-spinner-stopped")) {
        thinkingSpinnerStopped = true;
      }
      if (previewFilteredChars === null) {
        const filteredMatch = output.match(/\[LLM_DEBUG_UI\] response-preview filtered chars=(\d+)/);
        if (filteredMatch) previewFilteredChars = Number(filteredMatch[1]);
      }
      if (!sentQuit && output.includes(driver.quitMarker)) {
        sentQuit = true;
      }
      if (!sentSteer && output.includes(driver.steerSentMarker)) sentSteer = true;
      if (!sentPause && output.includes(driver.pauseSentMarker)) sentPause = true;
      if (!pauseAcceptedSeen && output.includes("pause予約を受理しました")) pauseAcceptedSeen = true;
      if (!pauseReachedSeen && output.includes("runをLLM API境界で一時停止しました")) pauseReachedSeen = true;
      if (!sentParallel && driver.parallelSentMarker && output.includes(driver.parallelSentMarker)) {
        sentParallel = true;
      }
      if (!parallelAppliedSeen && output.includes("並列実行上限を 4 に設定しました")) parallelAppliedSeen = true;
      if (!sentResume && output.includes(driver.resumeSentMarker)) {
        sentResume = true;
        resumeSentAt = Date.now();
      }
      if (!resumeConfirmedSeen && output.includes("foreground runを再開しました")) resumeConfirmedSeen = true;
      if (!finalSeen && output.includes(driver.finalMarker)) finalSeen = true;
      if (!steerAcceptedSeen && output.includes("追加入力を受け付けました")) steerAcceptedSeen = true;
      if (!steerAppliedSeen && output.includes("現在の処理へ反映します")) steerAppliedSeen = true;
      if (!steerResponseSeen && output.includes(driver.steerMarker)) steerResponseSeen = true;
      if (!quitQueuedSeen && output.includes("キューに追加しました")) quitQueuedSeen = true;
      if (!pendingQuitSeen && output.includes("追加入力を処理")) pendingQuitSeen = true;
      if (!goodbyeSeen && /Goodbye!/i.test(output)) goodbyeSeen = true;
      if (driver.parentSubmits && !sentJapanese && /LocalLLM Agent/i.test(output)) {
        sentJapanese = true;
        child.stdin.write("日本語入力の右端折返し確認");
      }
      if (driver.parentSubmits && sentJapanese && !sentHelp && output.includes("日本語入力の右端折返し確認")) {
        japaneseSeen = true;
        sentHelp = true;
        child.stdin.write("\x15");
        child.stdin.write(submitPtyLine("/help"));
      }
      if (
        driver.parentSubmits &&
        sentHelp &&
        !sentMouseUp &&
        /Ctrl\+C/.test(output) &&
        output.includes("\x1b[?1000h\x1b[?1006h")
      ) {
        sentMouseUp = true;
        mouseUpOutputStart = output.length;
        child.stdin.write("\x1b[<64;10;4M");
      }
      if (driver.parentSubmits && sentMouseUp && !scrollSeen && output.slice(mouseUpOutputStart).includes("PgDn")) {
        scrollSeen = true;
        sentMouseDown = true;
        mouseDownOutputStart = output.length;
        child.stdin.write("\x1b[<65;10;4M");
      }
      // mouse reportと本文を同じstdin chunkへ詰めず、入力欄の再描画後に送る。
      // これによりreadlineへreport断片が混入していないことも後続requestで検証する。
      if (driver.parentSubmits && sentMouseDown && !sentPreview && output.slice(mouseDownOutputStart).includes("> ")) {
        sentPreview = true;
        child.stdin.write(submitPtyLine("PREVIEW_REQUEST"));
      }
      if (driver.parentSubmits && sentPreview && previewSeen && !sentPause) {
        sentPause = true;
        child.stdin.write(submitPtyLine("/run pause"));
      }
      if (driver.parentSubmits && pauseAcceptedSeen && !sentSteer) {
        sentSteer = true;
        // preview表示時点ならrun中のtype-aheadが所有権を持っている。
        // 通常メッセージを送り、最初のresponse_completeより優先して同じrunへ反映させる。
        // PTYのLFはinteractive-inputでCtrl+J（改行挿入）になる。CRでEnter確定する。
        child.stdin.write(submitPtyLine("STEER_REQUEST"));
      }
      if (driver.parentSubmits && pauseReachedSeen && !sentParallel) {
        sentParallel = true;
        child.stdin.write(submitPtyLine("/parallel 4"));
      }
      if (driver.parentSubmits && parallelAppliedSeen && !sentResume) {
        sentResume = true;
        resumeSentAt = Date.now();
        child.stdin.write(submitPtyLine("/run resume"));
      }
      if (driver.parentSubmits && steerResponseSeen && !sentQuit) {
        sentQuit = true;
        child.stdin.write(submitPtyLine("/quit"));
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, 30_000);
    child.stdout.on("data", capture);
    child.stderr.on("data", capture);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolveRun({
        code,
        signal,
        output,
        sentQuit,
        sentSteer,
        sentPause,
        pauseAcceptedSeen,
        pauseReachedSeen,
        sentParallel,
        parallelAppliedSeen,
        sentResume,
        resumeConfirmedSeen,
        resumeSentAt,
        steerAcceptedSeen,
        steerAppliedSeen,
        steerResponseSeen,
        finalSeen,
        quitQueuedSeen,
        pendingQuitSeen,
        goodbyeSeen,
        scrollSeen,
        japaneseSeen,
        previewSubmitted: sentPreview,
        previewSeen,
        previewSeenBeforeFinal,
        previewChunkSeen,
        providerTextChunkSeen,
        providerFilteredChunkSeen,
        agentTextChunkSeen,
        agentStreamingDisplay,
        waitingSpinnerStopped,
        thinkingSpinnerStopped,
        previewFilteredChars,
        requestSeen: Number.isFinite(requestReceivedAt),
        responseStarted: Number.isFinite(responseStartedAt),
        firstChunkWritten: Number.isFinite(firstChunkWrittenAt),
        postRequestCount,
        secondRequestReceivedAt,
        timedOut,
      });
    });
  });
  if (
    result.code !== 0 ||
    result.timedOut ||
    !result.sentQuit ||
    !result.sentSteer ||
    !result.sentPause ||
    !result.pauseAcceptedSeen ||
    !result.pauseReachedSeen ||
    !result.sentParallel ||
    !result.parallelAppliedSeen ||
    !result.sentResume ||
    !result.resumeConfirmedSeen ||
    !result.steerAcceptedSeen ||
    !result.steerAppliedSeen ||
    !result.steerResponseSeen ||
    result.postRequestCount < 2 ||
    result.secondRequestReceivedAt < result.resumeSentAt ||
    !result.scrollSeen ||
    !result.japaneseSeen ||
    !result.previewSeen ||
    !result.previewSeenBeforeFinal ||
    !/Goodbye!/i.test(result.output)
  ) {
    console.error(result.output);
    const failure =
      `PTY smoke failed (exit ${result.code}, signal ${result.signal ?? "none"}, ` +
      `quitSent ${result.sentQuit}, scrollSeen ${result.scrollSeen}, ` +
      `steerSent ${result.sentSteer}, steerAccepted ${result.steerAcceptedSeen}, ` +
      `pauseSent ${result.sentPause}, pauseAccepted ${result.pauseAcceptedSeen}, ` +
      `pauseReached ${result.pauseReachedSeen}, parallelSent ${result.sentParallel}, ` +
      `parallelApplied ${result.parallelAppliedSeen}, resumeSent ${result.sentResume}, ` +
      `resumeConfirmed ${result.resumeConfirmedSeen}, secondRequestAfterResume ${
        result.secondRequestReceivedAt >= result.resumeSentAt
      }, ` +
      `steerApplied ${result.steerAppliedSeen}, steerResponse ${result.steerResponseSeen}, ` +
      `japaneseSeen ${result.japaneseSeen}, previewSubmitted ${result.previewSubmitted}, ` +
      `previewSeen ${result.previewSeen}, ` +
      `previewBeforeFinal ${result.previewSeenBeforeFinal}, requestSeen ${result.requestSeen}, ` +
      `responseStarted ${result.responseStarted}, firstChunkWritten ${result.firstChunkWritten}, ` +
      `postRequests ${result.postRequestCount}, providerTextChunkSeen ${result.providerTextChunkSeen}, ` +
      `providerFilteredChunkSeen ${result.providerFilteredChunkSeen}, agentTextChunkSeen ${result.agentTextChunkSeen}, ` +
      `agentStreamingDisplay ${result.agentStreamingDisplay}, waitingSpinnerStopped ${result.waitingSpinnerStopped}, ` +
      `thinkingSpinnerStopped ${result.thinkingSpinnerStopped}, previewFilteredChars ${result.previewFilteredChars}, ` +
      `previewChunkSeen ${result.previewChunkSeen}, ` +
      `finalSeen ${result.finalSeen}, quitQueuedSeen ${result.quitQueuedSeen}, ` +
      `pendingQuitSeen ${result.pendingQuitSeen}, goodbyeSeen ${result.goodbyeSeen}, ` +
      `timedOut ${result.timedOut})`;
    // Actionsの匿名APIでも原因flagをannotationから取得できるようにする。
    console.error(`::error title=Real PTY smoke failed::${failure}`);
    throw new Error(failure);
  }
  console.log("real PTY smoke passed");
} finally {
  mockServer.closeAllConnections?.();
  await new Promise((resolveClose) => mockServer.close(resolveClose));
  rmSync(tempHome, { recursive: true, force: true });
  rmSync(tempWork, { recursive: true, force: true });
}
