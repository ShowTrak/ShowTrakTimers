const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');
const { createLoggerStub } = require('./helpers/net-logger');
const { flush } = require('./helpers/net-util');

// Exercises src/main/shutdown.ts: the quit handshake.
//
// "Stop Accidental Shutdowns" must catch every way of closing the window in
// SHOW mode (close button, Alt+F4, Cmd+Q, the menu) with exactly one native
// prompt, and must never stand in the way of an OS shutdown or an update
// install. Cleanup (stopping OSC and the Web Dashboard, flushing the log,
// closing the database) runs in will-quit exactly once, and the app quits
// only after it has finished, even when it fails: a quit that hangs on a
// failed cleanup leaves a zombie process holding the OSC port.
//
// The real ModeManager (src/main/mode.ts) decides SHOW vs EDIT; the logger is
// replaced so the flush can be ordered against cleanup.

const logger = createLoggerStub();
const restore = installModuleMocks([{ match: matchesModule('/Logger'), value: logger.module }]);
test.after(() => restore());

const { CreateShutdownCoordinator, CLOSE_DIALOG_OPTIONS } = require('../dist/main/shutdown');
const { ModeManager } = require('../dist/main/mode');

/** A promise with its resolve/reject exposed, to hold a dialog or cleanup open. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A coordinator over recording fakes. `answers` queues ConfirmClose results. */
function coordinator({ answers = [], rendererCanConfirm = true, cleanup, deadlineMs } = {}) {
  const calls = { quit: 0, exits: [], prompts: [], rendererAsks: 0, cleanups: 0, order: [] };
  const Coordinator = CreateShutdownCoordinator({
    App: {
      quit: () => {
        calls.quit++;
        calls.order.push('quit');
      },
      exit: (Code) => {
        calls.exits.push(Code);
        calls.order.push('exit');
      },
    },
    CleanupDeadlineMs: deadlineMs,
    ConfirmClose: async (Window) => {
      calls.prompts.push(Window);
      const Answer = answers.length ? answers.shift() : false;
      return typeof Answer === 'function' ? Answer() : Answer;
    },
    Cleanup: async () => {
      calls.cleanups++;
      calls.order.push('cleanup');
      if (cleanup) await cleanup();
      calls.order.push('cleanup done');
    },
    RequestRendererConfirmation: () => {
      calls.rendererAsks++;
      return rendererCanConfirm;
    },
  });
  return { Coordinator, calls };
}

/** A close/will-quit event that records preventDefault. */
function closeEvent() {
  const Event = { prevented: 0, preventDefault: () => Event.prevented++ };
  return Event;
}

const WINDOW = { id: 'main-window' };

test.beforeEach(() => {
  ModeManager.Set('SHOW');
  logger.clear();
});

// --- Window close -------------------------------------------------------------

test('with protection off, closing the window goes straight through', async () => {
  const { Coordinator, calls } = coordinator();
  const Event = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Event);
  assert.equal(Event.prevented, 0);
  assert.equal(calls.prompts.length, 0);
  assert.equal(calls.quit, 0, 'the close itself quits the app; the coordinator need not');
});

test('protection starts off and SetProtection coerces to a boolean', () => {
  const { Coordinator } = coordinator();
  assert.equal(Coordinator.IsProtected(), false);
  Coordinator.SetProtection(1);
  assert.equal(Coordinator.IsProtected(), true);
  Coordinator.SetProtection(0);
  assert.equal(Coordinator.IsProtected(), false);
  Coordinator.SetProtection('yes');
  assert.equal(Coordinator.IsProtected(), true);
});

test('in show mode with protection on, closing asks, and Cancel keeps the app open', async () => {
  const { Coordinator, calls } = coordinator({ answers: [false, false] });
  Coordinator.SetProtection(true);

  const Event = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Event);
  assert.equal(Event.prevented, 1);
  assert.deepEqual(calls.prompts, [WINDOW], 'the prompt is parented to the closing window');
  assert.equal(calls.quit, 0);

  // Cancelling is not remembered: the next close asks again.
  const Again = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Again);
  assert.equal(Again.prevented, 1);
  assert.equal(calls.prompts.length, 2);
  assert.equal(calls.quit, 0);
});

test('confirming quits once, and the close that quit causes is not asked again', async () => {
  const { Coordinator, calls } = coordinator({ answers: [true] });
  Coordinator.SetProtection(true);

  await Coordinator.HandleWindowClose(WINDOW, closeEvent());
  assert.equal(calls.quit, 1);

  // app.quit() closes the window again; that close must go through.
  const Second = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Second);
  assert.equal(Second.prevented, 0);
  assert.equal(calls.prompts.length, 1);
  assert.equal(calls.quit, 1);
});

test('edit mode never asks', async () => {
  const { Coordinator, calls } = coordinator({ answers: [false] });
  Coordinator.SetProtection(true);
  ModeManager.Set('EDIT');
  const Event = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Event);
  assert.equal(Event.prevented, 0);
  assert.equal(calls.prompts.length, 0);
});

