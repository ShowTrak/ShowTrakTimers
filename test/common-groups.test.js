const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Covers src/common/groups.ts: the shape of a group and the pure rules about it,
// shared by the main process, the desktop renderer and the Web Dashboard. The
// slug rules decide what an OSC sender can address (/ShowTrak/Group/<Slug>/...),
// so a slug that collides, or one that shadows the Default group, makes a cue
// hit the wrong timers. The layout rules decide how wide a group is drawn.
const G = require('../dist/common/groups.js');

// --- Slugs --------------------------------------------------------------------------

test('Slugify keeps letters, digits, "-" and "_", case and all, collapsing the rest', () => {
  assert.equal(G.Slugify('Stage Left'), 'Stage-Left');
  assert.equal(G.Slugify('  FOH / Bar!  '), 'FOH-Bar');
  assert.equal(G.Slugify('a  --  b'), 'a-b');
  assert.equal(G.Slugify('--_x_--'), 'x');
  assert.equal(G.Slugify('Ünïcode'), 'n-code');
  assert.equal(G.Slugify(''), '');
  assert.equal(G.Slugify('***'), '');
  assert.equal(G.Slugify(null), '');
  assert.equal(G.Slugify(undefined), '');
  assert.equal(G.Slugify(42), '42');
});

test('Slugify caps a slug at 64 characters without a trailing separator', () => {
  const Long = G.Slugify(`${'a'.repeat(63)} b`);
  assert.equal(Long.length, 63);
  assert.equal(Long, 'a'.repeat(63));
  assert.equal(G.Slugify('x'.repeat(100)).length, 64);
});

test('IsValidSlug accepts 1 to 64 letters, digits, "-" and "_"', () => {
  for (const Good of ['a', 'Stage-Left', 'foh_2', 'x'.repeat(64)]) {
    assert.equal(G.IsValidSlug(Good), true, Good);
  }
  for (const Bad of ['', 'a b', 'a/b', 'x'.repeat(65), 'é', null, 3]) {
    assert.equal(G.IsValidSlug(Bad), false, String(Bad));
  }
});

test("the Default group's slug is reserved, whatever its case", () => {
  assert.equal(G.DEFAULT_GROUP_SLUG, 'Default');
  for (const Value of ['Default', 'default', 'DEFAULT', 'dEfAuLt']) {
    assert.equal(G.IsReservedSlug(Value), true, Value);
  }
  assert.equal(G.IsReservedSlug('Defaults'), false);
  assert.equal(G.IsReservedSlug(null), false);
});

test("UniqueSlug is the label's slug when free, numbered when not (any case)", () => {
  assert.equal(G.UniqueSlug('Stage Left', []), 'Stage-Left');
  assert.equal(G.UniqueSlug('Stage Left', ['stage-left']), 'Stage-Left-2');
  assert.equal(G.UniqueSlug('Stage Left', ['Stage-Left', 'STAGE-LEFT-2']), 'Stage-Left-3');
  assert.equal(G.UniqueSlug('***', []), 'Group');
  assert.equal(G.UniqueSlug('', ['Group']), 'Group-2');
});

test("UniqueSlug never hands out the Default group's slug", () => {
  assert.equal(G.UniqueSlug('Default', []), 'Default-2');
  assert.equal(G.UniqueSlug('default', []), 'default-2');
});

test('UniqueSlug keeps a numbered slug within 64 characters', () => {
  const Base = 'x'.repeat(64);
  const Slug = G.UniqueSlug(Base, [Base]);
  assert.equal(Slug.length, 64);
  assert.ok(Slug.endsWith('-2'));
  assert.equal(G.IsValidSlug(Slug), true);
});

test('SlugProblem says why a typed slug cannot be used, or null', () => {
  assert.equal(G.SlugProblem('FOH', ['Stage']), null);
  assert.equal(G.SlugProblem('  FOH  ', []), null, 'surrounding spaces are trimmed');
  assert.equal(G.SlugProblem('', []), 'A slug is required');
  assert.equal(G.SlugProblem('   ', []), 'A slug is required');
  assert.match(G.SlugProblem('a b', []), /letters, numbers/);
  assert.match(G.SlugProblem('x'.repeat(65), []), /64 characters/);
  assert.equal(G.SlugProblem('DEFAULT', []), '"DEFAULT" is reserved for the Default group');
  assert.equal(G.SlugProblem('foh', ['FOH']), 'Another group already uses that slug');
});

