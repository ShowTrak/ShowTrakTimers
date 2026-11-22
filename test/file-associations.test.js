// Show files opened from the operating system (src/main/file-associations.ts).
// The mechanics (requests held for the renderer, Squirrel's registry hooks) are
// @showtrak/protocol/electron-main's, covered by the protocol's specs. What is
// Timers' own is the file type: a double-click on a .showtraktimers file, in
// any letter case, must reach this app, and Windows must register it under
// Timers' own ProgID so it never takes over ShowTrak Server's .ShowTrak files.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FA = require('../dist/main/file-associations');

test.beforeEach(() => FA.ResetShowFileRequestsForTests());

test('finds an existing .showtraktimers file on the command line, in any letter case', (t) => {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-assoc-'));
  t.after(() => fs.rmSync(Dir, { recursive: true, force: true }));
  const File = path.join(Dir, 'Main Stage.ShowTrakTimers');
  fs.writeFileSync(File, '');
  fs.writeFileSync(path.join(Dir, 'Server Show.ShowTrak'), '');
  assert.equal(FA.ShowFileFromArgv(['--squirrel-firstrun', File]), File);
  assert.equal(
    FA.ShowFileFromArgv(['Main Stage.ShowTrakTimers'], Dir),
    File,
    'relative to the cwd given'
  );
  assert.equal(FA.ShowFileFromArgv(['Server Show.ShowTrak'], Dir), null, "not Server's files");
});

test('Windows registers .showtraktimers as a ShowTrak Timers show file', () => {
  const Calls = [];
  const Action = FA.HandleSquirrelFileAssociations(['exe', '--squirrel-install', '2.0.0'], {
    Platform: 'win32',
    ExecPath: '/root/app-2.0.0/ShowTrak Timers.exe',
    Run: (Args) => (Calls.push(Args), { status: 0 }),
  });
  assert.equal(Action, 'register');
  const Classes = 'HKCU\\Software\\Classes';
  assert.ok(
    Calls.some(
      (A) => A[1] === `${Classes}\\.showtraktimers` && A.includes('ShowTrak.TimersShowFile')
    )
  );
  assert.ok(
    Calls.some(
      (A) =>
        A[1] === `${Classes}\\ShowTrak.TimersShowFile` && A.includes('ShowTrak Timers Show File')
    )
  );
});
