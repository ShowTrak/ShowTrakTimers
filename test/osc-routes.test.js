const test = require('node:test');
const assert = require('node:assert/strict');
const { recordingManager } = require('./helpers/main-mocks');

// Exercises src/Modules/OSC/routes.ts: the OSC address space and what each
// address does.
//
// Show files in QLab, Companion and friends hard-code these addresses, so the
// 1.x list is pinned here: renaming or dropping one silently breaks every show
// that uses it, and nobody finds out until the cue fires. The handlers are
// driven with a recording OscRouteContext, so each test sees exactly which
// timer call an address turns into and what the operator is told.

const { ROUTES, MatchRoute } = require('../dist/Modules/OSC/routes');

/** A recording OscRouteContext; `returns` overrides individual methods. */
function fakeContext(returns = {}) {
  return recordingManager({
    Control: async () => null,
    ControlAll: async () => 2,
    Rename: async () => null,
    SetDuration: async () => null,
    JumpTo: async () => null,
    TimerStatus: async () => 'PAUSED',
    CountWithStatus: async () => 1,
    Quit: () => undefined,
    ...returns,
  });
}

/** Match an address and run its handler, as the OSC server does. */
async function dispatch(Address, Args = [], Context = fakeContext()) {
  const Match = MatchRoute(Address, Args);
  assert.ok(Match, `no route matched ${Address}`);
  return Match.Route.Handler(Match.Params, Context);
}

const Ok = (Message) => ({ Ok: true, Message });
const Fail = (Message) => ({ Ok: false, Message });

// --- The 1.x address list --------------------------------------------------

// [address sent, route it must reach, params it must carry]
const ADDRESSES_1X = [
  ['/ShowTrak/Shutdown', '/ShowTrak/Shutdown', {}],
  ['/ShowTrak/Timer/4/Start', '/ShowTrak/Timer/:TimerID/Start', { TimerID: '4' }],
  ['/ShowTrak/Timer/4/Stop', '/ShowTrak/Timer/:TimerID/Stop', { TimerID: '4' }],
  ['/ShowTrak/Timer/4/Pause', '/ShowTrak/Timer/:TimerID/Pause', { TimerID: '4' }],
  ['/ShowTrak/Timer/4/Unpause', '/ShowTrak/Timer/:TimerID/Unpause', { TimerID: '4' }],
  ['/ShowTrak/Timer/4/Resume', '/ShowTrak/Timer/:TimerID/Resume', { TimerID: '4' }],
  [
    '/ShowTrak/Timer/4/SetLabel/Interval',
    '/ShowTrak/Timer/:TimerID/SetLabel/:Name',
    { TimerID: '4', Name: 'Interval' },
  ],
  [
    '/ShowTrak/Timer/4/SetDuration/90000',
    '/ShowTrak/Timer/:TimerID/SetDuration/:ms',
    { TimerID: '4', ms: '90000' },
  ],
  [
    '/ShowTrak/Timer/4/JumpToTime/30000',
    '/ShowTrak/Timer/:TimerID/JumpToTime/:TimeInMS',
    { TimerID: '4', TimeInMS: '30000' },
  ],
  ['/ShowTrak/All/Start', '/ShowTrak/All/Start', {}],
  ['/ShowTrak/All/Stop', '/ShowTrak/All/Stop', {}],
  ['/ShowTrak/All/Pause', '/ShowTrak/All/Pause', {}],
  ['/ShowTrak/All/Unpause', '/ShowTrak/All/Unpause', {}],
  ['/ShowTrak/All/Resume', '/ShowTrak/All/Resume', {}],
];

test('every 1.x OSC address still reaches the route it always did', () => {
  for (const [Address, Path, Params] of ADDRESSES_1X) {
    const Match = MatchRoute(Address);
    assert.ok(Match, `${Address} no longer matches any route`);
    assert.equal(Match.Route.Path, Path, `${Address} reached the wrong route`);
    assert.deepEqual(Match.Params, Params, `${Address} carried the wrong parameters`);
  }
});

