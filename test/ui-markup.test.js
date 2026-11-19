const test = require('node:test');
const assert = require('node:assert/strict');

// Markup/code consistency for the two pages the app serves, read as text (no
// DOM): src/UI/index.html (the desktop window) against the renderer sources in
// src/UI/js/app, and src/WebDashboard/index.html against dashboard-main.ts.
//
// jQuery fails silently: `$('#TYPO').on('click', ...)` binds nothing and
// throws nothing, so an id renamed on one side and not the other is a dead
// button that no other test notices. The same goes for a modal whose titlebar
// placeholder is never filled, a stylesheet variable that is never defined, or
// an inline script the Content-Security-Policy quietly refuses to run.
const path = require('node:path');
const {
  readText,
  exists,
  startTags,
  stripHtmlComments,
  htmlIds,
  listFiles,
} = require('./helpers/ui-source');
const { BUNDLES } = require('../scripts/build-renderer.js');
const { TIMER_TYPES } = require('../dist-test/common/timers.js');
const { DefaultSettings, Groups } = require('../dist/Modules/SettingsManager/DefaultSettings.js');

const APP_DIR = path.join('src', 'UI', 'js', 'app');
const DESKTOP_HTML = readText('src', 'UI', 'index.html');
const DASHBOARD_HTML = readText('src', 'WebDashboard', 'index.html');
const DESKTOP_IDS = new Set(htmlIds(DESKTOP_HTML));
const DASHBOARD_IDS = new Set(htmlIds(DASHBOARD_HTML));

/** The desktop renderer's sources (every module but the dashboard entry). */
const DESKTOP_SOURCES = new Map(
  [...listFiles(APP_DIR, /\.ts$/), ...listFiles(path.join(APP_DIR, 'lib'), /\.ts$/)]
    .filter((File) => path.basename(File) !== 'dashboard-main.ts')
    .map((File) => [File, readText(File)])
);
const DASHBOARD_SOURCE = readText(APP_DIR, 'dashboard-main.ts');

function source(Name) {
  return readText(APP_DIR, Name);
}

/**
 * Ids a source looks up by literal: '#ID' selectors (anywhere in a string,
 * including '#A, #B' lists and '#ID .child') and getElementById('ID'). An id
 * followed by `${` is a dynamic prefix ('#SETTING_${Key}').
 */
