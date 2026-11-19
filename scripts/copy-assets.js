// Copies static runtime assets that TypeScript does NOT compile into the dist/ output
// so that __dirname-relative paths in the compiled main process resolve identically
// to the original src/ layout.
//
// TypeScript (tsconfig.json) compiles the Node-side code (src/Modules, src/main,
// src/main.ts, src/bridge_*.ts) into dist/. The renderer UI, the served Web
// Dashboard, and image/icon assets are intentionally excluded from compilation and
// must be copied verbatim.
const fs = require('node:fs');
const path = require('node:path');
const { copyDir } = require('./lib/copy-dir');

const SRC_ROOT = path.resolve(__dirname, '..', 'src');
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

// Directories (relative to src/) copied wholesale into dist/.
// Keep this in sync with the `exclude` globs in tsconfig.json.
const ASSET_DIRECTORIES = ['UI', 'WebDashboard', 'images'];

// The renderer TypeScript sources are bundled by scripts/build-renderer.js
// (esbuild owns dist/UI/js/app/bundle.js). Skip those source dirs entirely so
// copy-assets never ships them or creates empty mirror folders. Individual `.ts`
// files are also skipped by copyDir, but skipping the dirs avoids empty output.
const skipDirs = new Set([
  path.resolve(SRC_ROOT, 'UI', 'js', 'app'),
  path.resolve(SRC_ROOT, 'UI', 'types'),
]);

// The Web Dashboard's service worker names its cache after the app version, so
// each update starts a fresh offline cache (see src/WebDashboard/service-worker.js).
const VERSION_PLACEHOLDER = '__APP_VERSION__';

function stampServiceWorker() {
  const Worker = path.join(DIST_ROOT, 'WebDashboard', 'service-worker.js');
  const Source = fs.readFileSync(Worker, 'utf8');
  if (!Source.includes(VERSION_PLACEHOLDER)) {
    throw new Error(`[copy-assets] ${VERSION_PLACEHOLDER} not found in service-worker.js`);
  }
  const { version } = require('../package.json');
  fs.writeFileSync(Worker, Source.split(VERSION_PLACEHOLDER).join(version), 'utf8');
}

function main() {
  let copied = 0;
  for (const dir of ASSET_DIRECTORIES) {
    const source = path.join(SRC_ROOT, dir);
    const destination = path.join(DIST_ROOT, dir);
    if (fs.existsSync(source)) {
      copyDir(source, destination, { skipDirs });
      copied += 1;
    }
  }
  stampServiceWorker();
  console.log(
    `[copy-assets] Copied ${copied} static asset director${copied === 1 ? 'y' : 'ies'} into dist/`
  );
}

main();
