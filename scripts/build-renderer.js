// Bundles the TypeScript that runs in browsers and renderers with esbuild, one
// classic script per surface (shared/scripts/build-renderer.js builds them, as
// for ShowTrak Server):
//   src/UI/js/app/main.ts               -> dist/UI/js/app/bundle.js              (Electron renderer)
//   src/UI/js/app/dashboard-main.ts     -> dist/WebDashboard/dashboard.js        (served Web Dashboard)
//   src/UI/preloader.ts                 -> dist/UI/preloader.js                  (the splash window)
//   src/WebDashboard/service-worker.ts  -> dist/WebDashboard/service-worker.js   (the dashboard's offline shell)
//
// The first two share the timer formatting/view modules under js/app/lib, so the
// desktop tiles and the dashboard can never disagree about what a timer shows.
// Type-checking is `npm run typecheck:renderer`'s; vendor libraries (jQuery,
// Bootstrap, Howler, socket.io) stay external <script> globals.
const path = require('node:path');
const Renderer = require('../shared/scripts/build-renderer');

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

// esbuild options for one bundle; scripts/dev.js watches with the same.
const bundleOptions = (bundle) => Renderer.rendererBundleOptions(bundle, { root: ROOT });

// The version stamped into a bundle as __APP_VERSION__ (package.json's).
const appVersion = () => Renderer.appVersion(ROOT);

module.exports = { BUNDLES, bundleOptions, appVersion };

if (require.main === module) Renderer.main({ root: ROOT, bundles: BUNDLES });