function referencedIds(Source) {
  const Static = new Set();
  const Prefixes = new Set();
  for (const M of Source.matchAll(/#([A-Z][A-Z0-9_]*)(\$\{)?/g)) {
    if (/^[0-9A-F]{3,8}$/.test(M[1])) continue; // a hex colour, not an id
    (M[2] ? Prefixes : Static).add(M[1]);
  }
  for (const M of Source.matchAll(/getElementById\(\s*['"`]([A-Z][A-Z0-9_]*)(\$\{)?/g)) {
    (M[2] ? Prefixes : Static).add(M[1]);
  }
  return { Static, Prefixes };
}

/**
 * Ids a source creates itself: id="..." in the markup it builds, `el.id = ...`,
 * and the modal header's titleId option.
 */
function createdIds(Source) {
  const Static = new Set();
  const Prefixes = new Set();
  for (const M of Source.matchAll(/(?:^|\s)id="([A-Z][A-Z0-9_]*)(\$\{)?/gm)) {
    (M[2] ? Prefixes : Static).add(M[1]);
  }
  for (const M of Source.matchAll(/\.id\s*=\s*['"`]([A-Z][A-Z0-9_]*)(\$\{)?/g)) {
    (M[2] ? Prefixes : Static).add(M[1]);
  }
  for (const M of Source.matchAll(/titleId:\s*'([A-Z][A-Z0-9_]*)'/g)) Static.add(M[1]);
  return { Static, Prefixes };
}

function union(Sources, Extract) {
  const Static = new Set();
  const Prefixes = new Set();
  for (const Text of Sources) {
    const Found = Extract(Text);
    for (const Id of Found.Static) Static.add(Id);
    for (const Prefix of Found.Prefixes) Prefixes.add(Prefix);
  }
  return { Static, Prefixes };
}

const CREATED = union(DESKTOP_SOURCES.values(), createdIds);

/** The modal elements in index.html, each with the stripped-HTML span it covers. */
function modals() {
  const Html = stripHtmlComments(DESKTOP_HTML);
  const Tags = startTags(DESKTOP_HTML);
  const Starts = Tags.filter((Tag) => (Tag.Attrs.class || '').split(/\s+/).includes('modal'));
  return Starts.map((Tag, I) => {
    const End = I + 1 < Starts.length ? Starts[I + 1].Index : Html.indexOf('<script');
    const Inner = Html.slice(Tag.Index, End);
    return { Tag, Ids: new Set(htmlIds(Inner)) };
  });
}

/** Placeholder id -> modal id, for every modal titlebar the code builds. */
function headerBuilders() {
  const Builders = new Map();
  // modals.ts: Build('SHORTCUTS_HEADER', 'Keyboard Shortcuts', 'SHOWTRAK_MODAL_SHORTCUTS');
  for (const M of source('modals.ts').matchAll(
    /Build\(\s*'([A-Z_]+)',\s*'[^']*',\s*'([A-Z_]+)'\s*\)/g
  )) {
    Builders.set(M[1], M[2]);
  }
  // Any module building its own: $('#X').empty().append(Header.$el), closing MODAL_ID.
  for (const Text of DESKTOP_SOURCES.values()) {
    const ModalId = /const MODAL_ID = '([A-Z_]+)'/.exec(Text)?.[1];
    for (const M of Text.matchAll(/\$\('#([A-Z_]+)'\)\s*\.empty\(\)\s*\.append\(Header\.\$el\)/g)) {
      Builders.set(M[1], ModalId);
    }
  }
  return Builders;
}

// --- The extractors themselves ------------------------------------------------

test('the id extractors find the references and creations they should', () => {
  const Used = union(DESKTOP_SOURCES.values(), referencedIds);
  assert.ok(Used.Static.size > 50, `only ${Used.Static.size} ids found`);
  for (const Id of ['TIMER_GRID', 'SETTINGS', 'TIMER_EDITOR_NAME', 'SHOWTRAK_MODAL_SETTINGS']) {
    assert.ok(Used.Static.has(Id), Id);
  }
  for (const Id of [
    'ALERTS_TOAST_HOST',
    'SHOWTRAK_CONFIRM_TOAST',
    'CONFIRM_TOAST_CANCEL',
    'CONFIRM_TOAST_CONFIRM',
    'TIMER_EDITOR_TITLE',
  ]) {
    assert.ok(CREATED.Static.has(Id), `created ${Id}`);
  }
  for (const Prefix of ['TIMER_', 'SETTING_']) assert.ok(CREATED.Prefixes.has(Prefix), Prefix);
});

// --- Desktop page: ids ------------------------------------------------------------

test('index.html never repeats an id', () => {
  const All = htmlIds(DESKTOP_HTML);
  const Repeated = All.filter((Id, I) => All.indexOf(Id) !== I);
  assert.deepEqual(Repeated, []);
});

test('every id the desktop code looks up by literal exists in index.html or is created by the code', () => {
  const Missing = [];
  for (const [File, Text] of DESKTOP_SOURCES) {
    for (const Id of referencedIds(Text).Static) {
      if (!DESKTOP_IDS.has(Id) && !CREATED.Static.has(Id))
        Missing.push(`${path.basename(File)}: #${Id}`);
    }
  }
  assert.deepEqual(Missing, []);
});

test('every dynamic id the desktop code looks up is one it creates', () => {
  const Missing = [];
  for (const [File, Text] of DESKTOP_SOURCES) {
    for (const Prefix of referencedIds(Text).Prefixes) {
      if (!CREATED.Prefixes.has(Prefix)) Missing.push(`${path.basename(File)}: #${Prefix}\${...}`);
    }
  }
  assert.deepEqual(Missing, []);
});

test('ids the code creates never collide with ids already in index.html', () => {
  assert.deepEqual(
    [...CREATED.Static].filter((Id) => DESKTOP_IDS.has(Id)),
    []
  );
});

test('every id index.html points at from its own attributes exists', () => {
  const Missing = [];
  for (const Tag of startTags(DESKTOP_HTML)) {
    for (const Attr of [
      'for',
      'aria-labelledby',
      'aria-describedby',
      'aria-controls',
      'data-sound-preview',
    ]) {
      const Value = Tag.Attrs[Attr];
      if (Value === undefined) continue;
      for (const Id of Value.split(/\s+/).filter(Boolean)) {
        if (!DESKTOP_IDS.has(Id)) Missing.push(`${Attr}="${Id}"`);
      }
    }
  }
  assert.deepEqual(Missing, []);
});

test('every element id the code passes to a helper exists in index.html', () => {
  const Wanted = new Set();
  for (const Text of DESKTOP_SOURCES.values()) {
    for (const M of Text.matchAll(/(?:openModal|closeModal|onceHidden)\('([A-Z_]+)'/g))
      Wanted.add(M[1]);
    for (const M of Text.matchAll(/const MODAL_ID = '([A-Z_]+)'/g)) Wanted.add(M[1]);
  }
  // mode.ts: Wire('MODE_BTN_SHOW', 'SHOW')
  for (const M of source('mode.ts').matchAll(/Wire\('([A-Z_]+)'/g)) Wanted.add(M[1]);
  assert.ok(Wanted.size >= 8, `only ${Wanted.size} found`);
  assert.deepEqual(
    [...Wanted].filter((Id) => !DESKTOP_IDS.has(Id)),
    []
  );
});

// --- Desktop page: modals -----------------------------------------------------------

test('every modal the code opens or closes is a Bootstrap modal in index.html', () => {
  const ModalIds = new Set(modals().map((M) => M.Tag.Attrs.id));
  for (const Text of DESKTOP_SOURCES.values()) {
    for (const M of Text.matchAll(/(?:openModal|closeModal)\('([A-Z_]+)'\)/g)) {
      assert.ok(ModalIds.has(M[1]), `#${M[1]} is not a .modal`);
    }
    const ModalId = /const MODAL_ID = '([A-Z_]+)'/.exec(Text)?.[1];
    if (ModalId) assert.ok(ModalIds.has(ModalId), `#${ModalId} is not a .modal`);
  }
});

/** A modal that cannot be dismissed (static backdrop, Escape off): an answer is required. */
function IsPrompt(Tag) {
  return Tag.Attrs['data-bs-backdrop'] === 'static' && Tag.Attrs['data-bs-keyboard'] === 'false';
}

test('the only modals that cannot be dismissed are the show-file prompts', () => {
  assert.deepEqual(
    modals()
      .filter((M) => IsPrompt(M.Tag))
      .map((M) => M.Tag.Attrs.id)
      .sort(),
    ['SHOWTRAK_MODAL_MIGRATE', 'SHOWTRAK_MODAL_NO_SHOW', 'SHOWTRAK_MODAL_UPGRADE_SHOW']
  );
});

test('every modal has a titlebar placeholder, inside it, that the code fills for that modal', () => {
  const Builders = headerBuilders();
  const Found = modals();
  assert.ok(Found.length >= 8, `only ${Found.length} modals found`);
  for (const { Tag, Ids } of Found) {
    const ModalId = Tag.Attrs.id;
    assert.ok(ModalId, 'a modal without an id cannot be opened');
    assert.equal(
      Tag.Attrs.tabindex,
      '-1',
      `#${ModalId} needs tabindex="-1" for Escape to close it`
    );
    const Placeholder = Tag.Attrs['aria-labelledby'];
    assert.ok(Placeholder, `#${ModalId} has no aria-labelledby titlebar`);
    assert.ok(Ids.has(Placeholder), `#${Placeholder} is not inside #${ModalId}`);
    // The show-file prompts (no show open, upgrade, save existing timers) are
    // ShowTrak Server's: a question that must be answered, so no close button
    // and no titlebar, only their own heading.
    if (IsPrompt(Tag)) continue;
    assert.equal(
      Builders.get(Placeholder),
      ModalId,
      `nothing builds #${Placeholder} for #${ModalId}`
    );
  }
  // ...and no builder targets a placeholder that is not a modal's.
  const Placeholders = new Set(Found.map((M) => M.Tag.Attrs['aria-labelledby']));
  assert.deepEqual(
    [...Builders.keys()].filter((Id) => !Placeholders.has(Id)),
    []
  );
});

// --- Desktop page: menus and shortcuts ------------------------------------------------

test('every keyboard command that runs a menu action names one menu.ts has', () => {
  const Block = /const MENU_ACTIONS\b[^\n]*=\s*\{\n([\s\S]*?)\n\};/.exec(source('keyboard.ts'));
  assert.ok(Block, 'MENU_ACTIONS not found in keyboard.ts');
  const Targets = [...Block[1].matchAll(/:\s*'([A-Z_]+)'/g)].map((M) => M[1]);
  assert.ok(Targets.length >= 5, `only ${Targets.length} found`);
  const Actions = new Set(menuActions());
  assert.deepEqual(
    Targets.filter((Id) => !Actions.has(Id)),
    []
  );
});

test('every element keyboard.ts clicks exists in index.html', () => {
  const Ids = [...source('keyboard.ts').matchAll(/getElementById\('([A-Z_]+)'\)/g)].map(
    (M) => M[1]
  );
  assert.ok(Ids.length >= 2);
  assert.deepEqual(
    Ids.filter((Id) => !DESKTOP_IDS.has(Id)),
    []
  );
});

/** The keys of menu.ts's ACTIONS table. */
function menuActions() {
  const Block = /const ACTIONS\b[^\n]*=\s*\{\n([\s\S]*?)\n\};/.exec(source('menu.ts'));
  assert.ok(Block, 'ACTIONS not found in menu.ts');
  return [...Block[1].matchAll(/^\s*([A-Z_]+):\s*\(\)\s*=>/gm)].map((M) => M[1]);
}

test('every menu action is a button in index.html, or is reached from the macOS menu', () => {
  // The selection's run controls, Select All and New Timer are in the macOS
  // menu bar (and on the keyboard and the right-click menu), not the page's menus.
  const Actions = menuActions();
  assert.ok(Actions.length >= 10, `only ${Actions.length} actions found`);
  const FromAppMenu = new Set(
    [...readText('src', 'main', 'app-menu.ts').matchAll(/Action\('([A-Z_]+)'\)/g)].map((M) => M[1])
  );
  assert.deepEqual(
    Actions.filter((Id) => !DESKTOP_IDS.has(Id) && !FromAppMenu.has(Id)),
    []
  );
});

test('every macOS app menu item reaches a menu action or a button in the page', () => {
  // menu.ts Run(): an ACTIONS key runs its action; anything else clicks the
  // element with that id. Either must exist, or the menu item does nothing.
  const Actions = new Set(menuActions());
  const Sent = [...readText('src', 'main', 'app-menu.ts').matchAll(/Action\('([A-Z_]+)'\)/g)].map(
    (M) => M[1]
  );
  assert.ok(Sent.length >= 10, `only ${Sent.length} app menu actions found`);
  assert.deepEqual(
    Sent.filter((Id) => !Actions.has(Id) && !DESKTOP_IDS.has(Id)),
    []
  );
});

// --- Desktop page: the timer editor -------------------------------------------------

test("the timer editor's sections are exactly the ones timer-editor.ts shows and hides", () => {
  const InHtml = new Set(
    startTags(DESKTOP_HTML)
      .map((Tag) => Tag.Attrs['data-timer-field'])
      .filter(Boolean)
  );
  const InCode = new Set(
    [...source('timer-editor.ts').matchAll(/\[data-timer-field="([a-z]+)"\]/g)].map((M) => M[1])
  );
  assert.deepEqual([...InHtml].sort(), ['duration', 'ending', 'warning']);
  assert.deepEqual([...InCode].sort(), [...InHtml].sort());
});

test("the editor's type picker offers exactly the timer types", () => {
  const Select = /<select\b[^>]*id="TIMER_EDITOR_TYPE"[^>]*>([\s\S]*?)<\/select>/.exec(
    DESKTOP_HTML
  );
  assert.ok(Select, '#TIMER_EDITOR_TYPE not found');
  const Values = [...Select[1].matchAll(/<option value="([^"]+)"/g)].map((M) => M[1]);
  assert.deepEqual(Values, [...TIMER_TYPES]);
});

// --- Desktop page: settings referenced from the renderer ------------------------------

test('every setting the renderer reads by key exists in the settings catalogue', () => {
  const Keys = new Set(DefaultSettings.map((S) => S.Key));
  const Read = new Set();
  for (const Text of DESKTOP_SOURCES.values()) {
    for (const M of Text.matchAll(/(?:SettingValue|CurrentValue)\('([A-Z0-9_]+)'\)/g))
      Read.add(M[1]);
    for (const M of Text.matchAll(/S\.Key === '([A-Z0-9_]+)'/g)) Read.add(M[1]);
  }
  assert.ok(Read.has('ALERT_SOUND_VOLUME'));
  assert.deepEqual(
    [...Read].filter((Key) => !Keys.has(Key)),
    []
  );
});

test('every "Preferences, <section>" pointer in the renderer names a real settings tab', () => {
  const Titles = new Set(Groups.map((G) => G.Title));
  let Checked = 0;
  for (const [File, Text] of DESKTOP_SOURCES) {
    for (const M of Text.matchAll(/Preferences, ([A-Z][A-Za-z ]*?)[).]/g)) {
      assert.ok(Titles.has(M[1]), `${path.basename(File)} points at "${M[1]}"`);
      Checked += 1;
    }
  }
  assert.ok(Checked >= 3, `only ${Checked} pointers found`);
});

// --- Desktop page: Content-Security-Policy and scripts ---------------------------------

function cspOf(Html) {
  const Meta = startTags(Html).find(
    (Tag) =>
      Tag.Name === 'meta' &&
      (Tag.Attrs['http-equiv'] || '').toLowerCase() === 'content-security-policy'
  );
  if (!Meta) return null;
  const Directives = new Map();
  for (const Part of Meta.Attrs.content.split(';')) {
    const [Name, ...Sources] = Part.trim().split(/\s+/);
    if (Name) Directives.set(Name, Sources);
  }
  return Directives;
}

test('index.html locks scripts to the app itself with a Content-Security-Policy', () => {
  const Csp = cspOf(DESKTOP_HTML);
  assert.ok(Csp, 'no Content-Security-Policy meta tag');
  assert.deepEqual(Csp.get('script-src'), ["'self'"]);
  assert.deepEqual(Csp.get('default-src'), ["'self'"]);
  assert.deepEqual(Csp.get('object-src'), ["'none'"]);
  assert.ok(Csp.has('base-uri'), 'base-uri should be pinned');
});

test('the policy lets imported sounds play from the data URLs sounds.ts builds', () => {
  assert.match(source('sounds.ts'), /DataURL/);
  assert.ok(cspOf(DESKTOP_HTML).get('media-src').includes('data:'));
});

/** <script> elements: their attributes and whatever sits between the tags. */
function scripts(Html) {
  return [...stripHtmlComments(Html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)].map(
    (M) => ({
      Src: /\ssrc="([^"]*)"/.exec(M[1])?.[1],
      Body: M[2],
    })
  );
}

for (const [Name, Html] of [
  ['index.html', DESKTOP_HTML],
  ['the Web Dashboard page', DASHBOARD_HTML],
]) {
  test(`${Name} has no inline script bodies, only src= scripts`, () => {
    const Found = scripts(Html);
    assert.ok(Found.length > 0);
    for (const Script of Found) {
      assert.ok(Script.Src, 'a <script> without src= is inline script');
      assert.equal(Script.Body.trim(), '', `${Script.Src} also has an inline body`);
    }
  });

  test(`${Name} has no inline event handlers or javascript: URLs`, () => {
    for (const Tag of startTags(Html)) {
      for (const [Attr, Value] of Object.entries(Tag.Attrs)) {
        assert.doesNotMatch(Attr, /^on/, `<${Tag.Name} ${Attr}=...> is blocked by the CSP`);
        assert.doesNotMatch(Value, /^\s*javascript:/i, `<${Tag.Name} ${Attr}="${Value}">`);
      }
    }
  });
}

test('every script and stylesheet index.html loads is shipped or built', () => {
  const Desktop = BUNDLES.find((B) => path.basename(B.outfile) === 'bundle.js');
  assert.ok(Desktop, 'no desktop bundle in scripts/build-renderer.js');
  const BuiltRel = path
    .relative(path.join(__dirname, '..', 'dist', 'UI'), Desktop.outfile)
    .split(path.sep)
    .join('/');
  const Refs = [
    ...scripts(DESKTOP_HTML).map((S) => S.Src),
    ...startTags(DESKTOP_HTML)
      .filter((Tag) => Tag.Name === 'link' || Tag.Name === 'img')
      .map((Tag) => Tag.Attrs.href ?? Tag.Attrs.src),
  ];
  assert.ok(Refs.length >= 6);
  for (const Ref of Refs) {
    assert.match(Ref, /^\.\//, `${Ref} should be a local relative path`);
    const Rel = Ref.slice(2);
    if (Rel === BuiltRel) continue; // written by build-renderer into dist/UI
    assert.ok(exists('src', 'UI', ...Rel.split('/')), `missing src/UI/${Rel}`);
  }
  assert.ok(Refs.includes(`./${BuiltRel}`), 'index.html does not load the desktop bundle');
});

// --- Web Dashboard page -----------------------------------------------------------------

test('every id the Web Dashboard script looks up exists in its page', () => {
  const Used = referencedIds(DASHBOARD_SOURCE);
  assert.ok(Used.Static.size >= 3);
  assert.deepEqual(
    [...Used.Static].filter((Id) => !DASHBOARD_IDS.has(Id)),
    []
  );
  const Created = createdIds(DASHBOARD_SOURCE);
  assert.deepEqual(
    [...Used.Prefixes].filter((Prefix) => !Created.Prefixes.has(Prefix)),
    []
  );
});

/** The /ui/<folder> mounts the dashboard server exposes (Modules/WebDashboard). */
function servedUiFolders() {
  const M = /for \(const Folder of \[([^\]]+)\]\)/.exec(
    readText('src', 'Modules', 'WebDashboard', 'index.ts')
  );
  assert.ok(M, 'the /ui folder list was not found in Modules/WebDashboard');
  return new Set([...M[1].matchAll(/'([^']+)'/g)].map((F) => F[1]));
}

/** Check one absolute URL the dashboard (page or service worker) fetches. */
function assertDashboardAsset(Url, Served, DashboardBundle) {
  if (Url === '/' || Url === '/index.html') return;
  if (Url === '/socket.io/socket.io.js') return; // served by Socket.IO itself
  if (Url === `/${DashboardBundle}`) return; // written by build-renderer
  const UiPath = /^\/ui\/([^/]+)\/(.+)$/.exec(Url);
  if (UiPath) {
    assert.ok(Served.has(UiPath[1]), `${Url}: /ui/${UiPath[1]} is not served`);
    assert.ok(
      exists('src', 'UI', UiPath[1], ...UiPath[2].split('/')),
      `${Url} is missing from src/UI`
    );
    return;
  }
  assert.ok(
    exists('src', 'WebDashboard', ...Url.slice(1).split('/')),
    `${Url} is missing from src/WebDashboard`
  );
}

test('everything the Web Dashboard page loads is served by the dashboard host', () => {
  const Served = servedUiFolders();
  const Bundle = path.basename(BUNDLES.find((B) => /WebDashboard/.test(B.outfile)).outfile);
  const Refs = [
    ...scripts(DASHBOARD_HTML).map((S) => S.Src),
    ...startTags(DASHBOARD_HTML)
      .filter((Tag) => Tag.Name === 'link' || Tag.Name === 'img')
      .map((Tag) => Tag.Attrs.href ?? Tag.Attrs.src),
  ];
  assert.ok(Refs.includes(`/${Bundle}`), 'the dashboard page does not load its bundle');
  for (const Ref of Refs) {
    assert.match(Ref, /^\//, `${Ref} should be a same-origin absolute path`);
    assertDashboardAsset(Ref, Served, Bundle);
  }
});

test("everything the dashboard's service worker pre-caches is served by the host", () => {
  const Served = servedUiFolders();
  const Bundle = path.basename(BUNDLES.find((B) => /WebDashboard/.test(B.outfile)).outfile);
  const Block = /const STATIC_ASSETS = \[([\s\S]*?)\];/.exec(
    readText('src', 'WebDashboard', 'service-worker.js')
  );
  assert.ok(Block, 'STATIC_ASSETS not found');
  const Assets = [...Block[1].matchAll(/'([^']+)'/g)].map((M) => M[1]);
  assert.ok(Assets.length >= 5);
  // cache.addAll rejects as a whole on one 404, leaving no offline shell at all.
  for (const Asset of Assets) assertDashboardAsset(Asset, Served, Bundle);
});

// --- Stylesheets ------------------------------------------------------------------------

const CSS_PARTS = listFiles(path.join('src', 'UI', 'css', 'parts'), /\.css$/);

function definedProperties() {
  const Defined = new Set();
  for (const File of CSS_PARTS) {
    for (const M of readText(File).matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) Defined.add(M[1]);
  }
  return Defined;
}

function usedProperties(File) {
  return new Set([...readText(File).matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((M) => M[1]));
}

test("every custom property Timers' own stylesheet uses is defined", () => {
  const Defined = definedProperties();
  const Used = usedProperties(path.join('src', 'UI', 'css', 'parts', '10-timers.css'));
  assert.ok(Used.size > 10, `only ${Used.size} var() uses found`);
  assert.deepEqual(
    [...Used].filter((Name) => !Defined.has(Name)),
    []
  );
});

test('every custom property used by any stylesheet part is defined', () => {
  // The parts before 10-timers.css are extracted from ShowTrak Server by
  // scripts/sync-server-css.js; a sync that drops a token shows up here.
  const Defined = definedProperties();
  const Missing = [];
  for (const File of CSS_PARTS) {
    for (const Name of usedProperties(File)) {
      if (!Defined.has(Name)) Missing.push(`${path.basename(File)}: ${Name}`);
    }
  }
  assert.deepEqual(Missing, []);
});
