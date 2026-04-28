import * as esbuild from 'esbuild';
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIST_DIR = 'dist';
const APP_NAME = 'localllm';
const EXE_NAME = process.platform === 'win32' ? `${APP_NAME}.exe` : APP_NAME;
const CJS_BUNDLE = path.join(DIST_DIR, `${APP_NAME}.cjs`);
const SEA_CONFIG = path.join(DIST_DIR, 'sea-config.json');
const SEA_BLOB = path.join(DIST_DIR, 'sea-prep.blob');

// Function to check if Node.js version supports --build-sea (>= 21.7.0 or >= 20.11.0)
function supportsBuildSea() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major >= 21) return major > 21 || (major === 21 && minor >= 7);
  if (major === 20) return minor >= 11;
  return major > 21;
}
const useBuildSea = supportsBuildSea();

if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

// Shim to replace import.meta.url in CJS format
const shimPath = path.join(DIST_DIR, 'shim.js');
fs.writeFileSync(shimPath, `
  const url_mod = require('url');
  export const import_meta_url = typeof __filename !== 'undefined' ? url_mod.pathToFileURL(__filename).href : '';
`);

async function build() {
  console.log('[1/5] Bundling application with esbuild...');
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: CJS_BUNDLE,
    // Externalize problematic dynamic imports like chromium-bidi (used by playwright)
    external: [
      'chromium-bidi',
      'chromium-bidi/*'
    ],
    define: {
      'import.meta.url': 'import_meta_url'
    },
    inject: [shimPath]
  });

  console.log('[2/5] Creating SEA configuration file...');
  fs.writeFileSync(SEA_CONFIG, JSON.stringify({
    main: CJS_BUNDLE,
    output: useBuildSea ? path.join(DIST_DIR, EXE_NAME) : SEA_BLOB,
    disableExperimentalSEAWarning: true
  }, null, 2));

  try {
    if (useBuildSea) {
      console.log('[3/5] Generating executable with node --build-sea...');
      const exeDest = path.join(DIST_DIR, EXE_NAME);
      if (fs.existsSync(exeDest)) fs.rmSync(exeDest, { force: true });

      execSync(`node --build-sea ${SEA_CONFIG}`, { stdio: 'inherit' });

      if (process.platform === 'darwin') {
        console.log('[4/5] Applying ad-hoc code signature (required for Apple Silicon)...');
        execSync(`codesign --sign - "${exeDest}"`, { stdio: 'inherit' });
      }
      console.log('[5/5] Skipping legacy injection steps.');
    } else {
      console.log('[3/5] Generating Node.js SEA blob...');
      execSync(`node --experimental-sea-config ${SEA_CONFIG}`, { stdio: 'inherit' });

      console.log('[4/5] Copying node executable...');
      const exeDest = path.join(DIST_DIR, EXE_NAME);
      if (fs.existsSync(exeDest)) fs.rmSync(exeDest, { force: true });
      fs.copyFileSync(process.execPath, exeDest);
      // Ensure the executable is writable
      fs.chmodSync(exeDest, 0o755);

      if (process.platform === 'darwin') {
        console.log('[4.5/5] Removing macOS code signature...');
        try {
          execSync(`codesign --remove-signature "${exeDest}"`, { stdio: 'inherit' });
        } catch (e) {
          console.warn('Warning: Failed to remove code signature.');
        }
      }

      console.log('[5/5] Injecting blob into executable with postject...');
      const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
      execSync(`npx postject "${exeDest}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse "${fuse}" --macho-segment-name NODE_SEA`, { stdio: 'inherit' });

      if (process.platform === 'darwin') {
        console.log('[5.5/5] Applying ad-hoc code signature (required for Apple Silicon)...');
        execSync(`codesign --sign - "${exeDest}"`, { stdio: 'inherit' });
      }
    }
  } catch (err) {
    console.error("\nSEA build failed, falling back to shell wrapper mode...");
    if (process.platform === 'win32') {
      // Windows fallback (batch script)
      const batContent = `@echo off\nnode "%~dp0${APP_NAME}.cjs" %*\n`;
      fs.writeFileSync(path.join(DIST_DIR, EXE_NAME), batContent);
    } else {
      // Unix fallback (shell script)
      const shContent = `#!/bin/bash\nexec node "$(dirname "$0")/${APP_NAME}.cjs" "$@"\n`;
      const exeDest = path.join(DIST_DIR, EXE_NAME);
      fs.writeFileSync(exeDest, shContent);
      fs.chmodSync(exeDest, 0o755);
    }
    console.log(`Fallback wrapper created at: ${path.join(DIST_DIR, EXE_NAME)}`);
  }

  const finalExe = path.join(DIST_DIR, EXE_NAME);
  console.log(`\nSUCCESS! Executable created at: ${finalExe}`);
  }

build().catch(err => {
  console.error("Build failed!", err);
  process.exit(1);
});
