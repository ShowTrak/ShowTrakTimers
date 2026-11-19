const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');

// Covers OpenRequestedShow in src/UI/js/app/show-file.ts: a show file opened
// from the operating system (double-clicked in Finder or Explorer). What is at
// stake: it replaces the running show, so unsaved changes are offered a save
// first, a file arriving while a show is open asks before replacing it, and
// nothing is opened when the operator cancels.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why), with
// the jQuery-driven modules it imports stubbed out.

const Log = { Confirms: [], Calls: [], Notes: [], Closed: [] };
const Answers = { Confirm: [] };
const restore = installModuleMocks([
  {
    match: matchesModule('/lib/toasts'),
    value: {
      ConfirmationDialog: async (Message, Options) => {
        Log.Confirms.push({ Message, Options });
        return Answers.Confirm.shift();
      },
      Notify: async (Message, Type) => Log.Notes.push([Type, Message]),
    },
  },
  {
    match: matchesModule('/lib/modal'),
    value: {
      closeModal: (ID) => Log.Closed.push(ID),
      openModal: () => {},
      closeAllModals: () => {},
    },
  },
  { match: matchesModule('/selection'), value: { ClearSelection: () => {} } },
  { match: matchesModule('/timer-editor'), value: { DiscardTimerEditor: () => {} } },
  { match: matchesModule('/group-manager'), value: { DiscardGroupEditor: () => {} } },
]);
test.after(() => restore());

const ShowFileUI = require('../dist-test/UI/js/app/show-file.js');
const State = require('../dist-test/UI/js/app/state.js');

let Request = null;
let LegacyData = false;
global.window = {
  API: {
    TakeShowFileRequest: async () => (Log.Calls.push('Take'), [null, Request]),
    OpenRequestedShow: async () => (
      Log.Calls.push('Open'),
      [null, { Status: 'Opened', FilePath: Request.FilePath }]
    ),
    SaveShow: async () => (Log.Calls.push('Save'), [null, 'Saved']),
    SaveShowAs: async () => (Log.Calls.push('SaveAs'), [null, 'Saved']),
    HasUnsavedShowData: async () => LegacyData,
  },
};

function Reset({
  FilePath = '/shows/Main.showtraktimers',
  Unsaved = false,
  Source = 'Running',
} = {}) {
  State.setShowFile({ FilePath, Unsaved, Generation: State.ShowFile.Generation });
  Request = { FilePath: '/shows/Other.showtraktimers', Source };
  LegacyData = false;
  Answers.Confirm = [];
  for (const List of Object.values(Log)) List.length = 0;
}

test('nothing waiting does nothing', async () => {
  Reset();
  Request = null;
  assert.equal(await ShowFileUI.OpenRequestedShow(), 'None');
  assert.deepEqual(Log.Calls, ['Take']);
});

test('a file that launched the app opens without asking', async () => {
  Reset({ Source: 'Launch' });
  assert.equal(await ShowFileUI.OpenRequestedShow(), 'Opened');
  assert.deepEqual(Log.Calls, ['Take', 'Open']);
  assert.equal(Log.Confirms.length, 0);
  assert.ok(Log.Closed.includes('SHOWTRAK_MODAL_NO_SHOW'));
});

test('while a show is running it asks first, and Cancel opens nothing', async () => {
  Reset();
  Answers.Confirm = [false];
  assert.equal(await ShowFileUI.OpenRequestedShow(), 'Cancelled');
  assert.match(Log.Confirms[0].Message, /Open Other\? This closes Main/);
  assert.deepEqual(Log.Calls, ['Take']);

  Reset();
  Answers.Confirm = [true];
  assert.equal(await ShowFileUI.OpenRequestedShow(), 'Opened');
  assert.deepEqual(Log.Calls, ['Take', 'Open']);
});

test('unsaved changes are offered a save first, even at launch', async () => {
  for (const [Answer, Expected, Calls] of [
    [true, 'Opened', ['Take', 'Save', 'Open']],
    ['alt', 'Opened', ['Take', 'Open']],
    [false, 'Cancelled', ['Take']],
  ]) {
    Reset({ Unsaved: true, Source: 'Launch' });
    Answers.Confirm = [Answer];
    assert.equal(await ShowFileUI.OpenRequestedShow(), Expected, String(Answer));
    assert.deepEqual(Log.Calls, Calls, String(Answer));
    assert.equal(Log.Confirms.length, 1, 'asked once, not again to replace');
    assert.match(Log.Confirms[0].Message, /unsaved changes/);
  }
});

test('timers from before show files are offered a Save As first', async () => {
  Reset({ FilePath: null, Source: 'Launch' });
  LegacyData = true;
  Answers.Confirm = [true];
  assert.equal(await ShowFileUI.OpenRequestedShow(), 'Opened');
  assert.deepEqual(Log.Calls, ['Take', 'SaveAs', 'Open']);
});

test('requests are handled one after another', async () => {
  Reset();
  Answers.Confirm = [true, true];
  const [A, B] = await Promise.all([
    ShowFileUI.OpenRequestedShow(),
    ShowFileUI.OpenRequestedShow(),
  ]);
  assert.deepEqual([A, B], ['Opened', 'Opened']);
  assert.deepEqual(Log.Calls, ['Take', 'Open', 'Take', 'Open']);
});
