// Bundles the TypeScript that runs in browsers and renderers with esbuild.
//
// The Node-side code is compiled by `tsc` (tsconfig.json) into dist/. The
// renderer runs in a browser/Electron-renderer context and is authored as ES
// modules that are bundled here into a single classic script per surface:
//   src/UI/js/app/main.ts               -> dist/UI/js/app/bundle.js              (Electron renderer)
//   src/UI/js/app/dashboard-main.ts     -> dist/WebDashboard/dashboard.js        (served Web Dashboard)
//   src/UI/preloader.ts                 -> dist/UI/preloader.js                  (the splash window)
//   src/WebDashboard/service-worker.ts  -> dist/WebDashboard/service-worker.js   (the dashboard's offline shell)
//
// The first two share the timer formatting/view modules under js/app/lib, so the
// desktop tiles and the dashboard can never disagree about what a timer shows.
//
// Type-checking is performed separately by `tsc --noEmit` (`npm run
// typecheck:renderer`: tsconfig.renderer.json, tsconfig.preloader.json and
// tsconfig.service-worker.json); esbuild only transpiles+bundles.
//
// Vendor libraries (jQuery, Bootstrap, Howler, socket.io) stay
// as external <script> globals for offline use, so they are NOT imported/bundled.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** @type {Array<{name: string, entry: string, outfile: string, stampVersion?: boolean}>} */
const BUNDLES = [
  {
    name: 'Desktop UI',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'main.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'js', 'app', 'bundle.js'),
  },
  {
    name: 'Web Dashboard',
    entry: path.join(ROOT, 'src', 'UI', 'js', 'app', 'dashboard-main.ts'),
    outfile: path.join(ROOT, 'dist', 'WebDashboard', 'dashboard.js'),
  },
  {
    name: 'Splash window',
    entry: path.join(ROOT, 'src', 'UI', 'preloader.ts'),
    outfile: path.join(ROOT, 'dist', 'UI', 'preloader.js'),
  },
  {
    // Served at /service-worker.js. It names its cache after the app version
    // (__APP_VERSION__), so each update starts a fresh offline cache.
    name: 'Web Dashboard service worker',
    entry: path.join(ROOT, 'src', 'WebDashboard', 'service-worker.ts'),
    outfile: path.join(ROOT, 'dist', 'WebDashboard', 'service-worker.js'),
    stampVersion: true,
  },
];

// The version stamped into a bundle as __APP_VERSION__. There must be one: a
// worker built without it would keep the same cache across updates.
function appVersion() {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (typeof version !== 'string' || version.trim() === '') {
    throw new Error('[build-renderer] package.json has no version to stamp into the bundles');
  }
  return version;
}

// esbuild options for one bundle. Shared with scripts/dev.js, whose watch mode
// must produce exactly what a full build does.
function bundleOptions({ entry, outfile, stampVersion }) {
  return {
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: 'iife',
    target: 'es2022',
    platform: 'browser',
    // Minified: parsed on every launch and served to every browser/phone that
    // opens the Web Dashboard. The external source maps keep
    // stack traces and DevTools mapped to the TypeScript, and keepNames keeps
    // function/class names readable in error logs.
    minify: true,
    keepNames: true,
    sourcemap: true,
    legalComments: 'none',
    logLevel: 'info',
    ...(stampVersion ? { define: { __APP_VERSION__: JSON.stringify(appVersion()) } } : {}),
  };
}

// The build fails if a version-stamped bundle came out without the version:
// the source stopped using __APP_VERSION__, or esbuild left it undefined.
function checkVersionStamp(bundle) {
  const Version = appVersion();
  const Output = fs.readFileSync(bundle.outfile, 'utf8');
  if (Output.includes('__APP_VERSION__') || !Output.includes(Version)) {
    throw new Error(
      `[build-renderer] ${path.relative(ROOT, bundle.outfile)} does not carry the app version (${Version})`
    );
  }
}

async function buildBundle(bundle) {
  await esbuild.build(bundleOptions(bundle));
  if (bundle.stampVersion) checkVersionStamp(bundle);
  console.log(`[build-renderer] Bundled ${bundle.name} -> ${path.relative(ROOT, bundle.outfile)}`);
}

async function main() {
  for (const bundle of BUNDLES) {
    await buildBundle(bundle);
  }
  console.log(`[build-renderer] Completed (${BUNDLES.length} bundles)`);
}

module.exports = { BUNDLES, bundleOptions, appVersion };

if (require.main === module) {
  main().catch((err) => {
    console.error('[build-renderer] Failed:', err);
    process.exit(1);
  });
}
