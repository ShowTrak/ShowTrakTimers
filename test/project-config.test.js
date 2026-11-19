const test = require('node:test');
const assert = require('node:assert/strict');

// Project configuration: forge.config.js (what gets packaged, and the names a
// 1.x install updates from), package.json, and the build scripts' outputs.
// Nothing here runs a build; the config files are required (forge.config.js
// with process.platform swapped, since it branches on it at load time) or read
// as text.
//
// The mistakes guarded against all ship silently: a renamed Windows executable
// orphans every 1.x Start Menu shortcut, a changed Squirrel id installs 2.0
// beside 1.x instead of over it, and an ignore pattern that is one character too
// greedy packages an app with no main process.
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, readText, walkFiles } = require('./helpers/ui-source');
const { ParseVersion } = require('@showtrak/protocol/runtime');
const Package = require('../package.json');

const FORGE_CONFIG = path.join(ROOT, 'forge.config.js');
const SIGNING_ENV = [
  'APPLE_SIGN_IDENTITY',
  'APPLE_KEYCHAIN_PATH',
  'APPLE_API_KEY_PATH',
  'APPLE_API_KEY_ID',
  'APPLE_API_ISSUER_ID',
];

/** Load forge.config.js as it would be on `Platform`, with only `Env` signing vars set. */
function loadForgeConfig(Platform, Env = {}) {
  const Descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  const SavedEnv = Object.fromEntries(SIGNING_ENV.map((Name) => [Name, process.env[Name]]));
  for (const Name of SIGNING_ENV) {
    if (Name in Env) process.env[Name] = Env[Name];
    else delete process.env[Name];
  }
  Object.defineProperty(process, 'platform', { ...Descriptor, value: Platform });
  delete require.cache[FORGE_CONFIG];
  try {
    return require(FORGE_CONFIG);
  } finally {
    Object.defineProperty(process, 'platform', Descriptor);
    delete require.cache[FORGE_CONFIG];
    for (const [Name, Value] of Object.entries(SavedEnv)) {
      if (Value === undefined) delete process.env[Name];
      else process.env[Name] = Value;
    }
  }
}

function isIgnored(Config, AppPath) {
  return Config.packagerConfig.ignore.some((Pattern) => Pattern.test(AppPath));
}

// --- forge.config.js: names --------------------------------------------------------

test("the Windows build keeps 1.x's executable name, so upgraded shortcuts still work", () => {
  // No executableName on win32: Packager falls back to productName, giving the
  // "ShowTrak Timers.exe" that 1.x's Start Menu and Desktop shortcuts point at.
  const Config = loadForgeConfig('win32');
  assert.equal('executableName' in Config.packagerConfig, false);
});

test('macOS and Linux builds use a stable lower-case binary name the Linux makers can find', () => {
  for (const Platform of ['darwin', 'linux']) {
    assert.equal(
      loadForgeConfig(Platform).packagerConfig.executableName,
      'showtrak-timers',
      Platform
    );
  }
  const Config = loadForgeConfig('linux');
  for (const Maker of Config.makers.filter((M) => /maker-(deb|rpm)$/.test(M.name))) {
    assert.equal(Maker.config.options.bin, 'showtrak-timers', Maker.name);
  }
});

test("the Squirrel package id is 1.x's, so installed copies update in place", () => {
  // 1.x had no explicit name: Squirrel derived it from the package name.
  const Squirrel = loadForgeConfig('win32').makers.find(
    (M) => M.name === '@electron-forge/maker-squirrel'
  );
  assert.ok(Squirrel, 'no Squirrel maker');
  assert.equal(Squirrel.config.name, 'showtrak_timers');
  assert.equal(Squirrel.config.name, Package.name.replace(/-/g, '_'));
  assert.deepEqual(Squirrel.platforms, ['win32']);
  assert.ok(fs.existsSync(path.join(ROOT, Squirrel.config.setupIcon)), 'setup icon missing');
});

test('every platform the app ships on has a maker', () => {
  const Config = loadForgeConfig('linux');
  const Platforms = new Set(Config.makers.flatMap((M) => M.platforms));
  for (const Platform of ['win32', 'darwin', 'linux']) assert.ok(Platforms.has(Platform), Platform);
});

