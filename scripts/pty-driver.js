const EXPECT_QUIT_MARKER = "__PTY_QUIT_SENT__";
const EXPECT_SCROLL_MARKER = "__PTY_SCROLL_SEEN__";
const EXPECT_IME_MARKER = "__PTY_IME_SEEN__";
const SCROLL_CAPABLE_TERM = "xterm-256color";

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
send -- "/help\\r"
expect -re {Ctrl\\+C}
send -- "\\033\\[5~"
expect -re {PgDn}
puts "${EXPECT_SCROLL_MARKER}"
puts "${EXPECT_QUIT_MARKER}"
send -- "\\033\\[6~"
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
  };
}