// --- Normalisation ------------------------------------------------------------------

test('NormalizeGroupTitle trims, flattens to one line and caps at 32 characters', () => {
  assert.equal(G.NormalizeGroupTitle('  Stage\nLeft\t '), 'Stage Left');
  assert.equal(G.NormalizeGroupTitle('x'.repeat(40)).length, G.MAX_GROUP_TITLE_LENGTH);
  assert.equal(G.MAX_GROUP_TITLE_LENGTH, 32);
  assert.equal(G.NormalizeGroupTitle(null), '');
});

test('NormalizeFullWidth defaults to full width, as Server does', () => {
  for (const Full of [null, undefined, true, 1, '1', 'true']) {
    assert.equal(G.NormalizeFullWidth(Full), true, String(Full));
  }
  for (const Narrow of [false, 0, '0', 'false', 'no']) {
    assert.equal(G.NormalizeFullWidth(Narrow), false, String(Narrow));
  }
});

test('NormalizeColumnSpan is a whole number from 1 to 6', () => {
  assert.equal(G.NormalizeColumnSpan(3), 3);
  assert.equal(G.NormalizeColumnSpan('2'), 2);
  assert.equal(G.NormalizeColumnSpan(2.9), 2);
  assert.equal(G.NormalizeColumnSpan(0), 1);
  assert.equal(G.NormalizeColumnSpan(-4), 1);
  assert.equal(G.NormalizeColumnSpan('abc'), 1);
  assert.equal(G.NormalizeColumnSpan(99), 6);
});

test('NormalizeColour is a palette index or null', () => {
  assert.equal(G.NormalizeColour(0), 0);
  assert.equal(G.NormalizeColour('7'), 7);
  for (const None of [null, undefined, '', 8, -1, 1.5, 'red']) {
    assert.equal(G.NormalizeColour(None), null, String(None));
  }
});

test('NormalizeKeyBind accepts the number row and the numpad only', () => {
  assert.equal(G.GROUP_KEYBINDS.length, 20);
  assert.equal(G.NormalizeKeyBind('Digit0'), 'Digit0');
  assert.equal(G.NormalizeKeyBind(' Numpad9 '), 'Numpad9');
  for (const Bad of [null, undefined, '', 'KeyA', 'Digit10', 'F1', 'digit1']) {
    assert.equal(G.NormalizeKeyBind(Bad), null, String(Bad));
  }
});

// --- Layout -------------------------------------------------------------------------

test('ParseGroupColumnCount clamps to 2..6, with 2 for anything unusable', () => {
  assert.equal(G.ParseGroupColumnCount(3), 3);
  assert.equal(G.ParseGroupColumnCount('4'), 4);
  assert.equal(G.ParseGroupColumnCount(1), 2);
  assert.equal(G.ParseGroupColumnCount(0), 2);
  assert.equal(G.ParseGroupColumnCount(12), 6);
  for (const Bad of [null, undefined, '', 'abc']) {
    assert.equal(G.ParseGroupColumnCount(Bad), G.DEFAULT_GROUP_COLUMN_COUNT, String(Bad));
  }
  assert.equal(G.DEFAULT_GROUP_COLUMN_COUNT, 2);
});

test('GetGroupSpan: full width spans every column, else its span clamped to the count', () => {
  assert.equal(G.GetGroupSpan({ isFullWidth: true, ColumnSpan: 1 }, 4), 4);
  assert.equal(G.GetGroupSpan(null, 3), 3);
  assert.equal(G.GetGroupSpan({ isFullWidth: false, ColumnSpan: 2 }, 4), 2);
  assert.equal(G.GetGroupSpan({ isFullWidth: false, ColumnSpan: 5 }, 3), 3);
  assert.equal(G.GetGroupSpan({ isFullWidth: false, ColumnSpan: 0 }, 3), 1);
});

test('GetGroupWidthValue is "full" or the stored span', () => {
  assert.equal(G.GetGroupWidthValue({ isFullWidth: true, ColumnSpan: 3 }), 'full');
  assert.equal(G.GetGroupWidthValue(undefined), 'full');
  assert.equal(G.GetGroupWidthValue({ isFullWidth: false, ColumnSpan: 3 }), '3');
});

