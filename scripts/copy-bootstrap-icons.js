// postinstall: copies the Bootstrap Icons font and CSS from node_modules into
// src/UI/vendors/bootstrap-icons for local serving, or fails the install
// (shared/scripts/copy-bootstrap-icons.js, which says why).
const path = require('node:path');

require('../shared/scripts/copy-bootstrap-icons').main({ root: path.resolve(__dirname, '..') });
