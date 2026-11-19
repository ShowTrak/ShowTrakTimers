const test = require('node:test');
const assert = require('node:assert/strict');

// Covers src/UI/js/app/lib/osc-format.ts: how the OSC Reference modal draws an
// address (each ":param" as a highlighted [param]) and which section it lists
// it under. FormatRoutePath returns markup that is injected with jQuery's
// .append(), so it is an HTML sink: every segment must go through Safe().
//
// The last tests run the real route table (src/Modules/OSC/routes.ts, loaded
// from the per-file main-process build in dist/) through both functions, so a
// new route that would render wrongly or land in no section is caught here.
//
// Loaded from dist-test/ (see test/renderer-timer-tile.test.js for why).
const {
  FormatRoutePath,
  ROUTE_SECTION_ORDER,
  RouteSection,
} = require('../dist-test/UI/js/app/lib/osc-format.js');
const { ROUTES } = require('../dist/Modules/OSC/routes.js');

// --- FormatRoutePath --------------------------------------------------------

test('each segment gets its own slash, and a :param is shown as a highlighted [param]', () => {
  assert.equal(
    FormatRoutePath('/ShowTrak/Timer/:TimerID/Start'),
    '<span>/</span><span>ShowTrak</span>' +
      '<span>/</span><span>Timer</span>' +
      '<span>/</span><span class="text-info">[TimerID]</span>' +
      '<span>/</span><span>Start</span>'
  );
});

test('HTML in a segment or a parameter name is escaped', () => {
  const Out = FormatRoutePath(`/a<b>&"c'/:x<script>"`);
  assert.doesNotMatch(Out, /<b>|<script>/);
  assert.match(Out, /<span>a&lt;b&gt;&amp;&quot;c&#39;<\/span>/);
  assert.match(Out, /<span class="text-info">\[x&lt;script&gt;&quot;\]<\/span>/);
});

test('an empty or root path renders as a lone slash', () => {
  for (const Path of ['', '/', '//', undefined, null]) {
    assert.equal(FormatRoutePath(Path), '<span>/</span>', String(Path));
  }
});

test('repeated and trailing slashes do not produce empty segments', () => {
  assert.equal(FormatRoutePath('//ShowTrak///All/'), FormatRoutePath('/ShowTrak/All'));
});

test('only a leading colon marks a parameter', () => {
  assert.equal(FormatRoutePath('/a:b'), '<span>/</span><span>a:b</span>');
});

// --- RouteSection -----------------------------------------------------------

test('routes are grouped by their second path segment', () => {
  assert.equal(RouteSection('/ShowTrak/Timer/:TimerID/Start'), 'Timer');
  assert.equal(RouteSection('/ShowTrak/All/Pause'), 'All Timers');
  assert.equal(RouteSection('/ShowTrak/Group/:Slug/Start'), 'Groups');
  assert.equal(RouteSection('/ShowTrak/Shutdown'), 'Control');
});

test('anything unrecognised falls under Control', () => {
  for (const Path of ['', '/', '/ShowTrak', '/ShowTrak/Other/x', undefined, null]) {
    assert.equal(RouteSection(Path), 'Control', String(Path));
  }
});

test('sections are listed Control, then Timer, then All Timers', () => {
  assert.deepEqual([...ROUTE_SECTION_ORDER], ['Control', 'Timer', 'Groups', 'All Timers']);
});

// --- The real route table -----------------------------------------------------

test('every real OSC route renders back to its own address', () => {
  assert.ok(ROUTES.length > 0);
  for (const Route of ROUTES) {
    const Text = FormatRoutePath(Route.Path).replace(/<[^>]+>/g, '');
    assert.equal(Text, Route.Path.replace(/:([^/]+)/g, '[$1]'), Route.Path);
  }
});

test('every real OSC route lands in a listed section, and every section has routes', () => {
  const Seen = new Set();
  for (const Route of ROUTES) {
    const Section = RouteSection(Route.Path);
    assert.ok(ROUTE_SECTION_ORDER.includes(Section), `${Route.Path} -> ${Section}`);
    Seen.add(Section);
  }
  assert.deepEqual([...Seen].sort(), [...ROUTE_SECTION_ORDER].sort());
});
