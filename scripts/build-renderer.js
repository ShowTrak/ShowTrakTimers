// Bundles the TypeScript renderer sources (desktop UI + Web Dashboard) with
// esbuild.
//
// The Node-side code is compiled by `tsc` (tsconfig.json) into dist/. The
// renderer runs in a browser/Electron-renderer context and is authored as ES
// modules that are bundled here into a single classic script per surface:
//   src/UI/js/app/main.ts            -> dist/UI/js/app/bundle.js        (Electron renderer)
//   src/UI/js/app/dashboard-main.ts  -> dist/WebDashboard/dashboard.js  (served Web Dashboard)
//
// Both entries share the timer formatting/view modules under js/app/lib, so the
// desktop tiles and the dashboard can never disagree about what a timer shows.
//
// Type-checking is performed separately by `tsc --noEmit` against
// tsconfig.renderer.json; esbuild only transpiles+bundles.
//
// Vendor libraries (jQuery, Bootstrap, Howler, socket.io) stay
// as external <script> globals for offline use, so they are NOT imported/bundled.
const esbuild = require('esbuild');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/** @type {Array<{name: string, entry: string, outfile: string}>} */
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
];

// esbuild options for one bundle. Shared with scripts/dev.js, whose watch mode
// must produce exactly what a full build does.
function bundleOptions({ entry, outfile }) {
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
  };
}

async function buildBundle(bundle) {
  await esbuild.build(bundleOptions(bundle));
  console.log(`[build-renderer] Bundled ${bundle.name} -> ${path.relative(ROOT, bundle.outfile)}`);
}

async function main() {
  for (const bundle of BUNDLES) {
    await buildBundle(bundle);
  }
  console.log(`[build-renderer] Completed (${BUNDLES.length} bundles)`);
}

module.exports = { BUNDLES, bundleOptions };

if (require.main === module) {
  main().catch((err) => {
    console.error('[build-renderer] Failed:', err);
    process.exit(1);
  });
}
