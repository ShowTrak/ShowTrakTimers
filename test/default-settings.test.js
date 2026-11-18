// src/Modules/SettingsManager/DefaultSettings.ts: the list of every setting the
// app has. The Preferences modal renders it as-is (groups, ShowWhen toggles,
// option lists, sliders), the DB migration renames keys into it, and the
// SettingsManager coerces against it, so a typo here becomes a missing control
// or a setting that silently resets. These are the invariants it must keep.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { QuietLogs } = require('./helpers/data-helpers');
QuietLogs();

const { DefaultSettings, Groups } = require('../dist/Modules/SettingsManager/DefaultSettings');
const { CoerceValue } = require('../dist/Modules/SettingsManager');
const { ProbeBind } = require('../dist/Modules/SettingsManager/validators');
const {
  DEFAULT_OSC_PORT,
  DEFAULT_WEB_DASHBOARD_PORT,
} = require('../dist/Modules/Config/constants');

const ByKey = new Map(DefaultSettings.map((Def) => [Def.Key, Def]));
const TYPES = ['BOOLEAN', 'INTEGER', 'STRING', 'OPTION', 'SLIDER'];

test('every setting has a unique key, a known type, a title and a description', () => {
  assert.equal(ByKey.size, DefaultSettings.length, 'keys are unique');
  for (const Def of DefaultSettings) {
    assert.match(Def.Key, /^[A-Z][A-Z0-9_]*$/, Def.Key);
    assert.ok(TYPES.includes(Def.Type), `${Def.Key}: ${Def.Type}`);
    assert.ok(Def.Title && Def.Title.trim(), `${Def.Key} title`);
    assert.ok(Def.Description && Def.Description.trim(), `${Def.Key} description`);
  }
});

test('every setting belongs to a declared group, and every group has settings', () => {
  const GroupNames = Groups.map((G) => G.Name);
  assert.equal(new Set(GroupNames).size, GroupNames.length, 'group names are unique');
  for (const Group of Groups) assert.ok(Group.Title, `${Group.Name} title`);
  for (const Def of DefaultSettings) {
    assert.ok(GroupNames.includes(Def.Group), `${Def.Key} is in group ${Def.Group}`);
  }
  for (const Name of GroupNames) {
    assert.ok(
      DefaultSettings.some((Def) => Def.Group === Name),
      `group ${Name} is not empty`
    );
  }
});

test('ShowWhen only names BOOLEAN settings that exist', () => {
  for (const Def of DefaultSettings) {
    for (const Key of Def.ShowWhen || []) {
      assert.ok(ByKey.has(Key), `${Def.Key} ShowWhen ${Key} exists`);
      assert.equal(ByKey.get(Key).Type, 'BOOLEAN', `${Def.Key} ShowWhen ${Key} is BOOLEAN`);
      assert.notEqual(Key, Def.Key, `${Def.Key} does not depend on itself`);
    }
  }
});

test('every default coerces to itself (a default never reads back as changed)', () => {
  for (const Def of DefaultSettings) {
    assert.equal(CoerceValue(Def, Def.DefaultValue), Def.DefaultValue, Def.Key);
  }
});

test('option and numeric settings declare what their controls need', () => {
  for (const Def of DefaultSettings) {
    if (Def.Type === 'OPTION') {
      assert.ok(Array.isArray(Def.Options) && Def.Options.length >= 2, `${Def.Key} options`);
      assert.ok(Def.Options.includes(Def.DefaultValue), `${Def.Key} default is an option`);
    }
    if (Def.Type === 'SLIDER') {
      assert.equal(typeof Def.Min, 'number', `${Def.Key} Min`);
      assert.equal(typeof Def.Max, 'number', `${Def.Key} Max`);
    }
    if (typeof Def.Min === 'number' && typeof Def.Max === 'number') {
      assert.ok(Def.Min < Def.Max, `${Def.Key} Min < Max`);
      assert.ok(
        Def.DefaultValue >= Def.Min && Def.DefaultValue <= Def.Max,
        `${Def.Key} default in range`
      );
    }
    if (Def.Type === 'BOOLEAN') assert.equal(typeof Def.DefaultValue, 'boolean', Def.Key);
  }
});

