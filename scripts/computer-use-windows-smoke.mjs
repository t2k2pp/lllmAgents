import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { WindowsDesktopDriver } from "../dist/computer-use/windows-driver.js";

if (process.platform !== "win32") {
  throw new Error("This real-desktop smoke test must be run in an interactive Windows session.");
}

const title = `LocalLLM Computer Use Smoke ${randomUUID()}`;
const keepArtifacts = process.argv.includes("--keep-artifacts");
const suffix = "CU-SMOKE-日本語-42";
const expected = `draf${suffix}`;
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "localllm-computer-use-"));
const resolvedTempDir = path.resolve(tempDir);
const expectedTempPrefix = `${path.resolve(os.tmpdir())}${path.sep}localllm-computer-use-`;
if (!resolvedTempDir.startsWith(expectedTempPrefix)) throw new Error(`Refusing unsafe cleanup path: ${tempDir}`);
const beforePath = path.join(tempDir, "before.png");
const afterPath = path.join(tempDir, "after.png");
const resultPath = path.join(tempDir, "result.txt");
const chordPath = path.join(tempDir, "chord.txt");

const helperScript = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$form = New-Object Windows.Forms.Form
$form.Text = $env:LOCALLLM_SMOKE_TITLE
$form.StartPosition = 'CenterScreen'
$form.ClientSize = New-Object Drawing.Size 480,320
$form.TopMost = $true
$form.KeyPreview = $true
$text = New-Object Windows.Forms.TextBox
$text.Name = 'input'
$text.Multiline = $true
$text.ScrollBars = 'Vertical'
$text.Location = New-Object Drawing.Point 20,20
$text.Size = New-Object Drawing.Size 440,210
$close = New-Object Windows.Forms.Button
$close.Text = 'Verify and close'
$close.Location = New-Object Drawing.Point 330,255
$close.Size = New-Object Drawing.Size 130,35
$close.Add_Click({
  [IO.File]::WriteAllText($env:LOCALLLM_SMOKE_RESULT, $text.Text, [Text.UTF8Encoding]::new($false))
  $form.Close()
})
$form.Controls.Add($text)
$form.Controls.Add($close)
$form.Add_KeyDown({
  if ($_.Control -and $_.KeyCode -eq [Windows.Forms.Keys]::B) {
    [IO.File]::WriteAllText($env:LOCALLLM_SMOKE_CHORD, 'CTRL+B', [Text.UTF8Encoding]::new($false))
  }
})
$form.Add_Shown({ $text.Focus() })
[void]$form.ShowDialog()
`;

const encodedHelper = Buffer.from(helperScript, "utf16le").toString("base64");
const child = spawn("powershell.exe", ["-NoProfile", "-Sta", "-EncodedCommand", encodedHelper], {
  env: {
    ...process.env,
    LOCALLLM_SMOKE_TITLE: title,
    LOCALLLM_SMOKE_RESULT: resultPath,
    LOCALLLM_SMOKE_CHORD: chordPath,
  },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: false,
});
let helperError = "";
child.stderr.on("data", (chunk) => {
  helperError += chunk.toString();
});

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const driver = new WindowsDesktopDriver();

async function waitForTarget() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const target = (await driver.listWindows()).find((window) => window.title === title);
    if (target) return target;
    if (child.exitCode !== null) throw new Error(`Smoke helper exited early: ${helperError || child.exitCode}`);
    await delay(100);
  }
  throw new Error("Timed out waiting for the dedicated smoke-test window.");
}

async function waitForExit() {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Smoke helper did not close after the verified click.")), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function waitForChord() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      if ((await fs.readFile(chordPath, "utf8")) === "CTRL+B") return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await delay(50);
  }
  throw new Error("The helper window did not observe the CTRL+B chord.");
}

try {
  const target = await waitForTarget();
  await driver.screenshot(target.id, beforePath);
  await driver.click(target.id, 50, 70, "left", 1);
  await driver.typeText(target.id, "draft");
  await driver.key(target.id, ["CTRL", "B"]);
  await waitForChord();
  await driver.key(target.id, ["BACKSPACE"]);
  await driver.typeText(target.id, suffix);
  await driver.scroll(target.id, 100, 100, -2);
  await driver.screenshot(target.id, afterPath);
  await driver.click(target.id, 410, 310, "left", 1);
  const exitCode = await waitForExit();
  if (exitCode !== 0) throw new Error(`Smoke helper exited with ${exitCode}: ${helperError}`);

  const actual = await fs.readFile(resultPath, "utf8");
  if (actual !== expected) throw new Error(`Unicode/key input mismatch: ${JSON.stringify(actual)}`);
  const [before, after, beforeImage, afterImage] = await Promise.all([
    fs.stat(beforePath),
    fs.stat(afterPath),
    fs.readFile(beforePath),
    fs.readFile(afterPath),
  ]);
  if (before.size === 0 || after.size === 0) throw new Error("A target-window screenshot was empty.");
  const beforeHash = createHash("sha256").update(beforeImage).digest("hex");
  const afterHash = createHash("sha256").update(afterImage).digest("hex");
  if (beforeHash === afterHash)
    throw new Error("Before/after screenshots were identical; visual state was not captured.");
  console.log(
    `[computer-use-smoke] OK — target=${target.width}x${target.height}; ` +
      `screenshots=${before.size}/${after.size} bytes (distinct); click/type/key+chord/scroll verified`,
  );
} finally {
  if (child.exitCode === null) child.kill();
  if (keepArtifacts) {
    console.log(`[computer-use-smoke] artifacts=${tempDir}`);
  } else {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
