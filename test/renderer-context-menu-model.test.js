const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/context-menu-model.ts: what the right-click menu
// offers, as rows with an action ID. context-menu.ts only draws these and runs
// the action, so whether a run control is live, which groups a selection can
// move to and what is EDIT-mode only are all decided here.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const {
  BuildContextMenuRows,
  SelectionActionApplies,
} = require('../dist-test/UI/js/app/lib/context-menu-model.js');
const { SHORTCUT_KEYS } = require('../dist-test/UI/js/app/lib/shortcuts.js');

const STATUSES = ['STANDBY', 'RUNNING', 'PAUSED', 'COMPLETE', 'OVERRUN'];
const GROUPS = [
  { GroupID: 1, Title: 'Stage', Colour: 4 },
  { GroupID: 2, Title: 'FOH', Colour: null },
];

let NextID = 1;
function timer(Overrides = {}) {
  const ID = NextID++;
  return { ID, Name: `Timer ${ID}`, Type: 'TIMER', Status: 'STANDBY', GroupID: null, ...Overrides };
}

function rows(Overrides = {}) {
  return BuildContextMenuRows({
    Selected: [],
    TimerCount: 3,
    Mode: 'SHOW',
    Groups: GROUPS,
    ...Overrides,
  });
}

const byAction = (Rows, Action) => Rows.filter((R) => R.Action === Action);
const one = (Rows, Action) => {
  const Found = byAction(Rows, Action);
  assert.equal(Found.length, 1, `${Action}: ${Found.length} rows`);
  return Found[0];
};
const actions = (Rows) => Rows.filter((R) => R.Type === 'Action').map((R) => R.Action);

// --- SelectionActionApplies ---------------------------------------------------------

test('Start applies to a timer in standby or complete, never one running or paused', () => {
  const Expected = { STANDBY: true, RUNNING: false, PAUSED: false, COMPLETE: true, OVERRUN: false };
  for (const Status of STATUSES) {
    assert.equal(SelectionActionApplies('Start', [timer({ Status })]), Expected[Status], Status);
  }
});

test('Pause applies to a ticking timer (running or overrunning)', () => {
  const Expected = { STANDBY: false, RUNNING: true, PAUSED: false, COMPLETE: false, OVERRUN: true };
  for (const Status of STATUSES) {
    assert.equal(SelectionActionApplies('Pause', [timer({ Status })]), Expected[Status], Status);
  }
});

test('Resume applies only to a paused timer', () => {
  for (const Status of STATUSES) {
    assert.equal(
      SelectionActionApplies('Unpause', [timer({ Status })]),
      Status === 'PAUSED',
      Status
    );
  }
});

test('Stop applies to anything not already in standby', () => {
  for (const Status of STATUSES) {
    assert.equal(SelectionActionApplies('Stop', [timer({ Status })]), Status !== 'STANDBY', Status);
  }
});

test('a mixed selection enables an action when any timer in it can take it', () => {
  const Mixed = [timer({ Status: 'STANDBY' }), timer({ Status: 'PAUSED' })];
  assert.equal(SelectionActionApplies('Start', Mixed), true);
  assert.equal(SelectionActionApplies('Unpause', Mixed), true);
  assert.equal(SelectionActionApplies('Stop', Mixed), true);
  assert.equal(SelectionActionApplies('Pause', Mixed), false);
  assert.equal(SelectionActionApplies('Start', []), false);
});

// --- With a selection ---------------------------------------------------------------

test('the header names one selected timer, and counts several', () => {
  assert.deepEqual(rows({ Selected: [timer({ Name: 'Walk In' })] })[0], {
    Type: 'Header',
    Title: 'Walk In',
  });
  assert.deepEqual(rows({ Selected: [timer(), timer(), timer()] })[0], {
    Type: 'Header',
    Title: '3 Timers Selected',
  });
});

test('the run controls come first, disabled exactly when they have nothing to do', () => {
  const Map = {
    SELECTION_START: 'Start',
    SELECTION_PAUSE: 'Pause',
    SELECTION_RESUME: 'Unpause',
    SELECTION_STOP: 'Stop',
  };
  const Mixes = [
    ['STANDBY'],
    ['RUNNING'],
    ['PAUSED'],
    ['COMPLETE'],
    ['OVERRUN'],
    ['STANDBY', 'RUNNING'],
    ['PAUSED', 'COMPLETE'],
    ['OVERRUN', 'PAUSED', 'STANDBY'],
  ];
  for (const Mix of Mixes) {
    const Selected = Mix.map((Status) => timer({ Status }));
    const Rows = rows({ Selected });
    assert.deepEqual(
      Rows.slice(1, 5).map((R) => R.Action),
      Object.keys(Map),
      Mix.join('+')
    );
    for (const [Action, Control] of Object.entries(Map)) {
      assert.equal(
        one(Rows, Action).Disabled,
        !SelectionActionApplies(Control, Selected),
        `${Mix.join('+')}: ${Action}`
      );
    }
  }
});