test('automatic updates are off by default and the channel is Stable or Beta', () => {
  assert.equal(ByKey.get('SYSTEM_AUTO_UPDATE_ENABLED').DefaultValue, false);
  assert.equal(ByKey.get('SYSTEM_AUTO_UPDATE_ENABLED').Type, 'BOOLEAN');
  const Channel = ByKey.get('SYSTEM_UPDATE_CHANNEL');
  assert.equal(Channel.Type, 'OPTION');
  assert.deepEqual(Channel.Options, ['Stable', 'Beta']);
  assert.equal(Channel.DefaultValue, 'Stable');
  // Both re-apply the updater when changed.
  assert.equal(ByKey.get('SYSTEM_AUTO_UPDATE_ENABLED').OnUpdateEvent, 'AutoUpdateSettingsChanged');
  assert.equal(Channel.OnUpdateEvent, 'AutoUpdateSettingsChanged');
});

test('the keys 2.0 retired are gone (the DB migration removes their rows)', () => {
  assert.equal(ByKey.has('SYSTEM_AUTO_UPDATE'), false);
  assert.equal(ByKey.has('SYSTEM_PREVENT_DISPLAY_SLEEP'), false);
});

test('the 1.x keys that were kept are still here, so their saved values still apply', () => {
  for (const Key of [
    'SYSTEM_CONFIRM_SHUTDOWN_ON_ALT_F4',
    'NOTIFY_SETTINGS_CHANGES',
    'NOTIFY_OSC_DEBUG',
    'OSC_ENABLE',
    'OSC_PORT',
  ]) {
    assert.ok(ByKey.has(Key), Key);
  }
});

test('the network settings default to the shared constants, need an explicit save and are validated', () => {
  assert.equal(ByKey.get('OSC_PORT').DefaultValue, DEFAULT_OSC_PORT);
  assert.equal(ByKey.get('WEB_DASHBOARD_PORT').DefaultValue, DEFAULT_WEB_DASHBOARD_PORT);
  for (const Key of ['OSC_PORT', 'OSC_BIND', 'WEB_DASHBOARD_PORT', 'WEB_DASHBOARD_BIND']) {
    const Def = ByKey.get(Key);
    assert.equal(Def.RequiresSave, true, `${Key} RequiresSave`);
    assert.equal(typeof Def.Validate, 'function', `${Key} Validate`);
    assert.ok(Def.OnUpdateEvent, `${Key} restarts its service`);
  }
  assert.equal(ByKey.get('OSC_PORT').Min, 1);
  assert.equal(ByKey.get('OSC_PORT').Max, 65535);
  assert.equal(ByKey.get('OSC_BIND').DefaultValue, '0.0.0.0');
  assert.equal(ByKey.get('WEB_DASHBOARD_BIND').DefaultValue, '0.0.0.0');
});

// Find a port held by a TCP listener whose UDP twin is free, so the two port
// settings can be told apart by which transport they probe.
async function HeldTcpPortWithFreeUdp() {
  for (let Attempt = 0; Attempt < 10; Attempt++) {
    const Server = net.createServer();
    await new Promise((resolve) => Server.listen({ host: '0.0.0.0', port: 0 }, resolve));
    const Port = Server.address().port;
    try {
      await ProbeBind('udp', '0.0.0.0', Port);
      return { Port, Server };
    } catch {
      await new Promise((resolve) => Server.close(resolve));
    }
  }
  throw new Error('no TCP port with a free UDP twin');
}

test('each port setting probes its own transport: Web Dashboard TCP, OSC UDP', async (t) => {
  const { Port, Server } = await HeldTcpPortWithFreeUdp();
  t.after(() => new Promise((resolve) => Server.close(resolve)));
  assert.equal(
    await ByKey.get('WEB_DASHBOARD_PORT').Validate(Port, DEFAULT_WEB_DASHBOARD_PORT),
    `Port ${Port} is already in use.`
  );
  assert.equal(await ByKey.get('OSC_PORT').Validate(Port, DEFAULT_OSC_PORT), null);
  // Unchanged: the running service is what holds it.
  assert.equal(await ByKey.get('WEB_DASHBOARD_PORT').Validate(Port, Port), null);
});

test('the bind address settings accept every interface and reject a malformed address', async () => {
  for (const Key of ['OSC_BIND', 'WEB_DASHBOARD_BIND']) {
    assert.equal(await ByKey.get(Key).Validate('0.0.0.0', '0.0.0.0'), null, Key);
    assert.equal(
      await ByKey.get(Key).Validate('not-an-ip', '0.0.0.0'),
      'Enter an IPv4 address, or 0.0.0.0 for every interface.',
      Key
    );
  }
});