test('every 1.x route path is still declared, exactly as written', () => {
  const Paths = ROUTES.map((R) => R.Path);
  for (const [, Path] of ADDRESSES_1X) {
    assert.ok(Paths.includes(Path), `the 1.x route ${Path} was renamed or removed`);
  }
});

test('route paths are unique and every route has a title for the OSC Reference', () => {
  const Paths = ROUTES.map((R) => R.Path);
  assert.equal(new Set(Paths).size, Paths.length, 'two routes share a path');
  for (const Route of ROUTES) {
    assert.match(Route.Path, /^\/ShowTrak\//, `${Route.Path} is outside /ShowTrak`);
    assert.equal(typeof Route.Title, 'string');
    assert.ok(Route.Title.trim().length > 0, `${Route.Path} has no title`);
    assert.equal(typeof Route.Handler, 'function');
  }
});

// --- MatchRoute -----------------------------------------------------------

test('a literal address matches with no parameters', () => {
  const Match = MatchRoute('/ShowTrak/All/Pause');
  assert.equal(Match.Route.Path, '/ShowTrak/All/Pause');
  assert.deepEqual(Match.Params, {});
});

test('a :param segment captures whatever was sent there, as a string', () => {
  const Match = MatchRoute('/ShowTrak/Timer/abc/Start');
  assert.equal(Match.Route.Path, '/ShowTrak/Timer/:TimerID/Start');
  // Validation is the handler's job; the matcher only captures.
  assert.deepEqual(Match.Params, { TimerID: 'abc' });
});

test('the trailing parameter can be sent as the first OSC argument instead', () => {
  // The only way to send a name with a space or a slash in it.
  const Label = MatchRoute('/ShowTrak/Timer/3/SetLabel', ['Walk In / Doors']);
  assert.equal(Label.Route.Path, '/ShowTrak/Timer/:TimerID/SetLabel/:Name');
  assert.deepEqual(Label.Params, { TimerID: '3', Name: 'Walk In / Doors' });

  // QLab sends numbers as OSC ints/floats; they arrive stringified like a segment.
  const Duration = MatchRoute('/ShowTrak/Timer/3/SetDuration', [90000]);
  assert.deepEqual(Duration.Params, { TimerID: '3', ms: '90000' });
  const Jump = MatchRoute('/ShowTrak/Timer/3/JumpToTime', [1500.5]);
  assert.deepEqual(Jump.Params, { TimerID: '3', TimeInMS: '1500.5' });
});

test('only the first argument is used, and a parameter in the path wins over it', () => {
  assert.deepEqual(MatchRoute('/ShowTrak/Timer/3/SetLabel', ['A', 'B']).Params, {
    TimerID: '3',
    Name: 'A',
  });
  assert.deepEqual(MatchRoute('/ShowTrak/Timer/3/SetLabel/FromPath', ['FromArg']).Params, {
    TimerID: '3',
    Name: 'FromPath',
  });
});

test('a trailing parameter missing from both the path and the arguments does not match', () => {
  assert.equal(MatchRoute('/ShowTrak/Timer/3/SetLabel'), null);
  assert.equal(MatchRoute('/ShowTrak/Timer/3/SetLabel', []), null);
  assert.equal(MatchRoute('/ShowTrak/Timer/3/SetDuration', []), null);
});

test('only a trailing parameter can come from an argument', () => {
  // The timer ID sits mid-path, so it can never be supplied as an argument.
  assert.equal(MatchRoute('/ShowTrak/Timer/Start', ['3']), null);
  // A route that ends in a literal never takes an argument as its last segment.
  assert.equal(MatchRoute('/ShowTrak/Timer/3', ['Start']), null);
  assert.equal(MatchRoute('/ShowTrak/All', ['Start']), null);
});

test('an address with the wrong number of segments does not match', () => {
  assert.equal(MatchRoute('/ShowTrak/Timer/3/Start/Now'), null);
  assert.equal(MatchRoute('/ShowTrak/Timer/3'), null);
  assert.equal(MatchRoute('/ShowTrak/All'), null);
  assert.equal(MatchRoute('/ShowTrak/Shutdown/Now'), null);
  assert.equal(MatchRoute('/ShowTrak/Timer/3/SetLabel/A/B'), null);
});

test('an unknown address does not match', () => {
  assert.equal(MatchRoute('/ShowTrak/Timer/3/Explode'), null);
  assert.equal(MatchRoute('/ShowTrak/All/Explode'), null);
  assert.equal(MatchRoute('/API/Shutdown'), null);
  assert.equal(MatchRoute('/Other/Timer/3/Start'), null);
});

test('addresses are case-sensitive, as in 1.x', () => {
  assert.equal(MatchRoute('/showtrak/all/start'), null);
  assert.equal(MatchRoute('/ShowTrak/timer/3/start'), null);
});

test('an empty or missing address matches nothing and never throws', () => {
  for (const Address of ['', '/', '//', undefined, null]) {
    assert.equal(MatchRoute(Address), null, `${String(Address)} matched a route`);
    assert.equal(MatchRoute(Address, ['x']), null, `${String(Address)} + arg matched a route`);
  }
});

test('MatchRoute searches the route list it is given, first match first', () => {
  const Calls = [];
  const Routes = [
    { Path: '/X/:A', Title: 'first', Handler: async () => Calls.push('first') },
    { Path: '/X/Literal', Title: 'second', Handler: async () => Calls.push('second') },
  ];
  assert.equal(MatchRoute('/X/Literal', [], Routes).Route.Title, 'first');
  assert.deepEqual(MatchRoute('/X/Literal', [], Routes).Params, { A: 'Literal' });
  assert.equal(MatchRoute('/ShowTrak/All/Start', [], Routes), null);
});

// --- /ShowTrak/Shutdown -----------------------------------------------------

test('Shutdown asks the app to quit once and reports it', async () => {
  const Context = fakeContext();
  assert.deepEqual(await dispatch('/ShowTrak/Shutdown', [], Context), Ok('Shutting down'));
  assert.equal(Context.__callsTo('Quit').length, 1);
  assert.equal(Context.__calls.length, 1, 'Shutdown touched a timer');
});

// --- Single-timer run control -------------------------------------------------

for (const [Verb, Action, Past] of [
  ['Start', 'Start', 'started'],
  ['Stop', 'Stop', 'stopped'],
  ['Pause', 'Pause', 'paused'],
  ['Unpause', 'Unpause', 'resumed'],
]) {
  test(`Timer/:TimerID/${Verb} controls that timer and reports "${Past}"`, async () => {
    const Context = fakeContext();
    assert.deepEqual(
      await dispatch(`/ShowTrak/Timer/12/${Verb}`, [], Context),
      Ok(`Timer 12 ${Past}`)
    );
    assert.deepEqual(Context.__callsTo('Control')[0].args, [12, Action]);
  });

  test(`Timer/:TimerID/${Verb} reports the timer manager's error`, async () => {
    const Context = fakeContext({ Control: async () => 'Timer not found' });
    assert.deepEqual(
      await dispatch(`/ShowTrak/Timer/99/${Verb}`, [], Context),
      Fail('Timer 99: Timer not found')
    );
  });
}

test('an invalid timer ID is rejected before any timer is touched', async () => {
  const Routes = [
    '/ShowTrak/Timer/{ID}/Start',
    '/ShowTrak/Timer/{ID}/Stop',
    '/ShowTrak/Timer/{ID}/Pause',
    '/ShowTrak/Timer/{ID}/Unpause',
    '/ShowTrak/Timer/{ID}/Resume',
    '/ShowTrak/Timer/{ID}/SetLabel/Name',
    '/ShowTrak/Timer/{ID}/SetDuration/1000',
    '/ShowTrak/Timer/{ID}/JumpToTime/1000',
  ];
  for (const ID of ['0', '-1', '1.5', 'abc', 'NaN', 'Infinity']) {
    for (const Template of Routes) {
      const Context = fakeContext();
      const Address = Template.replace('{ID}', ID);
      assert.deepEqual(
        await dispatch(Address, [], Context),
        Fail(`Invalid timer ID "${ID}"`),
        Address
      );
      assert.equal(Context.__calls.length, 0, `${Address} reached the timer manager`);
    }
  }
});

test('a timer ID with a leading zero is the same timer', async () => {
  const Context = fakeContext();
  await dispatch('/ShowTrak/Timer/007/Start', [], Context);
  assert.deepEqual(Context.__callsTo('Control')[0].args, [7, 'Start']);
});

// --- Resume -------------------------------------------------------------------

test('Resume unpauses a paused timer', async () => {
  const Context = fakeContext({ TimerStatus: async () => 'PAUSED' });
  assert.deepEqual(await dispatch('/ShowTrak/Timer/5/Resume', [], Context), Ok('Timer 5 resumed'));
  assert.deepEqual(Context.__callsTo('TimerStatus')[0].args, [5]);
  assert.deepEqual(Context.__callsTo('Control')[0].args, [5, 'Unpause']);
});

test('Resume leaves a timer that is not paused alone', async () => {
  for (const Status of ['STANDBY', 'RUNNING', 'COMPLETE', 'OVERRUN']) {
    const Context = fakeContext({ TimerStatus: async () => Status });
    assert.deepEqual(
      await dispatch('/ShowTrak/Timer/5/Resume', [], Context),
      Fail('Timer 5 is not paused'),
      Status
    );
    assert.equal(Context.__callsTo('Control').length, 0, `${Status} timer was controlled`);
  }
});

test('Resume reports a timer that does not exist', async () => {
  const Context = fakeContext({ TimerStatus: async () => null });
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/5/Resume', [], Context),
    Fail('Timer 5: Timer not found')
  );
  assert.equal(Context.__callsTo('Control').length, 0);
});

