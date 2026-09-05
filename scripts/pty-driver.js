const EXPECT_QUIT_MARKER = "__PTY_QUIT_SENT__";
const EXPECT_SCROLL_MARKER = "__PTY_SCROLL_SEEN__";
const EXPECT_IME_MARKER = "__PTY_IME_SEEN__";
const EXPECT_MOUSE_OFF_MARKER = "__PTY_MOUSE_OFF_SEEN__";
const EXPECT_MOUSE_ON_MARKER = "__PTY_MOUSE_ON_SEEN__";
const EXPECT_PREVIEW_MARKER = "__PTY_PREVIEW_SEEN__";
const EXPECT_PREVIEW_SUBMITTED_MARKER = "__PTY_PREVIEW_SUBMITTED__";
const EXPECT_PROCESSING_INPUT_MARKER = "__PTY_PROCESSING_INPUT_SEEN__";
const EXPECT_MODE_CYCLE_SENT_MARKER = "__PTY_MODE_CYCLE_SENT__";
const EXPECT_MODE_CYCLE_SEEN_MARKER = "__PTY_MODE_CYCLE_SEEN__";
const EXPECT_STEER_VISIBLE_MARKER = "__PTY_STEER_VISIBLE__";
const EXPECT_STEER_MARKER = "__PTY_STEER_SENT__";
const EXPECT_PAUSE_MARKER = "__PTY_PAUSE_SENT__";
const EXPECT_PAUSED_MARKER = "__PTY_PAUSE_REACHED__";
const EXPECT_PARALLEL_MARKER = "__PTY_PARALLEL_SENT__";
const EXPECT_RESUME_MARKER = "__PTY_RESUME_SENT__";
const RESPONSE_PREVIEW_TEXT = "PV42";
const RESPONSE_FINAL_TEXT = "FINAL99";
const RESPONSE_STEER_TEXT = "STEER_OK";
const SCROLL_CAPABLE_TERM = "xterm-256color";

/**
 * CI上でも子プロセスは実ユーザーと同じ対話TTYとして起動する。
 * OraはCIの値ではなくCIキーの存在だけでspinnerを無効化するため、継承させない。
 */
export function interactivePtyEnv(baseEnv, overrides = {}) {
  const env = { ...baseEnv, ...overrides };
  delete env.CI;
  return env;
}

const EXPECT_PROGRAM = `
set timeout 30
log_user 1
spawn -noecho $env(PTY_NODE) $env(PTY_TSX) $env(PTY_ENTRY) --no-mcp
stty columns 20 rows 24
expect {
  -re {LocalLLM Agent} {
    send -- "日本語入力の右端折返し確認"
  }
  timeout {
    puts stderr "__PTY_TIMEOUT__"
    exit 124
  }
}
expect -re {日本語入力の右端折返し確認}
puts "${EXPECT_IME_MARKER}"
send -- "\\025"
send -- "/tui mouse off\\r"
expect -re {マウス追跡: OFF}
puts "${EXPECT_MOUSE_OFF_MARKER}"
send -- "/tui mouse on\\r"
expect -re {マウス追跡: ON}
puts "${EXPECT_MOUSE_ON_MARKER}"
send -- "/help\\r"
expect -re {Ctrl\\+C}
send -- "\\033\\[<64;10;4M"
expect -re {PgDn}
puts "${EXPECT_SCROLL_MARKER}"
send -- "\\033\\[<65;10;4M"
expect -re {> }
send -- "PREVIEW_REQUEST\\r"
puts "${EXPECT_PREVIEW_SUBMITTED_MARKER}"
set timeout 2
expect {
  -re {${RESPONSE_PREVIEW_TEXT}} {
    puts "${EXPECT_PREVIEW_MARKER}"
  }
  timeout {
    puts stderr "__PTY_PREVIEW_TIMEOUT__"
    exit 125
  }
}
expect -re {処理中・追加入力}
puts "${EXPECT_PROCESSING_INPUT_MARKER}"
send -- "/run pause\\r"
puts "${EXPECT_PAUSE_MARKER}"
expect -re {pause予約を受理}
send -- "\\033\\[Z"
puts "${EXPECT_MODE_CYCLE_SENT_MARKER}"
expect -re {モード: Autorun}
puts "${EXPECT_MODE_CYCLE_SEEN_MARKER}"
send -- "STEER_REQUEST"
expect -re {STEER_REQUEST}
puts "${EXPECT_STEER_VISIBLE_MARKER}"
send -- "\\r"
puts "${EXPECT_STEER_MARKER}"
set timeout 30
# /help の「LLM API境界で一時停止・再開」へ誤一致させず、実到達だけを待つ。
expect -re {runをLLM API境界で一時停止しました}
puts "${EXPECT_PAUSED_MARKER}"
send -- "/parallel 4\\r"
puts "${EXPECT_PARALLEL_MARKER}"
expect -re {並列実行上限を 4 に設定しました}
send -- "/run resume\\r"
puts "${EXPECT_RESUME_MARKER}"
expect -re {foreground runを再開}
expect -re {${RESPONSE_FINAL_TEXT}}
expect -re {${RESPONSE_STEER_TEXT}}
puts "${EXPECT_QUIT_MARKER}"
send -- "/quit\\r"
expect {
  timeout {
    puts stderr "__PTY_TIMEOUT__"
    exit 124
  }
  eof {}
}
set wait_result [wait]
exit [lindex $wait_result 3]
`.trim();

