const test = require('node:test');
const assert = require('node:assert/strict');

// Covers ComputeSettingsStructure in src/UI/js/app/settings.ts: the fingerprint
// the Preferences modal compares to decide between rebuilding every control and
// syncing values into the controls already drawn. Getting it wrong either way
// is visible: too sensitive and every save rebuilds the pane (focus and scroll
// jump while typing); too lax and a changed title, range or option list never
// reaches the screen.
//
// The module only touches jQuery inside its functions, so it loads in plain
// Node. The input is the app's real settings catalogue
// (Modules/SettingsManager/DefaultSettings, from the per-file build in dist/),
// shaped the way the main process pushes it.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const { ComputeSettingsStructure } = require('../dist-test/UI/js/app/settings.js');
const { DefaultSettings, Groups } = require('../dist/Modules/SettingsManager/DefaultSettings.js');

// Through JSON, as the push over IPC is: the catalogue's Validate functions do
// not reach the renderer.
function views() {
  return DefaultSettings.map((S) => ({
    ...JSON.parse(JSON.stringify(S)),
    Value: S.DefaultValue,
    isDefault: true,
  }));
}

function groups() {
  return structuredClone(Groups);
}

const BASELINE = ComputeSettingsStructure(views(), groups());

test('the structure is a stable string for the same settings', () => {
  assert.equal(typeof BASELINE, 'string');
  assert.doesNotThrow(() => JSON.parse(BASELINE));
  assert.equal(ComputeSettingsStructure(views(), groups()), BASELINE);
});

test('a change of value alone keeps the structure, so controls are synced in place', () => {
  const List = views();
  for (const S of List) {
    S.Value = S.Type === 'BOOLEAN' ? !S.Value : S.Type === 'OPTION' ? S.Options.at(-1) : 12345;
    S.isDefault = false;
  }
  assert.equal(ComputeSettingsStructure(List, groups()), BASELINE);
});

test('every field that changes how a setting is drawn changes the structure', () => {
  const Changes = {
    ShowWhen: ['OSC_ENABLE', 'WEB_ENABLE_DASHBOARD'],
    Group: 'Elsewhere',
    Key: 'RENAMED_KEY',
    Title: 'A New Title',
    Description: 'A new description.',
    Type: 'STRING',
    Min: -1,
    Max: 9999,
    Unit: 'ms',
    Options: ['One', 'Two'],
    RequiresSave: true,
  };
  for (const [Field, Value] of Object.entries(Changes)) {
    const List = views();
    List[0][Field] = Value;
    assert.notEqual(ComputeSettingsStructure(List, groups()), BASELINE, Field);
  }
});

test('a group renamed, retitled, added or removed changes the structure', () => {
  const Retitled = groups();
  Retitled[0].Title = 'Machine';
  assert.notEqual(ComputeSettingsStructure(views(), Retitled), BASELINE);
  const Renamed = groups();
  Renamed[1].Name = 'Sounds';
  assert.notEqual(ComputeSettingsStructure(views(), Renamed), BASELINE);
  assert.notEqual(
    ComputeSettingsStructure(views(), [...groups(), { Name: 'New', Title: 'New' }]),
    BASELINE
  );
  assert.notEqual(ComputeSettingsStructure(views(), groups().slice(1)), BASELINE);
});

test('a setting added, removed or moved changes the structure', () => {
  const List = views();
  assert.notEqual(ComputeSettingsStructure(List.slice(1), groups()), BASELINE);
  assert.notEqual(ComputeSettingsStructure([...List].reverse(), groups()), BASELINE);
  assert.notEqual(
    ComputeSettingsStructure([...List, { ...List[0], Key: 'EXTRA' }], groups()),
    BASELINE
  );
});

test('a hole in either list does not throw', () => {
  assert.doesNotThrow(() => ComputeSettingsStructure([null, ...views()], [null, ...groups()]));
  assert.equal(ComputeSettingsStructure([], []), '[[],[]]');
});
