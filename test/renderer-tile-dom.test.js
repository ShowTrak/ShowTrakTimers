const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/tile-dom.ts: writing a tile model into a tile's DOM,
// shared by the desktop grid and the Web Dashboard. Running timers repaint many
// times a second, so the properties that matter are that a tile shows exactly
// its model, and that a paint which changes nothing writes nothing (each write
// restyles and redraws the tile). The DOM is faked: only what the painter uses.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const { PaintTileElement } = require('../dist-test/UI/js/app/lib/tile-dom.js');
const { BuildTileModel } = require('../dist-test/UI/js/app/lib/timer-tile.js');

// A node that counts the writes made to it.
function FakeNode(Attrs = {}) {
  const Node = {
    Attrs,
    Writes: 0,
    Classes: new Set(),
    _text: '',
    children: [],
    style: {
      // The readout's length (--readout-chars), kept like any other write.
      setProperty(Name, Value) {
        Node.Writes++;
        Node.Props[Name] = Value;
      },
    },
    Props: {},
    get textContent() {
      return this._text;
    },
    set textContent(Value) {
      this.Writes++;
      this._text = Value;
    },
    get firstElementChild() {
      return this.children[0] ?? null;
    },
    getAttribute: (Name) => Attrs[Name] ?? null,
    classList: {
      toggle(Name, On) {
        Node.Writes++;
        if (On) Node.Classes.add(Name);
        else Node.Classes.delete(Name);
      },
    },
  };
  return Node;
}

function FakeTile({ Buttons = true } = {}) {
  const Roles = {};
  for (const Role of ['name', 'status', 'primary', 'secondary', 'progress']) {
    Roles[Role] = FakeNode({ 'data-role': Role });
  }
  const Bar = FakeNode();
  let BarWrites = 0;
  let Transform = '';
  Object.defineProperty(Bar.style, 'transform', {
    get: () => Transform,
    set: (Value) => {
      BarWrites++;
      Transform = Value;
    },
  });
  Roles.progress.children.push(Bar);
  const Actions = Buttons
    ? ['Start', 'Unpause', 'Pause', 'Stop', 'edit'].map((A) => FakeNode({ 'data-action': A }))
    : [];
  let ClassName = 'SHOWTRAK_TIMER';
  let ClassWrites = 0;
  let Queries = 0;
  const El = {
    get className() {
      return ClassName;
    },
    set className(Value) {
      ClassWrites++;
      ClassName = Value;
    },
    querySelector(Selector) {
      Queries++;
      const Match = Selector.match(/data-role="(\w+)"/);
      return Match ? (Roles[Match[1]] ?? null) : null;
    },
    querySelectorAll() {
      Queries++;
      return Actions;
    },
  };
  const Writes = () =>
    ClassWrites +
    BarWrites +
    Object.values(Roles).reduce((Sum, N) => Sum + N.Writes, 0) +
    Actions.reduce((Sum, N) => Sum + N.Writes, 0);
  return { El, Roles, Bar, Actions, Writes, Queries: () => Queries };
}

const Timer = (Overrides = {}) => ({
  ID: 3,
  Type: 'COUNTDOWN',
  Name: 'Walk In',
  Description: '',
  Duration: 300_000,
  Weight: 1,
  ShowOnWeb: true,
  EndBehaviour: 'HOLD',
  CompletionSound: null,
  CompletionToast: false,
  WarningMs: null,
  WarningSound: null,
  WarningToast: false,
  ShowHundredths: false,
  GroupID: null,
  Status: 'RUNNING',
  ElapsedMs: 0,
  Warning: false,
  ...Overrides,
});

const Hidden = (Node) => Node.Classes.has('d-none');