test('Resume reports an unpause that fails', async () => {
  const Context = fakeContext({ Control: async () => 'Something went wrong' });
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/5/Resume', [], Context),
    Fail('Timer 5: Something went wrong')
  );
});

// --- SetLabel -------------------------------------------------------------------

test('SetLabel renames the timer to the name in the path', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetLabel/Interval', [], Context),
    Ok('Timer 3 renamed to "Interval"')
  );
  assert.deepEqual(Context.__callsTo('Rename')[0].args, [3, 'Interval']);
});

test('SetLabel URI-decodes a name sent in the path', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetLabel/Walk%20In%20%2F%20Doors', [], Context),
    Ok('Timer 3 renamed to "Walk In / Doors"')
  );
  assert.deepEqual(Context.__callsTo('Rename')[0].args, [3, 'Walk In / Doors']);
});

test('SetLabel keeps a name that is not valid URI encoding as it was sent', async () => {
  const Context = fakeContext();
  await dispatch('/ShowTrak/Timer/3/SetLabel/100%', [], Context);
  await dispatch('/ShowTrak/Timer/3/SetLabel', ['50% Off %E0%A4%A'], Context);
  assert.deepEqual(
    Context.__callsTo('Rename').map((C) => C.args),
    [
      [3, '100%'],
      [3, '50% Off %E0%A4%A'],
    ]
  );
});

