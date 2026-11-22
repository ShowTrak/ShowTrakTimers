// Electron Forge configuration. Forge loads this TypeScript file itself (through
// jiti, which runs it as CommonJS: __dirname and require are there as in a .js
// config); tsconfig.tooling.json type-checks it.
import type { ForgeConfig, ForgePackagerOptions } from '@electron-forge/shared-types';
import { FusesPlugin } from '@electron-forge/plugin-fuses';
import { FuseV1Options, FuseVersion } from '@electron/fuses';
import path from 'node:path';
import fs from 'node:fs';

const appleSignIdentity = process.env.APPLE_SIGN_IDENTITY;
const appleSigningKeychain = process.env.APPLE_KEYCHAIN_PATH;
const shouldSignMac = Boolean(appleSignIdentity);
const shouldNotarizeMac =
  shouldSignMac &&
  Boolean(
    process.env.APPLE_API_KEY_PATH &&
    process.env.APPLE_API_KEY_ID &&
    process.env.APPLE_API_ISSUER_ID
  );

// Some of the signing and notarisation options below are from older versions
// of @electron/osx-sign and @electron/notarize, and the versions under Forge 8
// do not read them: osx-sign 2 takes hardenedRuntime and entitlements per file
// (through optionsForFile) and has no entitlementsInherit or gatekeeperAssess,
// and notarize 3 has no `tool` (notarytool is the only tool it has). They are
// kept as they were; these types say which they are.
type OsxSignOptions = Exclude<ForgePackagerOptions['osxSign'], true | undefined> & {
  hardenedRuntime: boolean;
  entitlements: string;
  entitlementsInherit: string;
  gatekeeperAssess: boolean;
};
type OsxNotarizeOptions = NonNullable<ForgePackagerOptions['osxNotarize']> & {
  tool: 'notarytool';
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    // Copy the *contents* of symlinks rather than the links themselves.
    //
    // node_modules/@showtrak/protocol is npm's link for the `file:./shared`
    // dependency. Left as a link, Electron Packager hands it to @electron/asar,
    // which stores a `link` entry -- and on Windows npm creates a *junction*
    // whose readlink is an absolute path, so the recorded target came out as the
    // nonsense `node_modules\@showtrak\D:\a\ShowTrakServer\ShowTrakServer\shared`
    // (ShowTrak Server 3.16.2 shipped exactly that). Every
    // `require('@showtrak/protocol/runtime')` then threw MODULE_NOT_FOUND on
    // boot, while macOS and Linux worked because their relative symlinks
    // happened to resolve inside the archive.
    //
    // Dereferencing sidesteps the platform difference entirely: the package
    // lands in the asar as a real directory on all three targets.
    derefSymlinks: true,
    // Keep the asar lean: only `dist/`, production `node_modules`, and
    // package.json are needed at runtime. Without an ignore list, Electron
    // Packager bundles the entire project tree (src/, coverage/, test/, source
    // maps, dotfiles), roughly doubling the asar. Top-level dirs are anchored
    // with `^/` so we don't accidentally match paths inside node_modules.
    ignore: [
      // Source & build inputs: assets are served from dist/ (see
      // src/Modules/Config/dist-root.ts); the app icon is read from disk at
      // package time, not from the asar.
      /^\/src($|\/)/,
      // shared/ is the @showtrak/protocol submodule. With derefSymlinks the
      // package ships as real files under node_modules/@showtrak/protocol, so
      // this second copy at the top level is dead weight; drop it wholesale.
      /^\/shared($|\/)/,
      // ...and inside the dereferenced copy, ship exactly what Node needs to
      // resolve `@showtrak/protocol/runtime`: package.json for the exports map
      // and the compiled dist/. The .d.ts sources, tsconfigs, LICENSE and
      // README are build-time only.
      /^\/node_modules\/@showtrak\/protocol\/(?!dist(\/|$)|package\.json$)/,
      /^\/scripts($|\/)/,
      /^\/build($|\/)/,
      // Tests & coverage reports. dist-test/ is the test-only per-file compile
      // of the renderer (tsconfig.renderer.test.json); the app runs the esbuild
      // bundle in dist/, so this must never ship.
      /^\/test($|\/)/,
      /^\/test-support($|\/)/,
      /^\/dist-test($|\/)/,
      /^\/coverage($|\/)/,
      // Repo/tooling directories.
      /^\/\.github($|\/)/,
      /^\/\.husky($|\/)/,
      /^\/\.vscode($|\/)/,
      /^\/\.claude($|\/)/,
      // Config & docs.
      /^\/tsconfig.*\.json$/,
      /^\/eslint\.config\.ts$/,
      /^\/\.prettier/,
      /^\/\.gitignore$/,
      /^\/(README|TODO|DEVELOPMENT)\.md$/,
      /^\/package-lock\.json$/,
      // The main process ships as one bundle, dist/main.bundle.js, loaded by
      // dist/boot.js (scripts/build-main.js). The per-file tsc output it was
      // built from is for the test suite and is never loaded by the app.
      /^\/dist\/(Modules|main|types|common)($|\/)/,
      // The CSS parts are concatenated into dist/UI/css/main.css, which is all
      // either page loads; of Bootstrap Icons only the minified CSS and the
      // fonts are used.
      /^\/dist\/UI\/css\/parts($|\/)/,
      /^\/dist\/UI\/vendors\/bootstrap-icons\/font\/bootstrap-icons\.(json|scss|css)$/,
      /^\/dist\/(entry|main)\.js$/,
      // Source maps are debug-only; strip from release builds.
      /\.map$/,
      // Cruft.
      /\.DS_Store$/,
    ],
    // A stable binary name so the Linux makers can find it for deb/rpm. Not on
    // Windows: 1.x shipped "ShowTrak Timers.exe", and Squirrel's Start Menu and
    // Desktop shortcuts point at that name, so renaming it would leave every
    // upgraded install with shortcuts to a file that no longer exists.
    ...(process.platform === 'win32' ? {} : { executableName: 'showtrak-timers' }),
    // Use extensionless base path so Electron Packager can resolve
    // platform-specific icon formats (.icns on macOS, .ico on Windows).
    icon: './src/images/icon',
    // macOS Local Network privacy: the OSC listener and the Web Dashboard serve
    // devices on the local network. This string is what the permission prompt
    // shows if macOS asks.
    extendInfo: {
      NSLocalNetworkUsageDescription:
        'ShowTrak Timers needs local network access to receive OSC commands and to serve the Web Dashboard to devices on your network.',
      // .showtraktimers show files open in ShowTrak Timers from Finder
      // (double-click, Open With, dropping on the Dock icon). The type is
      // exported here, as ShowTrak Timers owns the format; the app receives the
      // file through 'open-file' (src/main/file-associations.ts). Windows
      // registers the same association from the Squirrel install hooks there.
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'ShowTrak Timers Show File',
          CFBundleTypeRole: 'Editor',
          LSHandlerRank: 'Owner',
          LSItemContentTypes: ['uk.co.showtrak.timers.show'],
        },
      ],
      UTExportedTypeDeclarations: [
        {
          UTTypeIdentifier: 'uk.co.showtrak.timers.show',
          UTTypeDescription: 'ShowTrak Timers Show File',
          UTTypeConformsTo: ['public.data'],
          UTTypeTagSpecification: {
            'public.filename-extension': ['showtraktimers'],
          },
        },
      ],
    },
    ...(shouldSignMac
      ? {
          osxSign: {
            identity: appleSignIdentity,
            ...(appleSigningKeychain ? { keychain: appleSigningKeychain } : {}),
            hardenedRuntime: true,
            entitlements: path.resolve(__dirname, 'build/entitlements.mac.plist'),
            entitlementsInherit: path.resolve(__dirname, 'build/entitlements.mac.plist'),
            gatekeeperAssess: false,
            strictVerify: true,
          } as OsxSignOptions,
        }
      : {}),
    ...(shouldNotarizeMac
      ? {
          osxNotarize: {
            tool: 'notarytool',
            // Set, all three: shouldNotarizeMac checked them.
            appleApiKey: process.env.APPLE_API_KEY_PATH!,
            appleApiKeyId: process.env.APPLE_API_KEY_ID!,
            appleApiIssuer: process.env.APPLE_API_ISSUER_ID!,
          } as OsxNotarizeOptions,
        }
      : {}),
  },
  // On ARM64 Linux (the Raspberry Pi build) sqlite3 is compiled against
  // Electron's headers rather than downloaded: its prebuilt linux-arm64 binary
  // is linked against glibc 2.38, and Raspberry Pi OS 12 (Bookworm) has 2.36, so
  // the app would install there and then fail to open its database. The release
  // workflow builds ARM64 on ubuntu-22.04-arm (glibc 2.35), and
  // scripts/check-linux-packages.sh fails the release if any binary in the
  // package needs more than 2.36. Elsewhere the prebuilt binary is kept.
  rebuildConfig:
    process.platform === 'linux' && process.arch === 'arm64' ? { buildFromSource: true } : {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        // The Squirrel package id. Kept from 1.x (it is derived from the old
        // package name, showtrak-timers) so installed 1.x copies update in place
        // rather than installing a second app beside themselves.
        name: 'showtrak_timers',
        // An URL to an ICO file to use as the application icon (displayed in Control Panel > Programs and Features).
        iconUrl: 'https://tkw.bz/img/ShowTrak.ico',
        // The ICO file to use as the icon for the generated Setup.exe
        setupIcon: './src/images/icon.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
      config: {},
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['linux'],
      config: {},
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
      config: {
        options: {
          bin: 'showtrak-timers',
        },
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
      config: {
        options: {
          bin: 'showtrak-timers',
        },
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
  hooks: {
    // Drop Chromium's UI translations (~45 MB) before the app is copied in and
    // signed; the UI is English and Chromium falls back to en-US. See
    // scripts/trim-electron-locales.js.
    packageAfterExtract: async (_forgeConfig, buildPath) => {
      // scripts/ stays JavaScript, with no type declarations; this is its shape.
      const { trimElectronLocales } = require('./scripts/trim-electron-locales') as {
        trimElectronLocales(buildPath: string): number;
      };
      const removed = trimElectronLocales(buildPath);
      console.log(`[forge] Removed ${removed} unused Chromium locale pack(s)`);
    },
    // When sqlite3 is compiled (ARM64 Linux, see rebuildConfig), node-gyp leaves
    // its working files beside the addon: the SQLite source, object files and
    // two more copies of the binary, about 25 MB the app never reads. Keep only
    // build/Release/node_sqlite3.node, which is what sqlite3 loads and all that
    // a downloaded prebuilt binary brings. Runs after the rebuild, before the
    // asar is made.
    packageAfterPrune: async (_forgeConfig, buildPath) => {
      const sqlite3 = path.join(buildPath, 'node_modules', 'sqlite3');
      const release = path.join(sqlite3, 'build', 'Release');
      if (!fs.existsSync(path.join(release, 'node_sqlite3.node'))) return;
      const remove = (target: string) => fs.rmSync(target, { recursive: true, force: true });
      remove(path.join(sqlite3, 'bin'));
      for (const entry of fs.readdirSync(path.dirname(release))) {
        if (entry !== 'Release') remove(path.join(path.dirname(release), entry));
      }
      for (const entry of fs.readdirSync(release)) {
        if (entry !== 'node_sqlite3.node') remove(path.join(release, entry));
      }
    },
    // ShowTrak Server 3.16.2 shipped a Windows build whose @showtrak/protocol
    // was an unusable link (see derefSymlinks above) and nothing caught it until
    // the app failed to boot on a user's machine. The dependency resolves by bare
    // specifier, so a broken copy is invisible until runtime: assert the real
    // files are in the staged tree, on every platform, before it is sealed into
    // the asar.
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      const pkgDir = path.join(buildPath, 'node_modules', '@showtrak', 'protocol');
      // lstat, not stat: a surviving symlink is the failure we are guarding
      // against, and it would follow through to the real file on the build host.
      const linkStat = fs.lstatSync(pkgDir, { throwIfNoEntry: false });
      if (!linkStat?.isDirectory()) {
        throw new Error(
          `Packaging aborted: ${pkgDir} is ${linkStat ? 'a link, not a real directory' : 'missing'}. ` +
            'The @showtrak/protocol dependency must be dereferenced into the package.'
        );
      }
      for (const rel of [['package.json'], ['dist', 'runtime', 'index.js']]) {
        const file = path.join(pkgDir, ...rel);
        if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(
            `Packaging aborted: ${file} is missing from the staged app. ` +
              'require("@showtrak/protocol/runtime") would throw at boot.'
          );
        }
      }
      // The app boots from the main-process bundle; the per-file output is left
      // out (see `ignore`), so a missing bundle would be an app with no main
      // process at all.
      for (const rel of [
        ['dist', 'boot.js'],
        ['dist', 'main.bundle.js'],
      ]) {
        const file = path.join(buildPath, ...rel);
        if (!fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()) {
          throw new Error(
            `Packaging aborted: ${file} is missing from the staged app. ` +
              'Run `npm run build` (it bundles the main process) before packaging.'
          );
        }
      }
    },
  },
};

export default config;