test('the app icon exists in every format the packager looks for', () => {
  const Icon = loadForgeConfig('linux').packagerConfig.icon;
  for (const Ext of ['.icns', '.ico', '.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, `${Icon}${Ext}`)), `${Icon}${Ext}`);
  }
});

test('macOS is told why the app wants the local network', () => {
  const Info = loadForgeConfig('darwin').packagerConfig.extendInfo;
  assert.match(Info.NSLocalNetworkUsageDescription, /OSC/);
  assert.match(Info.NSLocalNetworkUsageDescription, /Web Dashboard/);
});

test('macOS opens .showtraktimers files in ShowTrak Timers', () => {
  const Info = loadForgeConfig('darwin').packagerConfig.extendInfo;
  const [Type] = Info.UTExportedTypeDeclarations;
  assert.deepEqual(Type.UTTypeTagSpecification['public.filename-extension'], ['showtraktimers']);
  assert.deepEqual(Info.CFBundleDocumentTypes[0].LSItemContentTypes, [Type.UTTypeIdentifier]);
  assert.equal(Info.CFBundleDocumentTypes[0].LSHandlerRank, 'Owner');
});

test('signing and notarisation switch on only with their credentials', () => {
  const Unsigned = loadForgeConfig('darwin').packagerConfig;
  assert.equal('osxSign' in Unsigned, false);
  assert.equal('osxNotarize' in Unsigned, false);

  const Signed = loadForgeConfig('darwin', {
    APPLE_SIGN_IDENTITY: 'Developer ID Application: Test',
  }).packagerConfig;
  assert.equal(Signed.osxSign.identity, 'Developer ID Application: Test');
  assert.equal(Signed.osxSign.hardenedRuntime, true);
  assert.ok(fs.existsSync(Signed.osxSign.entitlements), 'entitlements file missing');
  assert.equal('osxNotarize' in Signed, false);

  const Notarised = loadForgeConfig('darwin', {
    APPLE_SIGN_IDENTITY: 'Developer ID Application: Test',
    APPLE_API_KEY_PATH: '/tmp/key.p8',
    APPLE_API_KEY_ID: 'KEYID',
    APPLE_API_ISSUER_ID: 'ISSUER',
  }).packagerConfig;
  assert.equal(Notarised.osxNotarize.tool, 'notarytool');
});

test('the Electron fuses lock the packaged app down', () => {
  const { FuseV1Options } = require('@electron/fuses');
  const Fuses = loadForgeConfig('linux').plugins.find((P) => P && P.name === 'fuses');
  assert.ok(Fuses, 'no fuses plugin');
  const Config = Fuses.fusesConfig;
  assert.equal(Config[FuseV1Options.RunAsNode], false);
  assert.equal(Config[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
  assert.equal(Config[FuseV1Options.EnableNodeCliInspectArguments], false);
  assert.equal(Config[FuseV1Options.EnableCookieEncryption], true);
  assert.equal(Config[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], true);
  assert.equal(Config[FuseV1Options.OnlyLoadAppFromAsar], true);
});

// --- forge.config.js: what is packaged ------------------------------------------------

test('sources, tests and build tooling stay out of the package', () => {
  const Config = loadForgeConfig('linux');
  assert.equal(Config.packagerConfig.asar, true);
  for (const AppPath of [
    '/src',
    '/src/UI/index.html',
    '/test',
    '/test/ui-markup.test.js',
    '/test-support/anything.js',
    '/shared',
    '/shared/package.json',
    '/dist-test',
    '/dist-test/UI/js/app/utils.js',
    '/scripts/build-css.js',
    '/coverage/lcov.info',
    '/.github/workflows/ci.yml',
    '/tsconfig.json',
    '/tsconfig.renderer.test.json',
    '/eslint.config.mjs',
    '/package-lock.json',
    '/README.md',
    // The per-file main-process build is for the tests; the app runs the bundle.
    '/dist/main.js',
    '/dist/entry.js',
    '/dist/common/timers.js',
    '/dist/UI/css/parts/10-timers.css',
    '/dist/UI/vendors/bootstrap-icons/font/bootstrap-icons.json',
    '/dist/UI/vendors/bootstrap-icons/font/bootstrap-icons.scss',
    '/dist/UI/vendors/bootstrap-icons/font/bootstrap-icons.css',
    '/dist/Modules/DB/index.js',
    '/dist/main/app-updater.js',
    '/dist/main.bundle.js.map',
    // Only package.json and dist/ of the protocol package are needed at runtime.
    '/node_modules/@showtrak/protocol/src/index.d.ts',
    '/node_modules/@showtrak/protocol/tsconfig.json',
    '/node_modules/@showtrak/protocol/README.md',
  ]) {
    assert.equal(isIgnored(Config, AppPath), true, `${AppPath} would be packaged`);
  }
});

test('everything the app loads at runtime is packaged', () => {
  const Config = loadForgeConfig('linux');
  for (const AppPath of [
    '/package.json',
    '/LICENSE', // read by the About modal
    '/dist',
    '/dist/boot.js',
    '/dist/main.bundle.js',
    '/dist/bridge_main.js',
    '/dist/bridge_preloader.js',
    '/dist/UI/index.html',
    '/dist/UI/preloader.html',
    '/dist/UI/js/app/bundle.js',
    '/dist/UI/css/main.css',
    '/dist/UI/vendors/bootstrap-icons/font/bootstrap-icons.min.css',
    '/dist/UI/vendors/bootstrap-icons/font/fonts/bootstrap-icons.woff2',
    '/dist/UI/audio/alert_1.m4a',
    '/dist/WebDashboard/index.html',
    '/dist/WebDashboard/dashboard.js',
    '/node_modules/express/index.js',
    '/node_modules/sqlite3/package.json',
    '/node_modules/@showtrak/protocol',
    '/node_modules/@showtrak/protocol/package.json',
    '/node_modules/@showtrak/protocol/dist/runtime/index.js',
    // Anchored patterns must not reach inside node_modules.
    '/node_modules/some-lib/src/index.js',
    '/node_modules/some-lib/test/fixture.js',
  ]) {
    assert.equal(isIgnored(Config, AppPath), false, `${AppPath} would be left out`);
  }
});

test('the files loaded outside the main bundle need nothing the package leaves out', () => {
  // boot.js loads the bundle; the preloads are sandboxed and may only require electron.
  const Requires = (File) =>
    [
      ...fs
        .readFileSync(path.join(ROOT, 'dist', File), 'utf8')
        .matchAll(/require\(['"]([^'"]+)['"]\)/g),
    ].map((M) => M[1]);
  for (const File of ['bridge_main.js', 'bridge_preloader.js']) {
    assert.deepEqual([...new Set(Requires(File))], ['electron'], File);
  }
  for (const Spec of Requires('boot.js')) {
    assert.ok(
      Spec.startsWith('electron') || Spec.startsWith('node:') || Spec === './main.bundle.js',
      Spec
    );
  }
});

test('packaging hooks trim Chromium locales and verify the staged app', () => {
  const { hooks } = loadForgeConfig('linux');
  assert.equal(typeof hooks.packageAfterExtract, 'function');
  assert.equal(typeof hooks.packageAfterCopy, 'function');
});

// --- package.json -----------------------------------------------------------------------

test('package.json boots from dist/boot.js under the ShowTrak Timers name', () => {
  assert.equal(Package.main, 'dist/boot.js');
  assert.equal(Package.productName, 'ShowTrak Timers');
  assert.equal(Package.name, 'showtrak-timers');
  // boot.js loads the main bundle that build-main.js writes.
  const { MAIN_BUNDLE } = require('../scripts/build-main.js');
  assert.equal(path.relative(path.join(ROOT, 'dist'), MAIN_BUNDLE), 'main.bundle.js');
  assert.match(readText('src', 'boot.ts'), /require\('\.\/main\.bundle\.js'\)/);
});

test('the version is valid semver that the updater can compare', () => {
  assert.match(
    Package.version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/
  );
  assert.ok(ParseVersion(Package.version), 'the update-channel parser rejects the version');
});

test('the scripts CI runs exist', () => {
  for (const Script of ['lint', 'format:check', 'typecheck', 'test', 'build', 'make']) {
    assert.equal(typeof Package.scripts[Script], 'string', Script);
  }
});

test('the release repository matches package.json and the GitHub link', () => {
  const Constants = readText('src', 'Modules', 'Config', 'constants.ts');
  const Owner = /RELEASE_OWNER = '([^']+)'/.exec(Constants)[1];
  const Repo = /RELEASE_REPO = '([^']+)'/.exec(Constants)[1];
  assert.equal(Package.repository.url, `https://github.com/${Owner}/${Repo}.git`);
  assert.match(Constants, new RegExp(`GITHUB_URL = 'https://github.com/${Owner}/${Repo}'`));
});