test('SetLabel takes the name from a string argument and trims it', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetLabel', ['  Walk In  '], Context),
    Ok('Timer 3 renamed to "Walk In"')
  );
  assert.deepEqual(Context.__callsTo('Rename')[0].args, [3, 'Walk In']);
});

test('SetLabel refuses an empty or blank name', async () => {
  for (const Args of [[''], ['   '], ['%20%20'], ['\t']]) {
    const Context = fakeContext();
    assert.deepEqual(
      await dispatch('/ShowTrak/Timer/3/SetLabel', Args, Context),
      Fail('Timer name cannot be empty'),
      JSON.stringify(Args)
    );
    assert.equal(Context.__callsTo('Rename').length, 0);
  }
  // Encoded whitespace in the path decodes to nothing as well.
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetLabel/%20', [], Context),
    Fail('Timer name cannot be empty')
  );
  assert.equal(Context.__callsTo('Rename').length, 0);
});

test('SetLabel checks the timer ID before the name', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/x/SetLabel', [''], Context),
    Fail('Invalid timer ID "x"')
  );
});

test('SetLabel reports a rename the timer manager refuses', async () => {
  const Context = fakeContext({ Rename: async () => 'Timer not found' });
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/8/SetLabel/Foo', [], Context),
    Fail('Timer 8: Timer not found')
  );
});

