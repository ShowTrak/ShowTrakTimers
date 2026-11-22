// `npm start`: build once, then rebuild only what an edit touches, so a CSS
// tweak reloads the window instead of restarting the app (and with it every
// running timer). shared/scripts/dev.js runs the watchers, as for ShowTrak
// Server; this names Timers' renderer programs and its asset folders, the Web
// Dashboard's page included.
//
// `npm start -- --no-app` builds and watches without launching Electron, for
// when another instance already holds the app's single-instance lock.
const path = require('node:path');

require('../shared/scripts/dev').main({
  root: path.resolve(__dirname, '..'),
  renderer: require('./build-renderer'),
  rendererTsconfigs: [
    'tsconfig.renderer.json',
    'tsconfig.preloader.json',
    'tsconfig.service-worker.json',
  ],
  assetDirs: ['src/UI', 'src/WebDashboard'],
  assetScripts: ['copy-assets.js'],
});