test('the Node version agrees between .nvmrc, engines and CI', () => {
  const Nvmrc = readText('.nvmrc').trim();
  assert.match(Nvmrc, /^\d+$/);
  assert.equal(Package.engines.node, `>=${Nvmrc}.0.0`);
  for (const Workflow of ['ci.yml', 'build-and-draft-release.yml']) {
    const Versions = [
      ...readText('.github', 'workflows', Workflow).matchAll(/node-version:\s*(\S+)/g),
    ].map((M) => M[1]);
    assert.ok(Versions.length > 0, Workflow);
    for (const Version of Versions) assert.equal(Version, Nvmrc, Workflow);
  }
});

/** Every non-type import/require specifier in the app's TypeScript and JS sources. */
function sourceSpecifiers() {
  const Specs = new Set();
  const Files = walkFiles('src', new Set(['vendors'])).filter((File) => /\.(ts|js)$/.test(File));
  for (const File of Files) {
    const Text = readText(File);
    for (const M of Text.matchAll(/^\s*import\s+(?!type\b)[^'"]*?from\s+'([^']+)'/gm))
      Specs.add(M[1]);
    for (const M of Text.matchAll(/require\(\s*'([^']+)'\s*\)/g)) Specs.add(M[1]);
  }
  return Specs;
}

test('every runtime dependency is actually used by the app', () => {
  const Specs = [...sourceSpecifiers()];
  const Unused = Object.keys(Package.dependencies).filter(
    (Name) => !Specs.some((Spec) => Spec === Name || Spec.startsWith(`${Name}/`))
  );
  assert.deepEqual(Unused, []);
});

test('the packages the main bundle leaves external are runtime dependencies', () => {
  // build-main.js: externals load from node_modules at runtime, and packaging
  // drops devDependencies, so a required external must be a dependency.
  const { mainBundleOptions } = require('../scripts/build-main.js');
  const Optional = new Set(['bufferutil', 'utf-8-validate']); // ws's optional speed-ups
  const Required = mainBundleOptions().external.filter(
    (Name) => !/^electron(\/|$)/.test(Name) && !Optional.has(Name)
  );
  assert.ok(Required.includes('sqlite3'));
  assert.deepEqual(
    Required.filter((Name) => !(Name in Package.dependencies)),
    []
  );
});

// --- scripts/build-css.js ---------------------------------------------------------------

test('main.css is the stylesheet parts concatenated in file-name order', () => {
  // build-css.js writes src/UI/css/main.css from src/UI/css/parts/*.css, sorted
  // by name (so the numeric prefixes decide the cascade). Read-only check of its
  // output; running the script would write into src/.
  const PartsDir = path.join(ROOT, 'src', 'UI', 'css', 'parts');
  const Parts = fs
    .readdirSync(PartsDir)
    .filter((Name) => Name.endsWith('.css'))
    .sort();
  assert.ok(Parts.length > 1);
  const Expected = Parts.map((Name) => fs.readFileSync(path.join(PartsDir, Name), 'utf8')).join('');
  const Actual = fs.readFileSync(path.join(ROOT, 'src', 'UI', 'css', 'main.css'), 'utf8');
  // Normalise line endings only, so a CRLF checkout compares like the others.
  assert.equal(Actual.replace(/\r\n/g, '\n'), Expected.replace(/\r\n/g, '\n'));
  assert.match(readText('scripts', 'build-css.js'), /\.sort\(\)/);
});