// --- SetDuration ------------------------------------------------------------------

test('SetDuration sets a whole number of milliseconds', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetDuration/90000', [], Context),
    Ok('Timer 3 duration set to 90000 ms')
  );
  assert.deepEqual(Context.__callsTo('SetDuration')[0].args, [3, 90000]);
});

test('SetDuration rounds a fractional duration down', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetDuration', [1500.9], Context),
    Ok('Timer 3 duration set to 1500 ms')
  );
  assert.deepEqual(Context.__callsTo('SetDuration')[0].args, [3, 1500]);
});

test('SetDuration accepts zero', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetDuration/0', [], Context),
    Ok('Timer 3 duration set to 0 ms')
  );
});

test('SetDuration rejects a negative or non-numeric duration', async () => {
  for (const Value of ['-1', 'abc', 'NaN', 'Infinity', '-Infinity', '5m']) {
    const Context = fakeContext();
    assert.deepEqual(
      await dispatch(`/ShowTrak/Timer/3/SetDuration/${Value}`, [], Context),
      Fail(`Invalid duration "${Value}"`),
      Value
    );
    assert.equal(Context.__callsTo('SetDuration').length, 0, `${Value} reached the timer`);
  }
});

test('SetDuration and JumpToTime reject an empty argument instead of reading it as zero', async () => {
  // A sender with an unfilled string parameter sends "" as the argument. Read
  // as 0 ms, a timer given that duration completes the moment it starts.
  for (const Args of [[''], ['  ']]) {
    const Context = fakeContext();
    assert.deepEqual(
      await dispatch('/ShowTrak/Timer/3/SetDuration', Args, Context),
      Fail(`Invalid duration "${Args[0]}"`)
    );
    assert.deepEqual(
      await dispatch('/ShowTrak/Timer/3/JumpToTime', Args, Context),
      Fail(`Invalid time "${Args[0]}"`)
    );
    assert.equal(Context.__calls.length, 0, `${JSON.stringify(Args)} reached the timer`);
  }
});

test('a millisecond argument with surrounding spaces is still a number', async () => {
  const Context = fakeContext();
  await dispatch('/ShowTrak/Timer/3/SetDuration', [' 1500 '], Context);
  assert.deepEqual(Context.__callsTo('SetDuration')[0].args, [3, 1500]);
});

test('SetDuration reports what the timer refused, e.g. a stopwatch', async () => {
  const Context = fakeContext({ SetDuration: async () => 'A stopwatch has no duration' });
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetDuration/1000', [], Context),
    Fail('Timer 3: A stopwatch has no duration')
  );
});

// --- JumpToTime ---------------------------------------------------------------------

test('JumpToTime moves the timer to that point in its run', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/JumpToTime/30000', [], Context),
    Ok('Timer 3 moved to 30000 ms')
  );
  assert.deepEqual(Context.__callsTo('JumpTo')[0].args, [3, 30000]);
});

test('JumpToTime rounds a fractional time down, and reports what it jumped to', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/JumpToTime', [1500.5], Context),
    Ok('Timer 3 moved to 1500 ms')
  );
  assert.deepEqual(Context.__callsTo('JumpTo')[0].args, [3, 1500]);
});

