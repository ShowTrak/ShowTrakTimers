const test = require('node:test');
const assert = require('node:assert/strict');
const { installModuleMocks, matchesModule } = require('./helpers/main-mocks');
const { flush } = require('./helpers/net-util');

// Covers PromptShowFileUpgrade in src/UI/js/app/show-file.ts: what the
// operator's answer leads to when a show file an older version saved is opened,
// or was left open last session. The renderer reads it from Show:ResolveUpgrade:
// declining the show left open last session clears it (Cleared), so a new show
// file is started; declining a file that was only being opened keeps the open
// show; accepting starts nothing new; and an answer that failed while the
// upgrade is still waiting leaves the prompt up to answer again.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why), with
// the modules it imports stubbed out and just enough of jQuery to press the
// prompt's buttons.

const Log = { Calls: [], Notes: [], Opened: [], Closed: [] };
const restore = installModuleMocks([
  {
    match: matchesModule('/lib/toasts'),
    value: {
      ConfirmationDialog: async () => true,
      CancelConfirmation: () => {},
      Notify: async (Message, Type) => Log.Notes.push([Type, Message]),
    },
  },
  {
    match: matchesModule('/lib/modal'),
    value: {
      openModal: (ID) => Log.Opened.push(ID),
      closeModal: (ID) => Log.Closed.push(ID),
      closeAllModals: () => {},
    },
  },
  { match: matchesModule('/selection'), value: { ClearSelection: () => {} } },
  { match: matchesModule('/timer-editor'), value: { DiscardTimerEditor: () => {} } },
  { match: matchesModule('/group-manager'), value: { DiscardGroupEditor: () => {} } },
]);
test.after(() => {
  restore();
  delete global.$;
  delete global.window;
});

// The prompt's buttons by ID: their text, and their 'click.showUpgrade' handlers.
const Texts = new Map();
const Clicks = new Map();
global.$ = (Selector) => {
  const IDs = Selector.split(',').map((ID) => ID.trim());
  const Wrapped = {
    text(Value) {
      for (const ID of IDs) Texts.set(ID, Value);
      return Wrapped;
    },
    prop: () => Wrapped,
    on(_Event, Handler) {
      for (const ID of IDs) Clicks.set(ID, Handler);
      return Wrapped;
    },
    off() {
      for (const ID of IDs) Clicks.delete(ID);
      return Wrapped;
    },
  };
  return Wrapped;
};

const Answers = { Resolve: [], Pending: null, Current: null };
global.window = {
  API: {
    ResolveShowFileUpgrade: async (Accept) => (
      Log.Calls.push(`Resolve:${Accept}`),
      Answers.Resolve.shift()
    ),
    CheckShowFileUpgrade: async () => (Log.Calls.push('Check'), [null, Answers.Pending]),
    GetCurrentShowFile: async () => Answers.Current,
    NewShow: async () => (Log.Calls.push('NewShow'), [null, 'New show created']),
  },
};

const ShowFileUI = require('../dist-test/UI/js/app/show-file.js');
const State = require('../dist-test/UI/js/app/state.js');

const OPEN = '/shows/Main.showtraktimers';
const OLDER = '/shows/Older.showtraktimers';

/** An upgrade waiting for FilePath, which v1.4.0 last saved. */
function Upgrade(FilePath) {
  return {
    FilePath,
    FileName: FilePath.split('/').pop(),
    FileVersion: '1.4.0',
    CurrentVersion: '2.0.2',
  };
}

function Reset({ Open = OPEN } = {}) {
  State.setShowFile({ FilePath: Open, Unsaved: false, Generation: State.ShowFile.Generation });
  Answers.Resolve = [];
  Answers.Pending = null;
  Answers.Current = Open;
  Texts.clear();
  Clicks.clear();
  for (const List of Object.values(Log)) List.length = 0;
}

test('declining the show left open last session starts a new show file', async () => {
  Reset();
  Answers.Resolve = [[null, { Cleared: true }]];
  const Prompt = ShowFileUI.PromptShowFileUpgrade(Upgrade(OPEN));
  assert.ok(Log.Opened.includes('SHOWTRAK_MODAL_UPGRADE_SHOW'));
  assert.equal(Texts.get('#UPGRADE_SHOW_DECLINE'), 'Create a New Show File Instead');
  Clicks.get('#UPGRADE_SHOW_DECLINE')();
  await Prompt;
  assert.deepEqual(Log.Calls, ['Resolve:false', 'NewShow']);
  assert.ok(Log.Closed.includes('SHOWTRAK_MODAL_UPGRADE_SHOW'));
  assert.equal(Clicks.size, 0, 'the buttons are let go of once answered');
});

test('declining a file that was being opened keeps the open show', async () => {
  Reset();
  Answers.Resolve = [[null, { Cleared: false }]];
  const Prompt = ShowFileUI.PromptShowFileUpgrade(Upgrade(OLDER));
  assert.equal(Texts.get('#UPGRADE_SHOW_DECLINE'), "Don't Open It");
  Clicks.get('#UPGRADE_SHOW_DECLINE')();
  await Prompt;
  assert.deepEqual(Log.Calls, ['Resolve:false']);
  assert.deepEqual(Log.Notes, []);
  assert.ok(!Log.Opened.includes('SHOWTRAK_MODAL_NO_SHOW'));
});

test('accepting backs the file up and upgrades it, and starts nothing new', async () => {
  Reset();
  Answers.Resolve = [
    [null, { FilePath: OLDER, BackupPath: '/backups/Older (v1.4.0).showtraktimers' }],
  ];
  const Prompt = ShowFileUI.PromptShowFileUpgrade(Upgrade(OLDER));
  Clicks.get('#UPGRADE_SHOW_ACCEPT')();
  await Prompt;
  assert.deepEqual(Log.Calls, ['Resolve:true']);
  assert.deepEqual(Log.Notes, [['success', 'Backed up and upgraded Older.showtraktimers.']]);
});

test('an answer that fails while the upgrade still waits leaves the prompt up', async () => {
  Reset();
  Answers.Resolve = [
    ['Failed to back up the show file: the disk is full', null],
    [null, { Cleared: false }],
  ];
  Answers.Pending = Upgrade(OLDER);
  let Answered = false;
  const Prompt = ShowFileUI.PromptShowFileUpgrade(Upgrade(OLDER)).then(() => {
    Answered = true;
  });
  Clicks.get('#UPGRADE_SHOW_ACCEPT')();
  await flush();
  assert.equal(Answered, false);
  assert.deepEqual(Log.Notes, [['error', 'Failed to back up the show file: the disk is full']]);
  assert.ok(!Log.Closed.includes('SHOWTRAK_MODAL_UPGRADE_SHOW'));

  // Answered again, this time declining.
  Answers.Pending = null;
  Clicks.get('#UPGRADE_SHOW_DECLINE')();
  await Prompt;
  assert.deepEqual(Log.Calls, ['Resolve:true', 'Check', 'Resolve:false']);
  assert.ok(Log.Closed.includes('SHOWTRAK_MODAL_UPGRADE_SHOW'));
});

test('with no show open once answered, the operator is asked to open or create one', async () => {
  Reset();
  Answers.Resolve = [[null, { Cleared: false }]];
  Answers.Current = null;
  const Prompt = ShowFileUI.PromptShowFileUpgrade(Upgrade(OLDER));
  Clicks.get('#UPGRADE_SHOW_DECLINE')();
  await Prompt;
  assert.ok(Log.Opened.includes('SHOWTRAK_MODAL_NO_SHOW'));
  assert.match(Texts.get('#NO_SHOW_MESSAGE'), /Open an existing show file or create a new one/);
});
