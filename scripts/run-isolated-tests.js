// `npm test`: run the suite with HOME (and the Windows/XDG equivalents) in an
// empty temp folder, so no test can read or migrate a real ShowTrak Timers
// database (shared/scripts/run-isolated-tests.js). Extra arguments go to
// `node --test`: `npm test -- test/show-file.test.js`.
//
// Not named test-*.js: that matches node --test's default file pattern.
require('../shared/scripts/run-isolated-tests').main();
