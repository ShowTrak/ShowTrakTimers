const test = require('node:test');
const assert = require('node:assert/strict');

// The splash window's script (src/UI/preloader.ts), run as it ships: the
// esbuild bundle dist/UI/preloader.js, in a VM context whose window.API is a
// stub of the splash preload's (src/bridge_preloader.ts) and whose document has
// only the footer.
//
// The footer names the app and its version, and falls back to the bare name
// whenever the config is not there to read: the splash must never show
// "undefined" or stay blank while the main window loads.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readText, startTags } = require('./helpers/ui-source');
const { flush } = require('./helpers/net-util');
const { BUNDLES } = require('../scripts/build-renderer.js');

const BUNDLE = path.join(__dirname, '..', 'dist', 'UI', 'preloader.js');

/** Run the splash script with GetConfig answering `GetConfig()`; the footer's text. */
async function footerFor(GetConfig) {
  const Footer = { innerText: '' };
  const Lookups = [];
  vm.runInNewContext(
    fs.readFileSync(BUNDLE, 'utf8'),
    {
      window: { API: { GetConfig } },
      document: {
        getElementById(ID) {
          Lookups.push(ID);
          return ID === 'FOOTER' ? Footer : null;
        },
      },
    },
    { filename: BUNDLE }
  );
  await flush();
  assert.deepEqual([...new Set(Lookups)], ['FOOTER']);
  return Footer.innerText;
}

test('the splash footer names the app and its version', async () => {
  const Text = await footerFor(async () => ({
    Application: { Name: 'ShowTrak Timers', Version: '2.0.2' },
    Platform: 'darwin',
    IsPackaged: true,
  }));
  assert.equal(Text, 'ShowTrak Timers v2.0.2');
});

test('the splash footer falls back to the app name without a config to read', async () => {
  const Cases = {
    'a rejected call': async () => {
      throw new Error('No handler registered for Config:Get');
    },
    'no config': async () => null,
    'no Application': async () => ({ Platform: 'linux' }),
    'no version': async () => ({ Application: { Name: 'ShowTrak Timers', Version: '' } }),
    'no name': async () => ({ Application: { Version: '2.0.2' } }),
  };
  for (const [Label, GetConfig] of Object.entries(Cases)) {
    assert.equal(await footerFor(GetConfig), 'ShowTrak Timers', Label);
  }
});

test('preloader.html loads the bundle the build writes, and no stale copy is left in src', () => {
  const Bundle = BUNDLES.find((B) => B.entry.endsWith(path.join('UI', 'preloader.ts')));
  assert.ok(Bundle, 'scripts/build-renderer.js does not bundle src/UI/preloader.ts');
  assert.equal(Bundle.outfile, BUNDLE);
  const Scripts = startTags(readText('src', 'UI', 'preloader.html'))
    .filter((Tag) => Tag.Name === 'script')
    .map((Tag) => Tag.Attrs.src);
  assert.deepEqual(Scripts, ['./preloader.js']);
  // copy-assets would skip it anyway (see scripts/copy-assets.js); a JavaScript
  // copy beside the TypeScript is only ever a leftover.
  assert.equal(fs.existsSync(path.join(__dirname, '..', 'src', 'UI', 'preloader.js')), false);
});
