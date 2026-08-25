const EXPECT_QUIT_MARKER = "__PTY_QUIT_SENT__";

const EXPECT_PROGRAM = `
set timeout 30
log_user 1
spawn -noecho $env(PTY_NODE) $env(PTY_TSX) $env(PTY_ENTRY) --no-mcp
expect {
  -re {LocalLLM Agent} {
    puts "${EXPECT_QUIT_MARKER}"
    send -- "/quit\\r"
    exp_continue
  }
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
      env: { PTY_NODE: node, PTY_TSX: tsx, PTY_ENTRY: entry },
      parentSubmits: false,
      quitMarker: EXPECT_QUIT_MARKER,
    };
  }

  const command = [node, tsx, entry, "--no-mcp"].map((part) => JSON.stringify(part)).join(" ");
  return {
    executable: "script",
    args: ["-qec", command, "/dev/null"],
    env: {},
    parentSubmits: true,
    quitMarker: EXPECT_QUIT_MARKER,
  };
}