test('protection follows the mode live, without a restart', async () => {
  const { Coordinator, calls } = coordinator({ answers: [false] });
  Coordinator.SetProtection(true);
  ModeManager.Set('EDIT');
  await Coordinator.HandleWindowClose(WINDOW, closeEvent());
  ModeManager.Set('SHOW');
  const Event = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Event);
  assert.equal(Event.prevented, 1);
  assert.equal(calls.prompts.length, 1);

  // And turning protection off applies at once too.
  Coordinator.SetProtection(false);
  const Off = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Off);
  assert.equal(Off.prevented, 0);
});

test('concurrent close events show one prompt and quit once', async () => {
  // Cmd+Q and the close button together, or a key held down, fire several
  // closes before the first dialog is answered.
  const Answer = deferred();
  const { Coordinator, calls } = coordinator({ answers: [() => Answer.promise] });
  Coordinator.SetProtection(true);

  const Events = [closeEvent(), closeEvent(), closeEvent()];
  const Pending = Events.map((E) => Coordinator.HandleWindowClose(WINDOW, E));
  await flush();
  assert.equal(calls.prompts.length, 1);
  assert.deepEqual(
    Events.map((E) => E.prevented),
    [1, 1, 1],
    'every close is held while the prompt is up'
  );

  Answer.resolve(true);
  await Promise.all(Pending);
  assert.equal(calls.quit, 1);
});

test('after a prompt is answered, the next close can prompt again', async () => {
  const First = deferred();
  const { Coordinator, calls } = coordinator({ answers: [() => First.promise, false] });
  Coordinator.SetProtection(true);
  const Pending = Coordinator.HandleWindowClose(WINDOW, closeEvent());
  First.resolve(false);
  await Pending;
  await Coordinator.HandleWindowClose(WINDOW, closeEvent());
  assert.equal(calls.prompts.length, 2);
});

test('a dialog that fails does not wedge the prompt', async () => {
  const { Coordinator, calls } = coordinator({
    answers: [
      () => {
        throw new Error('dialog unavailable');
      },
      false,
    ],
  });
  Coordinator.SetProtection(true);
  const Event = closeEvent();
  await assert.rejects(Coordinator.HandleWindowClose(WINDOW, Event), /dialog unavailable/);
  assert.equal(Event.prevented, 1, 'a failed prompt must not let the close through');
  assert.equal(calls.quit, 0);

  await Coordinator.HandleWindowClose(WINDOW, closeEvent());
  assert.equal(calls.prompts.length, 2, 'the next close could not prompt');
});

test('the close dialog defaults to Cancel, so Enter or Esc never quits', () => {
  assert.deepEqual(CLOSE_DIALOG_OPTIONS.buttons, ['Quit', 'Cancel']);
  assert.equal(CLOSE_DIALOG_OPTIONS.defaultId, 1);
  assert.equal(CLOSE_DIALOG_OPTIONS.cancelId, 1);
  assert.equal(CLOSE_DIALOG_OPTIONS.type, 'question');
  assert.match(CLOSE_DIALOG_OPTIONS.message, /ShowTrak Timers/);
});

// --- RequestShutdown (the renderer's Shutdown call) ---------------------------------

test('a confirmed shutdown quits at once, even in protected show mode', () => {
  const { Coordinator, calls } = coordinator();
  Coordinator.SetProtection(true);
  Coordinator.RequestShutdown(true);
  assert.equal(calls.quit, 1);
  assert.equal(calls.rendererAsks, 0);
});

test('an unconfirmed shutdown in protected show mode asks the renderer first', () => {
  const { Coordinator, calls } = coordinator({ rendererCanConfirm: true });
  Coordinator.SetProtection(true);
  Coordinator.RequestShutdown(false);
  assert.equal(calls.rendererAsks, 1);
  assert.equal(calls.quit, 0);
});

test('when the renderer cannot ask (no window), an unconfirmed shutdown quits', () => {
  const { Coordinator, calls } = coordinator({ rendererCanConfirm: false });
  Coordinator.SetProtection(true);
  Coordinator.RequestShutdown(false);
  assert.equal(calls.rendererAsks, 1);
  assert.equal(calls.quit, 1);
});

test('an unconfirmed shutdown quits without asking when nothing needs confirming', () => {
  const Unprotected = coordinator();
  Unprotected.Coordinator.RequestShutdown(false);
  assert.equal(Unprotected.calls.rendererAsks, 0);
  assert.equal(Unprotected.calls.quit, 1);

  ModeManager.Set('EDIT');
  const Editing = coordinator();
  Editing.Coordinator.SetProtection(true);
  Editing.Coordinator.RequestShutdown(false);
  assert.equal(Editing.calls.rendererAsks, 0);
  assert.equal(Editing.calls.quit, 1);
});

test('a renderer-confirmed shutdown is not asked again by the native prompt', async () => {
  const { Coordinator, calls } = coordinator({ answers: [false] });
  Coordinator.SetProtection(true);
  Coordinator.RequestShutdown(true);
  const Event = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Event);
  assert.equal(Event.prevented, 0);
  assert.equal(calls.prompts.length, 0);
});

// --- Bypasses ---------------------------------------------------------------------