test('the run controls show the shortcuts that do the same, and act on the selection', () => {
  const Rows = rows({ Selected: [timer()] });
  const Expected = {
    SELECTION_START: [SHORTCUT_KEYS.Start, 'Start'],
    SELECTION_PAUSE: [SHORTCUT_KEYS.Pause, 'Pause'],
    SELECTION_RESUME: [SHORTCUT_KEYS.Resume, 'Resume'],
    SELECTION_STOP: [SHORTCUT_KEYS.Stop, 'Stop'],
  };
  for (const [Action, [Shortcut, Title]] of Object.entries(Expected)) {
    const Row = one(Rows, Action);
    assert.equal(Row.Shortcut, Shortcut, Action);
    assert.equal(Row.Title, Title, Action);
    assert.equal(Row.ActsOnSelection, true, Action);
  }
  assert.equal(one(Rows, 'SELECT_ALL').Shortcut, SHORTCUT_KEYS.SelectAll);
  assert.equal(one(Rows, 'CLEAR_SELECTION').Shortcut, SHORTCUT_KEYS.ClearSelection);
});

test('in SHOW mode a selection gets the run controls and selection rows only', () => {
  const Rows = rows({ Selected: [timer(), timer()], Mode: 'SHOW', RailGroupID: 1 });
  assert.deepEqual(actions(Rows), [
    'SELECTION_START',
    'SELECTION_PAUSE',
    'SELECTION_RESUME',
    'SELECTION_STOP',
    'SELECT_ALL',
    'CLEAR_SELECTION',
  ]);
});

test('in EDIT mode one timer can be edited, several cannot', () => {
  assert.equal(byAction(rows({ Selected: [timer()], Mode: 'EDIT' }), 'SELECTION_EDIT').length, 1);
  assert.equal(
    byAction(rows({ Selected: [timer(), timer()], Mode: 'EDIT' }), 'SELECTION_EDIT').length,
    0
  );
});

test('the menu does not move, delete or manage: Edit Timer and the Groups menu do that', () => {
  for (const Selected of [[], [timer()], [timer(), timer()]]) {
    for (const RailGroupID of [undefined, null, 1]) {
      const Rows = rows({ Selected, Mode: 'EDIT', RailGroupID });
      assert.ok(!Rows.some((R) => /Move to Group|Delete|Manage Groups/.test(R.Title ?? '')));
    }
  }
});

test('rows that do not act on the selection never clear it', () => {
  const Rows = rows({ Selected: [timer()], Mode: 'EDIT', RailGroupID: 1 });
  for (const Action of ['SELECTION_EDIT', 'SELECT_ALL', 'CLEAR_SELECTION', 'EDIT_GROUP']) {
    assert.ok(!one(Rows, Action).ActsOnSelection, Action);
  }
});

// --- With nothing selected ----------------------------------------------------------

test('with nothing selected the menu offers the all-timers actions', () => {
  const Rows = rows({ Mode: 'SHOW' });
  assert.deepEqual(Rows[0], { Type: 'Info', Title: 'No Timers Selected' });
  assert.deepEqual(actions(Rows), [
    'ALL_START',
    'ALL_PAUSE',
    'ALL_RESUME',
    'ALL_STOP',
    'SELECT_ALL',
  ]);
  for (const Action of ['ALL_START', 'ALL_PAUSE', 'ALL_RESUME', 'ALL_STOP']) {
    assert.equal(one(Rows, Action).Disabled, false, Action);
    assert.ok(!one(Rows, Action).ActsOnSelection, Action);
  }
  assert.equal(one(Rows, 'ALL_START').Shortcut, SHORTCUT_KEYS.StartAll);
  assert.equal(one(Rows, 'ALL_STOP').Shortcut, SHORTCUT_KEYS.StopAll);
  assert.equal(one(Rows, 'ALL_PAUSE').Shortcut, SHORTCUT_KEYS.PauseAll);
  assert.equal(one(Rows, 'ALL_RESUME').Shortcut, SHORTCUT_KEYS.ResumeAll);
});

test('with no timers at all the all-timers actions are disabled and Select All is gone', () => {
  const Rows = rows({ TimerCount: 0 });
  for (const Action of ['ALL_START', 'ALL_PAUSE', 'ALL_RESUME', 'ALL_STOP']) {
    assert.equal(one(Rows, Action).Disabled, true, Action);
  }
  assert.equal(byAction(Rows, 'SELECT_ALL').length, 0);
  assert.equal(byAction(Rows, 'CLEAR_SELECTION').length, 0);
});

