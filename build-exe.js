import * as esbuild from "esbuild";
import fs from "fs";
import { execSync } from "child_process";
import path from "path";
import { getGitRevision } from "./scripts/git-revision.js";

const DIST_DIR = "dist";
const APP_NAME = "localllm";
const EXE_NAME = process.platform === "win32" ? `${APP_NAME}.exe` : APP_NAME;
const CJS_BUNDLE = path.join(DIST_DIR, `${APP_NAME}.cjs`);
const SEA_CONFIG = path.join(DIST_DIR, "sea-config.json");
const SEA_BLOB = path.join(DIST_DIR, "sea-prep.blob");

// 注: かつて `node --build-sea` というモダンな単一コマンド経路が提案されていたが、
// Node 24.13 までで実装されておらず常に bad option エラーになる。本実装は
// `--experimental-sea-config` + postject の "legacy" 経路のみを使用し、
// 致命的な失敗時には末尾の catch でシェルラッパへフォールバックする。

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
const appCommit = getGitRevision();

async function build() {
  console.log(`[1/5] Bundling application with esbuild... (commit ${appCommit})`);
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

  try {
    console.log("[3/5] Generating Node.js SEA blob...");
    execSync(`node --experimental-sea-config ${SEA_CONFIG}`, { stdio: "inherit" });

    console.log("[4/5] Copying node executable...");
    // Node 本体は r-x 権限。copyFileSync が src の mode を継ぎ、
    // 2 回目以降のビルド時に dest 側が読み取り専用で残って EACCES になる罠。
    // 事前削除 + 上書き後 chmod で書き込み可能 mode に揃える。
    if (fs.existsSync(exeDest)) fs.rmSync(exeDest, { force: true });
    fs.copyFileSync(process.execPath, exeDest);
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
          const thinTmp = exeDest + ".thin";
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
      } catch (e) {
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
    // ---- Fallback: SEA ビルドが何らかの理由で失敗した場合、薄いシェル/バッチラッパ
    //      に退化して少なくとも動く状態にする (homebrew node 等の救済)。
    //      この経路では node ランタイムが配布先にも必要になる点に注意。
    console.error("\nSEA build failed, falling back to shell wrapper mode...");
    console.error(`  Reason: ${err.message}`);
    if (process.platform === "win32") {
      const batContent = `@echo off\r\nnode "%~dp0${APP_NAME}.cjs" %*\r\n`;
      fs.writeFileSync(path.join(DIST_DIR, EXE_NAME), batContent);
    } else {
      const shContent = `#!/bin/bash\nexec node "$(dirname "$0")/${APP_NAME}.cjs" "$@"\n`;
      fs.writeFileSync(exeDest, shContent);
      fs.chmodSync(exeDest, 0o755);
    }
    console.log(`Fallback wrapper created at: ${exeDest}`);
  }

  console.log(`\nSUCCESS! Executable created at: ${exeDest}`);
}

build().catch((err) => {
  console.error("Build failed!", err);
  process.exit(1);
});