test('BuildGroupWidthOptions lists Full Width then one entry per column', () => {
  assert.deepEqual(G.BuildGroupWidthOptions({ isFullWidth: true, ColumnSpan: 1 }, 3), [
    { Value: 'full', Label: 'Full Width' },
    { Value: '1', Label: '1 Column' },
    { Value: '2', Label: '2 Columns' },
    { Value: '3', Label: '3 Columns' },
  ]);
});

test('a stored span wider than the column count stays listed, saying how it is drawn', () => {
  const Options = G.BuildGroupWidthOptions({ isFullWidth: false, ColumnSpan: 5 }, 2);
  assert.deepEqual(Options.at(-1), { Value: '5', Label: '5 Columns (shown as 2)' });
  assert.equal(Options.length, 4);
});

// --- Colours and labels -------------------------------------------------------------

test("the palette is ShowTrak Server's, in the same order", () => {
  const Hexes = G.GROUP_COLOURS.map((C) => C.hex);
  assert.deepEqual(Hexes, [
    '#e74c3c',
    '#e67e22',
    '#f1c40f',
    '#2ecc71',
    '#3498db',
    '#9b59b6',
    '#bdc3c7',
    '#7f8c8d',
  ]);
  // With Server checked out beside Timers, check against its palette directly.
  const ServerPalette = path.join(
    __dirname,
    '..',
    '..',
    'ShowTrakServer',
    'src',
    'UI',
    'js',
    'app',
    'lib',
    'script-colours.ts'
  );
  if (fs.existsSync(ServerPalette)) {
    const ServerHexes = [
      ...fs.readFileSync(ServerPalette, 'utf8').matchAll(/hex:\s*'(#[0-9a-f]{6})'/gi),
    ].map((M) => M[1].toLowerCase());
    assert.deepEqual(Hexes, ServerHexes);
  }
});

test('GroupTintHex is the palette colour, or null when no colour was chosen', () => {
  assert.equal(G.GroupTintHex({ Colour: 4 }), '#3498db');
  assert.equal(G.GroupTintHex({ Colour: null }), null);
  assert.equal(G.GroupTintHex({ Colour: 99 }), null);
  assert.equal(G.GroupTintHex({ Colour: 1.5 }), null);
  assert.equal(G.GroupTintHex(null), null);
});

test('keybind labels: "KB 1" / "NP 1" for the list, "1 (Keyboard)" for the select', () => {
  assert.equal(G.FormatKeyBindLabel('Digit1'), 'KB 1');
  assert.equal(G.FormatKeyBindLabel('Numpad0'), 'NP 0');
  assert.equal(G.FormatKeyBindLabel(null), '');
  assert.equal(G.FormatKeyBindLabel('KeyA'), '');
  assert.equal(G.DescribeKeyBind('Digit7'), '7 (Keyboard)');
  assert.equal(G.DescribeKeyBind('Numpad3'), '3 (Numpad)');
  assert.equal(G.DescribeKeyBind('Other'), 'Other');
});

test('GroupTitle and TruncateGroupLabel', () => {
  assert.equal(G.GroupTitle(null), 'Default');
  assert.equal(G.GroupTitle({ Title: 'FOH' }), 'FOH');
  assert.equal(G.GroupTitle({ Title: '' }), 'Group');
  assert.equal(G.TruncateGroupLabel('Short'), 'Short');
  assert.equal(G.TruncateGroupLabel('A very long group title'), 'A very long g...');
  assert.equal(G.TruncateGroupLabel('A very long group title').length, 16);
});

// --- Order and membership -------------------------------------------------------------

test('SortGroups orders by weight then ID, without changing its input', () => {
  const Input = [
    { GroupID: 3, Weight: 10 },
    { GroupID: 1, Weight: 20 },
    { GroupID: 2, Weight: 10 },
  ];
  assert.deepEqual(
    G.SortGroups(Input).map((X) => X.GroupID),
    [2, 3, 1]
  );
  assert.deepEqual(
    Input.map((X) => X.GroupID),
    [3, 1, 2]
  );
});

test('EffectiveGroupID: a timer whose group is unknown is in the Default group', () => {
  const Known = new Set([1, 2]);
  assert.equal(G.EffectiveGroupID(1, Known), 1);
  assert.equal(G.EffectiveGroupID(9, Known), null);
  assert.equal(G.EffectiveGroupID(null, Known), null);
  assert.equal(G.EffectiveGroupID(undefined, Known), null);
});