/** OSごとのPTYドライバ定義。macOSのscript(1)はpipe stdinでは即時失敗するためexpectを使う。 */
export function ptyDriver(platform, { node, tsx, entry }) {
  if (platform === "darwin") {
    return {
      executable: "expect",
      args: ["-c", EXPECT_PROGRAM],
      env: { PTY_NODE: node, PTY_TSX: tsx, PTY_ENTRY: entry, TERM: SCROLL_CAPABLE_TERM },
      parentSubmits: false,
      quitMarker: EXPECT_QUIT_MARKER,
      scrollMarker: EXPECT_SCROLL_MARKER,
      imeMarker: EXPECT_IME_MARKER,
      mouseOffMarker: EXPECT_MOUSE_OFF_MARKER,
      mouseOnMarker: EXPECT_MOUSE_ON_MARKER,
      previewMarker: RESPONSE_PREVIEW_TEXT,
      previewSeenMarker: EXPECT_PREVIEW_MARKER,
      previewSubmittedMarker: EXPECT_PREVIEW_SUBMITTED_MARKER,
      processingInputMarker: EXPECT_PROCESSING_INPUT_MARKER,
      modeCycleSentMarker: EXPECT_MODE_CYCLE_SENT_MARKER,
      modeCycleSeenMarker: EXPECT_MODE_CYCLE_SEEN_MARKER,
      steerVisibleMarker: EXPECT_STEER_VISIBLE_MARKER,
      finalMarker: RESPONSE_FINAL_TEXT,
      steerMarker: RESPONSE_STEER_TEXT,
      steerSentMarker: EXPECT_STEER_MARKER,
      pauseSentMarker: EXPECT_PAUSE_MARKER,
      pauseReachedMarker: EXPECT_PAUSED_MARKER,
      parallelSentMarker: EXPECT_PARALLEL_MARKER,
      resumeSentMarker: EXPECT_RESUME_MARKER,
    };
  }

  const command = [node, tsx, entry, "--no-mcp"].map((part) => JSON.stringify(part)).join(" ");
  return {
    executable: "script",
    args: ["-qec", command, "/dev/null"],
    // CI shellのTERMは未設定またはdumbの場合がある。今回のscenarioはAlternate Screen
    // そのものを検証するため、PTY子プロセスの端末能力を明示して決定論化する。
    env: { TERM: SCROLL_CAPABLE_TERM },
    parentSubmits: true,
    quitMarker: EXPECT_QUIT_MARKER,
    scrollMarker: EXPECT_SCROLL_MARKER,
    imeMarker: EXPECT_IME_MARKER,
    mouseOffMarker: "マウス追跡: OFF",
    mouseOnMarker: "マウス追跡: ON",
    previewMarker: RESPONSE_PREVIEW_TEXT,
    previewSeenMarker: EXPECT_PREVIEW_MARKER,
    previewSubmittedMarker: EXPECT_PREVIEW_SUBMITTED_MARKER,
    processingInputMarker: "処理中・追加入力",
    modeCycleSentMarker: EXPECT_MODE_CYCLE_SENT_MARKER,
    modeCycleSeenMarker: "モード: Autorun",
    steerVisibleMarker: "STEER_REQUEST",
    finalMarker: RESPONSE_FINAL_TEXT,
    steerMarker: RESPONSE_STEER_TEXT,
    steerSentMarker: EXPECT_STEER_MARKER,
    pauseSentMarker: EXPECT_PAUSE_MARKER,
    pauseReachedMarker: EXPECT_PAUSED_MARKER,
    parallelSentMarker: EXPECT_PARALLEL_MARKER,
    resumeSentMarker: EXPECT_RESUME_MARKER,
  };
}
