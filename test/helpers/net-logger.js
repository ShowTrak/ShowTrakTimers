// Test helper: a stand-in for src/Modules/Logger that records every line.
//
// Install it with installModuleMocks({ match: matchesModule('/Logger'), value:
// logger.module }) so a module's warnings and errors can be asserted on (and
// nothing is written to the log folder). `flushLogWrites` resolves at once and
// is recorded too, so shutdown ordering can be checked.
function createLoggerStub() {
  const entries = [];
  const flushes = [];

  function CreateLogger(Alias) {
    const record =
      (level) =>
      (...args) => {
        entries.push({
          alias: Alias,
          level,
          args,
          text: args.map((A) => (A instanceof Error ? A.message : String(A))).join(' '),
        });
      };
    const logger = {
      log: record('log'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      success: record('success'),
      debug: record('debug'),
      trace: record('trace'),
      silent: record('silent'),
      database: record('database'),
      databaseError: record('databaseError'),
    };
    logger.child = (suffix) => CreateLogger(`${Alias}:${suffix}`);
    return logger;
  }

  return {
    entries,
    flushes,
    module: {
      CreateLogger,
      configure: () => {},
      flushLogWrites: () => {
        flushes.push(entries.length);
        return Promise.resolve();
      },
    },
    /** The text of every line logged at `level` (all levels when omitted). */
    lines(level) {
      return entries.filter((E) => !level || E.level === level).map((E) => E.text);
    },
    clear() {
      entries.length = 0;
      flushes.length = 0;
    },
  };
}

module.exports = { createLoggerStub };
