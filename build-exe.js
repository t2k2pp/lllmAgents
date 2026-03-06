import * as esbuild from 'esbuild';
import fs from 'fs';
import { execSync } from 'child_process';
import path from 'path';

const DIST_DIR = 'dist';
const APP_NAME = 'localllm';
const EXE_NAME = `${APP_NAME}.exe`;
const CJS_BUNDLE = path.join(DIST_DIR, `${APP_NAME}.cjs`);
const SEA_CONFIG = path.join(DIST_DIR, 'sea-config.json');
const SEA_BLOB = path.join(DIST_DIR, 'sea-prep.blob');

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
    output: SEA_BLOB,
    disableExperimentalSEAWarning: true
  }, null, 2));

  console.log('[3/5] Generating Node.js SEA blob...');
  execSync(`node --experimental-sea-config ${SEA_CONFIG}`, { stdio: 'inherit' });

  console.log('[4/5] Copying node executable...');
  const exeDest = path.join(DIST_DIR, EXE_NAME);
  fs.copyFileSync(process.execPath, exeDest);

  console.log('[5/5] Injecting blob into executable with postject...');
  const fuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
  execSync(`npx postject "${exeDest}" NODE_SEA_BLOB "${SEA_BLOB}" --sentinel-fuse "${fuse}" --macho-segment-name NODE_SEA`, { stdio: 'inherit' });

  console.log(`\nSUCCESS! Executable created at: ${exeDest}`);
}

build().catch(err => {
  console.error("Build failed!", err);
  process.exit(1);
});
