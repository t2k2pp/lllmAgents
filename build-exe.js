import * as esbuild from "esbuild";
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getGitBuildId } from "./scripts/git-revision.js";
import { selectSeaNode } from "./scripts/sea-node.js";

const DIST_DIR = "dist";
const APP_NAME = "localllm";
const EXE_NAME = process.platform === "win32" ? `${APP_NAME}.exe` : APP_NAME;
const CJS_BUNDLE = path.join(DIST_DIR, `${APP_NAME}.cjs`);
const SEA_CONFIG = path.join(DIST_DIR, "sea-config.json");
const SEA_BLOB = path.join(DIST_DIR, "sea-prep.blob");
const packageVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;

if (typeof packageVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(packageVersion)) {
  throw new Error(`package.json version must be MAJOR.MINOR.PATCH; observed ${JSON.stringify(packageVersion)}`);
}

// 注: かつて `node --build-sea` というモダンな単一コマンド経路が提案されていたが、
// Node 24.13 までで実装されておらず常に bad option エラーになる。本実装は
// `--experimental-sea-config` + postject の "legacy" 経路だけを正式な生成経路とする。
// どこか一段でも失敗した場合は非同等なシェルラッパを生成せず、ビルドを失敗させる。

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

// Shim to replace import.meta.url in CJS format
const shimPath = path.join(DIST_DIR, "shim.js");
fs.writeFileSync(
  shimPath,
  `
  const url_mod = require('url');
  export const import_meta_url = typeof __filename !== 'undefined' ? url_mod.pathToFileURL(__filename).href : '';
`,
);

// コミットハッシュを exe に埋め込む (src/version.ts の __APP_COMMIT__ を置換)。
// 配布 exe の起動バナー・--version・クラッシュログから中身を特定するため (PR-12)。
const appCommit = getGitBuildId();

async function build() {
  console.log(`[1/5] Bundling application with esbuild... (version ${packageVersion}, build ${appCommit})`);
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: CJS_BUNDLE,
    // playwright/playwright-core はバンドルしない（external）。
    // 理由: playwright-core は起動時に require.resolve("../../../package.json") 等で
    //       自分のパッケージ位置/ブラウザの場所を解決する。1ファイルに束ねると相対パスが
    //       壊れ、SEA では require.resolve 自体が無く "require.resolve is not a function" になる。
    //       → ディスク上の非バンドル playwright を実行時に createRequire で読む方式に切替
    //         （docs/exe-playwright-externalization.md）。chromium-bidi も同様の理由で external。
    external: [
      "chromium-bidi",
      "chromium-bidi/*",
      "playwright",
      "playwright-core",
      // jimp v1.x は内部で @jimp/wasm-* (WASM バイナリ) を使い esbuild で解決不能。
      // playwright と同じく外部化し、実行時に createRequire で node_modules から読む。
      "jimp",
      "@jimp/*",
    ],
    define: {
      "import.meta.url": "import_meta_url",
      __APP_VERSION__: JSON.stringify(packageVersion),
      __APP_COMMIT__: JSON.stringify(appCommit),
    },
    inject: [shimPath],
  });

  const exeDest = path.join(DIST_DIR, EXE_NAME);

  console.log("[2/5] Creating SEA configuration file...");
  fs.writeFileSync(
    SEA_CONFIG,
    JSON.stringify(
      {
        main: CJS_BUNDLE,
        output: SEA_BLOB,
        disableExperimentalSEAWarning: true,
      },
      null,
      2,
    ),
  );

  const seaNode = selectSeaNode({
    requested: process.env.NODE_EXE,
    current: process.execPath,
    fallbackCandidates: ["/usr/local/bin/node", "/opt/homebrew/bin/node"],
  });
  if (seaNode !== process.execPath) {
    console.log(`       (sea fallback) using SEA-capable node at: ${seaNode}`);
  }

  try {
    console.log("[3/5] Generating Node.js SEA blob...");
    execFileSync(seaNode, ["--experimental-sea-config", SEA_CONFIG], { stdio: "inherit" });

    console.log("[4/5] Copying node executable...");
    // Node 本体は r-x 権限。copyFileSync が src の mode を継ぎ、
    // 2 回目以降のビルド時に dest 側が読み取り専用で残って EACCES になる罠。
    // 事前削除 + 上書き後 chmod で書き込み可能 mode に揃える。
    if (fs.existsSync(exeDest)) fs.rmSync(exeDest, { force: true });
    fs.copyFileSync(seaNode, exeDest);
    fs.chmodSync(exeDest, 0o755);

    // macOS 固有: 公式 .pkg 版の node は universal binary (arm64+x86_64) で
    // SEA fuse が両アーキ分 2 回出現してしまい postject が
    // "Multiple occurences of sentinel" で失敗する。
    // lipo -thin で現アーキだけにスリム化。
    if (process.platform === "darwin") {
      try {
        const lipoInfo = execSync(`lipo -info "${exeDest}"`, { encoding: "utf8" });
        if (/Architectures in the fat file/i.test(lipoInfo)) {
          const arch = process.arch === "arm64" ? "arm64" : "x86_64";
          console.log(`       (darwin) universal binary detected → lipo -thin ${arch}`);
          const thinTmp = `${exeDest}.thin`;
          execSync(`lipo -thin ${arch} "${exeDest}" -output "${thinTmp}"`, { stdio: "inherit" });
          fs.rmSync(exeDest, { force: true });
          fs.renameSync(thinTmp, exeDest);
          fs.chmodSync(exeDest, 0o755);
        }
      } catch (e) {
        console.warn(`       WARN: lipo check/thin failed: ${e.message}`);
      }

      // Apple 純正署名が残っていると postject がセグメント書込み時に
      // "Can't read and write to target executable" で落ちる。事前に剥がす。
      console.log("       (darwin) stripping existing Apple signature...");
      try {
        execSync(`codesign --remove-signature "${exeDest}"`, { stdio: "inherit" });
      } catch {
        console.warn("       WARN: codesign --remove-signature failed.");
      }
    }

    console.log("[5/5] Injecting blob into executable with postject...");
    const fuse = "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2";
    execSync(
      `npx postject "${exeDest}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse "${fuse}" --macho-segment-name NODE_SEA`,
      { stdio: "inherit" },
    );

    // postject で改造後の Mach-O は元署名と整合せず "killed: 9" になる。ad-hoc 再署名。
    if (process.platform === "darwin") {
      console.log("       (darwin) ad-hoc 再署名...");
      execSync(`codesign --force --sign - "${exeDest}"`, { stdio: "inherit" });
    }
  } catch (err) {
    throw new Error(`SEA executable build failed; no wrapper was generated: ${err.message}`, { cause: err });
  }

  console.log(`\nSUCCESS! Executable created at: ${exeDest}`);
}

build().catch((err) => {
  console.error("Build failed!", err);
  process.exit(1);
});