test('JumpToTime and SetDuration stop at the longest duration, and say so', async () => {
  const Context = fakeContext();
  const Max = (99 * 3600 + 59 * 60 + 59) * 1000;
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/JumpToTime', [1e300], Context),
    Ok(`Timer 3 moved to ${Max} ms`)
  );
  assert.deepEqual(Context.__callsTo('JumpTo')[0].args, [3, Max]);
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/SetDuration', [Max * 2], Context),
    Ok(`Timer 3 duration set to ${Max} ms`)
  );
  assert.deepEqual(Context.__callsTo('SetDuration')[0].args, [3, Max]);
});

test('JumpToTime rejects a negative or non-numeric time', async () => {
  for (const Value of ['-5', 'later', 'NaN', 'Infinity']) {
    const Context = fakeContext();
    assert.deepEqual(
      await dispatch(`/ShowTrak/Timer/3/JumpToTime/${Value}`, [], Context),
      Fail(`Invalid time "${Value}"`),
      Value
    );
    assert.equal(Context.__callsTo('JumpTo').length, 0);
  }
});

test('JumpToTime reports a jump the timer manager refuses', async () => {
  const Context = fakeContext({ JumpTo: async () => 'Timer not found' });
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/3/JumpToTime/10', [], Context),
    Fail('Timer 3: Timer not found')
  );
});

// --- /ShowTrak/All/* ------------------------------------------------------------------

for (const [Verb, Action, Past] of [
  ['Start', 'Start', 'started'],
  ['Stop', 'Stop', 'stopped'],
  ['Pause', 'Pause', 'paused'],
  ['Unpause', 'Unpause', 'resumed'],
]) {
  test(`All/${Verb} applies ${Action} to every timer and counts them`, async () => {
    const Context = fakeContext({ ControlAll: async () => 3 });
    assert.deepEqual(await dispatch(`/ShowTrak/All/${Verb}`, [], Context), Ok(`3 timers ${Past}`));
    assert.deepEqual(Context.__callsTo('ControlAll')[0].args, [Action]);
  });
}

test('All/* says "timer" for exactly one and still succeeds for none', async () => {
  assert.deepEqual(
    await dispatch('/ShowTrak/All/Pause', [], fakeContext({ ControlAll: async () => 1 })),
    Ok('1 timer paused')
  );
  assert.deepEqual(
    await dispatch('/ShowTrak/All/Stop', [], fakeContext({ ControlAll: async () => 0 })),
    Ok('0 timers stopped')
  );
});

test('All/Resume unpauses every paused timer', async () => {
  const Context = fakeContext({ CountWithStatus: async () => 2, ControlAll: async () => 2 });
  assert.deepEqual(await dispatch('/ShowTrak/All/Resume', [], Context), Ok('2 timers resumed'));
  assert.deepEqual(Context.__callsTo('CountWithStatus')[0].args, ['PAUSED']);
  assert.deepEqual(Context.__callsTo('ControlAll')[0].args, ['Unpause']);
});

test('All/Resume with nothing paused fails without touching any timer', async () => {
  const Context = fakeContext({ CountWithStatus: async () => 0 });
  assert.deepEqual(
    await dispatch('/ShowTrak/All/Resume', [], Context),
    Fail('No paused timers to resume')
  );
  assert.equal(Context.__callsTo('ControlAll').length, 0);
});

test('All/Resume says "timer" when exactly one was resumed', async () => {
  const Context = fakeContext({ CountWithStatus: async () => 1, ControlAll: async () => 1 });
  assert.deepEqual(await dispatch('/ShowTrak/All/Resume', [], Context), Ok('1 timer resumed'));
});