test('a system shutdown quits and is never stopped by the prompt', async () => {
  const { Coordinator, calls } = coordinator({ answers: [false] });
  Coordinator.SetProtection(true);
  Coordinator.HandleSystemShutdown();
  assert.equal(calls.quit, 1);
  const Event = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Event);
  assert.equal(Event.prevented, 0);
  assert.equal(calls.prompts.length, 0);
});

test('quitting to install an update bypasses the prompt without quitting itself', async () => {
  const { Coordinator, calls } = coordinator({ answers: [false] });
  Coordinator.SetProtection(true);
  Coordinator.HandleBeforeQuitForUpdate();
  // The updater drives the quit; the coordinator only stands aside.
  assert.equal(calls.quit, 0);
  const Event = closeEvent();
  await Coordinator.HandleWindowClose(WINDOW, Event);
  assert.equal(Event.prevented, 0);
  assert.equal(calls.prompts.length, 0);

  Coordinator.RequestShutdown(false);
  assert.equal(calls.rendererAsks, 0);
});

// --- will-quit cleanup ------------------------------------------------------------

test('will-quit holds the quit, runs cleanup once, then quits', async () => {
  const Hold = deferred();
  const { Coordinator, calls } = coordinator({ cleanup: () => Hold.promise });

  const First = closeEvent();
  Coordinator.HandleWillQuit(First);
  assert.equal(First.prevented, 1);
  assert.equal(calls.cleanups, 1);
  await flush();
  assert.equal(calls.quit, 0, 'quit before cleanup finished');

  // Another will-quit while cleanup runs is held too, without a second cleanup.
  const During = closeEvent();
  Coordinator.HandleWillQuit(During);
  assert.equal(During.prevented, 1);
  assert.equal(calls.cleanups, 1);

  Hold.resolve();
  await flush(10);
  assert.equal(calls.quit, 1);
  assert.deepEqual(calls.order, ['cleanup', 'cleanup done', 'quit']);

  // The will-quit that the final quit raises goes straight through.
  const After = closeEvent();
  Coordinator.HandleWillQuit(After);
  assert.equal(After.prevented, 0);
  assert.equal(calls.cleanups, 1);
  assert.equal(calls.quit, 1);
});

test('the log is flushed after cleanup and before the quit', async () => {
  const { Coordinator, calls } = coordinator();
  Coordinator.HandleWillQuit(closeEvent());
  await flush(10);
  assert.equal(logger.flushes.length, 1);
  assert.equal(calls.quit, 1);
  // The flush came after cleanup logged its start line.
  assert.ok(logger.lines('log').includes('Shutting down: stopping services'));
});

test('a cleanup that fails is logged and the app still quits, once', async () => {
  const { Coordinator, calls } = coordinator({
    cleanup: async () => {
      throw new Error('database is locked');
    },
  });
  Coordinator.HandleWillQuit(closeEvent());
  await flush(10);
  assert.equal(calls.quit, 1);
  assert.equal(logger.flushes.length, 1, 'the log was not flushed after a failed cleanup');
  assert.ok(logger.lines('error').some((L) => /Cleanup during shutdown failed/.test(L)));

  const After = closeEvent();
  Coordinator.HandleWillQuit(After);
  assert.equal(After.prevented, 0);
  assert.equal(calls.cleanups, 1);
});

test('each coordinator keeps its own state', async () => {
  const A = coordinator();
  const B = coordinator();
  A.Coordinator.SetProtection(true);
  assert.equal(B.Coordinator.IsProtected(), false);
  A.Coordinator.HandleWillQuit(closeEvent());
  await flush(10);
  const Event = closeEvent();
  B.Coordinator.HandleWillQuit(Event);
  assert.equal(Event.prevented, 1);
  await flush(10);
});

test('a cleanup that hangs is given up on at the deadline, and the app exits anyway', async () => {
  const Never = deferred();
  const { Coordinator, calls } = coordinator({ cleanup: () => Never.promise, deadlineMs: 20 });
  Coordinator.HandleWillQuit(closeEvent());
  await flush();
  assert.deepEqual(calls.exits, []);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await flush(10);
  // exit, not quit: a quit would wait on the stuck cleanup all over again.
  assert.deepEqual(calls.exits, [0]);
  assert.equal(calls.quit, 0);
  assert.ok(logger.lines('error').some((L) => /did not finish in time/.test(L)));
  // Whatever will-quit follows goes straight through.
  const After = closeEvent();
  Coordinator.HandleWillQuit(After);
  assert.equal(After.prevented, 0);
});

test('the default cleanup deadline is ten seconds', () => {
  const { CLEANUP_DEADLINE_MS } = require('../dist/main/shutdown');
  assert.equal(CLEANUP_DEADLINE_MS, 10000);
});

test('a system shutdown with an event holds it (preventDefault) while the app quits', () => {
  const { Coordinator, calls } = coordinator();
  Coordinator.SetProtection(true);
  const Event = closeEvent();
  Coordinator.HandleSystemShutdown(Event);
  assert.equal(Event.prevented, 1);
  assert.equal(calls.quit, 1);
});