test('New Timer and New Group are EDIT mode only', () => {
  assert.deepEqual(byAction(rows({ Mode: 'SHOW' }), 'NEW_TIMER'), []);
  assert.deepEqual(byAction(rows({ Mode: 'SHOW' }), 'NEW_GROUP'), []);
  const Edit = rows({ Mode: 'EDIT' });
  assert.equal(one(Edit, 'NEW_TIMER').Shortcut, SHORTCUT_KEYS.NewTimer);
  one(Edit, 'NEW_GROUP');
});

// --- A group's rail --------------------------------------------------------------------

test("a group's rail in EDIT mode offers a new timer in that group", () => {
  const Real = byAction(rows({ Mode: 'EDIT', RailGroupID: 1, Groups: GROUPS }), 'NEW_TIMER');
  assert.equal(Real.length, 1, 'only the group one, not the generic one too');
  assert.equal(Real[0].GroupID, 1);
  assert.match(
    Real[0].Title,
    new RegExp(`^New Timer in ${GROUPS.find((G) => G.GroupID === 1).Title}$`)
  );
  const Default = byAction(rows({ Mode: 'EDIT', RailGroupID: null }), 'NEW_TIMER');
  assert.deepEqual(
    Default.map((R) => [R.GroupID, R.Title]),
    [[null, 'New Timer in Default']]
  );
  assert.equal(byAction(rows({ Mode: 'SHOW', RailGroupID: 1 }), 'NEW_TIMER').length, 0);
});

test("Edit Group is offered only for a real group's rail, in EDIT mode", () => {
  assert.deepEqual(one(rows({ Mode: 'EDIT', RailGroupID: 2 }), 'EDIT_GROUP').GroupID, 2);
  assert.equal(byAction(rows({ Mode: 'SHOW', RailGroupID: 2 }), 'EDIT_GROUP').length, 0);
  // The Default group's rail (null) and a right-click off any rail (undefined).
  assert.equal(byAction(rows({ Mode: 'EDIT', RailGroupID: null }), 'EDIT_GROUP').length, 0);
  assert.equal(byAction(rows({ Mode: 'EDIT' }), 'EDIT_GROUP').length, 0);
});

// --- Shape -------------------------------------------------------------------------------

test('dividers never lead, trail or double up, whatever the input', () => {
  const Inputs = [];
  for (const Mode of ['SHOW', 'EDIT']) {
    for (const Selected of [[], [timer()], [timer({ GroupID: 1 }), timer({ Status: 'RUNNING' })]]) {
      for (const TimerCount of [0, 4]) {
        for (const RailGroupID of [undefined, null, 1]) {
          for (const Groups of [[], GROUPS])
            Inputs.push({ Mode, Selected, TimerCount, RailGroupID, Groups });
        }
      }
    }
  }
  for (const Input of Inputs) {
    const Rows = BuildContextMenuRows(Input);
    const Label = JSON.stringify({ ...Input, Selected: Input.Selected.length });
    assert.ok(Rows.length > 0, Label);
    assert.notEqual(Rows[0].Type, 'Divider', Label);
    assert.notEqual(Rows.at(-1).Type, 'Divider', Label);
    for (let I = 1; I < Rows.length; I++) {
      assert.ok(!(Rows[I].Type === 'Divider' && Rows[I - 1].Type === 'Divider'), `${Label} @${I}`);
    }
  }
});

test('every action row has a title and an icon', () => {
  const Rows = rows({ Selected: [timer()], Mode: 'EDIT', RailGroupID: 1 });
  for (const Row of Rows.filter((R) => R.Type === 'Action')) {
    assert.ok(Row.Title, Row.Action);
    assert.match(Row.Icon, /^bi-/, Row.Action);
  }
});

// --- World Clock ----------------------------------------------------------------

test('a World Clock takes no run action, alone or in a mixed selection', () => {
  const Clock = timer({ Type: 'CLOCK', Status: 'RUNNING' });
  for (const Action of ['Start', 'Pause', 'Unpause', 'Stop']) {
    assert.equal(SelectionActionApplies(Action, [Clock]), false, Action);
  }
  const Idle = timer({ Status: 'STANDBY' });
  assert.equal(SelectionActionApplies('Start', [Clock, Idle]), true);
  assert.equal(SelectionActionApplies('Pause', [Clock, Idle]), false);
});

test('a selection of only World Clocks offers no run actions at all', () => {
  const Rows = BuildContextMenuRows({
    Selected: [timer({ Type: 'CLOCK', Status: 'RUNNING' })],
    TimerCount: 1,
    Mode: 'SHOW',
    Groups: [],
  });
  const Actions = Rows.map((R) => R.Action).filter(Boolean);
  for (const Action of [
    'SELECTION_START',
    'SELECTION_PAUSE',
    'SELECTION_RESUME',
    'SELECTION_STOP',
  ]) {
    assert.ok(!Actions.includes(Action), Action);
  }
});
