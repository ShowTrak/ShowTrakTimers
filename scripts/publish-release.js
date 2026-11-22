// `npm run publish`: cut a release of this checkout (shared/scripts/publish-release.js,
// whose header describes the steps and options).
const path = require('node:path');

require('../shared/scripts/publish-release').main({ root: path.resolve(__dirname, '..') });