test('arguments sent to a route without parameters are ignored', async () => {
  const Context = fakeContext();
  assert.deepEqual(
    await dispatch('/ShowTrak/Timer/2/Start', [1, 'x'], Context),
    Ok('Timer 2 started')
  );
  assert.deepEqual(Context.__callsTo('Control')[0].args, [2, 'Start']);
});

// --- Group routes --------------------------------------------------------------
// New in 2.0: a group's timers addressed by the group's slug, as ShowTrak
// Server addresses groups. "Default" is the Default group.

const GROUP_ROUTES = [
  ['Start', 'Start', 'started'],
  ['Stop', 'Stop', 'stopped'],
  ['Pause', 'Pause', 'paused'],
  ['Unpause', 'Unpause', 'resumed'],
  ['Resume', 'Unpause', 'resumed'],
];

/** A context whose ControlGroup answers with `Result` and records its calls. */
function groupContext(Result = [null, { Title: 'Stage Left', Count: 2 }]) {
  return fakeContext({ ControlGroup: async () => Result });
}

test('every group route is declared and matches by slug', () => {
  for (const [Verb] of GROUP_ROUTES) {
    const Path = `/ShowTrak/Group/:Slug/${Verb}`;
    assert.ok(
      ROUTES.some((R) => R.Path === Path),
      `${Path} is not declared`
    );
    const Match = MatchRoute(`/ShowTrak/Group/Stage-Left/${Verb}`);
    assert.ok(Match, Verb);
    assert.equal(Match.Route.Path, Path);
    assert.deepEqual(Match.Params, { Slug: 'Stage-Left' });
  }
});

test('each group route controls the group with its action (Resume is Unpause)', async () => {
  for (const [Verb, Action, Past] of GROUP_ROUTES) {
    const Context = groupContext();
    const Outcome = await dispatch(`/ShowTrak/Group/Stage-Left/${Verb}`, [], Context);
    assert.deepEqual(
      Context.__callsTo('ControlGroup').map((C) => C.args),
      [['Stage-Left', Action]],
      Verb
    );
    assert.deepEqual(Outcome, Ok(`Stage Left: 2 timers ${Past}`), Verb);
    // Nothing else is touched.
    assert.equal(Context.__callsTo('ControlAll').length, 0, Verb);
    assert.equal(Context.__callsTo('Control').length, 0, Verb);
  }
});

test('a group route says "timer" for exactly one', async () => {
  const Outcome = await dispatch(
    '/ShowTrak/Group/Default/Pause',
    [],
    groupContext([null, { Title: 'Default', Count: 1 }])
  );
  assert.deepEqual(Outcome, Ok('Default: 1 timer paused'));
});

test('a group that does not exist is reported, with the message from the context', async () => {
  const Outcome = await dispatch(
    '/ShowTrak/Group/Nope/Start',
    [],
    groupContext(['Group "Nope" not found', null])
  );
  assert.deepEqual(Outcome, Fail('Group "Nope" not found'));
  // ...and with a fallback when the context gives no reason.
  const Silent = await dispatch('/ShowTrak/Group/Nope/Start', [], groupContext([null, null]));
  assert.deepEqual(Silent, Fail('Group "Nope" not found'));
});

test('a blank slug is refused before any group is looked up', async () => {
  const Route = ROUTES.find((R) => R.Path === '/ShowTrak/Group/:Slug/Start');
  const Context = groupContext();
  assert.deepEqual(await Route.Handler({ Slug: '   ' }, Context), Fail('Invalid group'));
  assert.equal(Context.__callsTo('ControlGroup').length, 0);
  // An empty segment is no segment at all, so the address does not match.
  assert.equal(MatchRoute('/ShowTrak/Group//Start'), null);
});

test('the slug sits mid-path, so it can never come from an argument', () => {
  assert.equal(MatchRoute('/ShowTrak/Group/Start', ['Stage-Left']), null);
  assert.equal(MatchRoute('/ShowTrak/Group/Stage-Left'), null);
  assert.equal(MatchRoute('/ShowTrak/Group/Stage-Left/Start/Now'), null);
});
