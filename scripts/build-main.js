// Bundles the Electron main process into one file: dist/main.bundle.js.
//
// tsc (tsconfig.json) compiles the main process one file per module into dist/,
// which is what the test suite loads. The app itself boots from one bundle
// instead, the same arrangement as ShowTrak Server: dist/boot.js (src/boot.ts)
// enables V8's compile cache and then requires this bundle, so the whole main
// process is parsed once and cached rather than resolved file by file at launch.
//
// The input is tsc's CommonJS OUTPUT (dist/entry.js, which requires dist/main.js
// unless it is a Squirrel install run), not the TypeScript sources: tsc emits
// each `import` as a require() at the point it appears, and main.ts depends on
// that order (app-data folders and the process guards are set
// up before the modules that open the database or bind sockets are loaded).
// Bundled as ES modules, esbuild would hoist every import above that code.
//
// Kept external (loaded from node_modules at runtime):
//   electron                  provided by the runtime
//   sqlite3                   native addon (unpacked from the asar by
//                             plugin-auto-unpack-natives)
//   bufferutil, utf-8-validate optional native speed-ups ws tries to load
//   electron-updater          large and only ever required lazily, on the
//                             first update check of a packaged build
//
// An external is resolved from dist/ at runtime, so it must be a top-level
// package in node_modules; main() checks the required ones resolve.
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'dist', 'entry.js');
const OUTFILE = path.join(ROOT, 'dist', 'main.bundle.js');

const EXTERNAL = [
  'electron',
  'electron/*',
  'sqlite3',
  'bufferutil',
  'utf-8-validate',
  'electron-updater',
];
// The externals the app depends on (the rest are the runtime's or optional).
const REQUIRED_EXTERNALS = ['sqlite3', 'electron-updater'];

// Socket.IO serves its browser client (/socket.io/socket.io.js, which the Web
// Dashboard loads) from `path.join(__dirname, "../client-dist/")`.
// Inside the bundle __dirname is dist/, so point that one file's __dirname back
// at the installed package, resolved at runtime.
const socketIoClientDist = {
  name: 'socket.io-client-dist',
  setup(build) {
    build.onLoad({ filter: /[\\/]socket\.io[\\/]dist[\\/]index\.js$/ }, async (args) => {
      const Source = await fs.promises.readFile(args.path, 'utf8');
      if (!Source.includes('__dirname')) return undefined;
      return {
        contents:
          'var __socketIoDistDir = require("path").dirname(require.resolve("socket.io"));\n' +
          Source.replace(/\b__dirname\b/g, '__socketIoDistDir'),
        loader: 'js',
        resolveDir: path.dirname(args.path),
      };
    });
  },
};

// esbuild options for the bundle. Shared with scripts/dev.js, whose rebuilds
// must produce exactly what a full build does.
function mainBundleOptions() {
  return {
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    external: EXTERNAL,
    // Lets modules that resolve files relative to themselves tell the bundle
    // (where every module's __dirname is dist/) from the per-file build. See
    // src/Modules/Config/dist-root.ts.
    define: { __SHOWTRAK_BUNDLED__: 'true' },
    // Not minified: stack traces in the log files stay readable. The source map
    // chains through tsc's maps back to the TypeScript.
    sourcemap: 'linked',
    keepNames: true,
    legalComments: 'none',
    logLevel: 'warning',
    // The socket.io plugin's require.resolve is meant for runtime.
    logOverride: { 'require-resolve-not-external': 'silent' },
    plugins: [socketIoClientDist],
  };
}

async function main() {
  for (const Name of REQUIRED_EXTERNALS) {
    try {
      require.resolve(Name, { paths: [path.dirname(OUTFILE)] });
    } catch {
      throw new Error(`External "${Name}" does not resolve from dist/; it must be bundled`);
    }
  }
  const StartedAt = Date.now();
  await esbuild.build(mainBundleOptions());
  const Size = fs.statSync(OUTFILE).size;
  console.log(
    `[build-main] Bundled the main process -> ${path.relative(ROOT, OUTFILE)} ` +
      `(${(Size / 1024 / 1024).toFixed(1)} MB, ${Date.now() - StartedAt} ms)`
  );
}

module.exports = { mainBundleOptions, MAIN_BUNDLE: OUTFILE };

if (require.main === module) {
  main().catch((err) => {
    console.error('[build-main] Failed:', err);
    process.exit(1);
  });
}