test('a painted tile shows its model', () => {
  const Tile = FakeTile();
  PaintTileElement(Tile.El, BuildTileModel(Timer(), 60_000), ['SELECTED']);
  assert.equal(Tile.El.className, 'SHOWTRAK_TIMER RUNNING TYPE_COUNTDOWN SELECTED');
  assert.equal(Tile.Roles.name.textContent, 'Walk In');
  assert.equal(Tile.Roles.status.textContent, 'Running');
  assert.equal(Tile.Roles.primary.textContent, '04:00');
  assert.equal(Tile.Roles.secondary.textContent, '');
  assert.equal(Tile.Bar.style.transform, 'scaleX(0.8)');
  assert.equal(Tile.Roles.progress.Classes.has('invisible'), false);
  const [Start, Resume, Pause, Stop, Edit] = Tile.Actions;
  assert.deepEqual([Start, Resume, Pause, Stop].map(Hidden), [true, true, false, false]);
  assert.equal(Edit.Writes, 0, 'the edit button is never touched');
});

test('repainting the same model writes nothing, and the tile is only searched once', () => {
  const Tile = FakeTile();
  const Model = BuildTileModel(Timer(), 60_000);
  PaintTileElement(Tile.El, Model);
  const Writes = Tile.Writes();
  const Queries = Tile.Queries();
  for (let I = 0; I < 50; I++) PaintTileElement(Tile.El, BuildTileModel(Timer(), 60_000));
  assert.equal(Tile.Writes(), Writes);
  assert.equal(Tile.Queries(), Queries);
});

test('a tick writes only the readout (and the bar when it moved)', () => {
  const Tile = FakeTile();
  PaintTileElement(Tile.El, BuildTileModel(Timer(), 60_000));
  const Before = Tile.Writes();
  PaintTileElement(Tile.El, BuildTileModel(Timer(), 61_000));
  assert.equal(Tile.Roles.primary.textContent, '03:59');
  assert.equal(Tile.Writes() - Before, 2, 'the readout and the bar');
});

test('state changes reach the class, the buttons and the bar', () => {
  const Tile = FakeTile();
  PaintTileElement(Tile.El, BuildTileModel(Timer(), 60_000));
  PaintTileElement(Tile.El, BuildTileModel(Timer({ Status: 'PAUSED', ElapsedMs: 60_000 }), 60_000));
  assert.equal(Tile.El.className, 'SHOWTRAK_TIMER PAUSED TYPE_COUNTDOWN');
  assert.deepEqual(Tile.Actions.slice(0, 4).map(Hidden), [true, false, true, false]);
  PaintTileElement(
    Tile.El,
    BuildTileModel(Timer({ Type: 'STOPWATCH', Duration: null, Status: 'STANDBY' }), 0)
  );
  assert.equal(Tile.Roles.progress.Classes.has('invisible'), true);
  assert.equal(Tile.Roles.status.textContent, 'Stopwatch');
  assert.deepEqual(Tile.Actions.slice(0, 4).map(Hidden), [false, true, true, true]);
});

test('a dashboard tile (no buttons) paints the same way', () => {
  const Tile = FakeTile({ Buttons: false });
  PaintTileElement(Tile.El, BuildTileModel(Timer({ Type: 'TIMER' }), 90_000));
  assert.equal(Tile.Roles.primary.textContent, '01:30');
  assert.equal(Tile.Roles.secondary.textContent, '/ 05:00');
});

test("the readout's length is written for the dashboard to size it, only when it changes", () => {
  const Tile = FakeTile({ Buttons: false });
  const Clock = Timer({ Type: 'CLOCK', Duration: null, ClockFormat: '12H', ShowHundredths: true });
  const At = (H, M, S) => ((H * 60 + M) * 60 + S) * 1000;
  PaintTileElement(Tile.El, BuildTileModel(Clock, At(13, 5, 9)));
  assert.equal(Tile.Roles.primary.textContent, '1:05:09.00 PM');
  assert.equal(Tile.Roles.primary.Props['--readout-chars'], '13');
  const Writes = Tile.Roles.primary.Writes;
  PaintTileElement(Tile.El, BuildTileModel(Clock, At(13, 5, 10)));
  assert.equal(Tile.Roles.primary.Writes, Writes + 1, 'the text only: same length');
  PaintTileElement(Tile.El, BuildTileModel(Clock, At(22, 0, 0)));
  assert.equal(Tile.Roles.primary.Props['--readout-chars'], '14');
});
