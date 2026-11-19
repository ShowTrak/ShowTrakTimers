// Show files opened from the operating system (src/main/file-associations.ts).
// What is at stake: a double-click in Finder or Explorer swaps out the running
// show, so it must find the right file, and only ever open the one the
// operator was asked about.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const FA = require('../dist/main/file-associations');

test.beforeEach(() => FA.ResetShowFileRequestsForTests());

// --- Command line -------------------------------------------------------------

test('finds an existing show file on the command line, in any letter case', (t) => {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-assoc-'));
  t.after(() => fs.rmSync(Dir, { recursive: true, force: true }));
  const File = path.join(Dir, 'Main Stage.ShowTrakTimers');
  fs.writeFileSync(File, '');
  assert.equal(FA.ShowFileFromArgv(['--squirrel-firstrun', File]), File);
  assert.equal(
    FA.ShowFileFromArgv(['Main Stage.ShowTrakTimers'], Dir),
    File,
    'relative to the cwd given'
  );
});

test('ignores switches, other files and show files that do not exist', (t) => {
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-assoc-'));
  t.after(() => fs.rmSync(Dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(Dir, 'notes.txt'), '');
  assert.equal(
    FA.ShowFileFromArgv(
      ['.', '--allow-file-access-from-files', 'notes.txt', 'gone.showtraktimers'],
      Dir
    ),
    null
  );
  assert.equal(FA.IsShowFilePath('--x.showtraktimers'), false);
});

// --- Requests -----------------------------------------------------------------

test('a request before the renderer starts is part of the launch, and is not announced', () => {
  let Announced = 0;
  FA.OnShowFileRequest(() => Announced++);
  FA.RequestShowFileOpen('/a.showtraktimers');
  assert.equal(Announced, 0);
  assert.deepEqual(FA.TakeShowFileRequest(), { FilePath: '/a.showtraktimers', Source: 'Launch' });
  assert.equal(FA.TakeShowFileRequest(), null, 'taken once');
});

test('once the renderer has started, a request is announced and asks first', () => {
  let Announced = 0;
  FA.OnShowFileRequest(() => Announced++);
  FA.TakeShowFileRequest();
  FA.RequestShowFileOpen('/a.showtraktimers');
  FA.RequestShowFileOpen('/b.showtraktimers');
  assert.equal(Announced, 2);
  assert.deepEqual(FA.TakeShowFileRequest(), { FilePath: '/b.showtraktimers', Source: 'Running' });
});

// --- Windows registry ---------------------------------------------------------

test('Squirrel install and update register the association against the stub exe', () => {
  const ExecPath = 'C:\\Users\\op\\AppData\\Local\\showtrak_timers\\app-2.0.0\\ShowTrak Timers.exe';
  for (const Event of ['--squirrel-install', '--squirrel-updated']) {
    const Calls = [];
    const Action = FA.HandleSquirrelFileAssociations(['exe', Event, '2.0.0'], {
      Platform: 'win32',
      ExecPath: ExecPath.replace(/\\/g, '/'),
      Run: (Args) => (Calls.push(Args), { status: 0 }),
    });
    assert.equal(Action, 'register');
    const Command = Calls.find((A) => A[1].endsWith('\\shell\\open\\command'));
    assert.ok(Command, 'writes the open command');
    assert.match(Command[4], /showtrak_timers\/ShowTrak Timers\.exe" "%1"$/);
    assert.doesNotMatch(Command[4], /app-2\.0\.0/, 'not the versioned folder Squirrel deletes');
    assert.ok(
      Calls.some(
        (A) =>
          A[1] === 'HKCU\\Software\\Classes\\.showtraktimers' &&
          A.includes('ShowTrak.TimersShowFile')
      )
    );
  }
});

test('Squirrel uninstall removes the association, and .showtraktimers only while it is still ours', () => {
  const Run = (Default) => {
    const Calls = [];
    FA.HandleSquirrelFileAssociations(['exe', '--squirrel-uninstall'], {
      Platform: 'win32',
      ExecPath: '/root/app-1.0.0/ShowTrak Timers.exe',
      Run: (Args) => {
        Calls.push(Args);
        return Args[0] === 'query'
          ? { status: 0, stdout: `(Default) REG_SZ ${Default}` }
          : { status: 0 };
      },
    });
    return Calls;
  };
  const DeletesExtension = (Calls) =>
    Calls.some(
      (A) =>
        A[0] === 'delete' &&
        A[1] === 'HKCU\\Software\\Classes\\.showtraktimers' &&
        A.includes('/ve')
    );
  assert.ok(
    Run('ShowTrak.TimersShowFile').some(
      (A) => A[0] === 'delete' && A[1].endsWith('\\ShowTrak.TimersShowFile')
    )
  );
  assert.equal(DeletesExtension(Run('ShowTrak.TimersShowFile')), true);
  assert.equal(DeletesExtension(Run('SomeOtherApp.File')), false);
});

test('nothing happens outside Windows or without a Squirrel event', () => {
  const Run = () => assert.fail('must not touch the registry');
  assert.equal(
    FA.HandleSquirrelFileAssociations(['exe', '--squirrel-install'], { Platform: 'darwin', Run }),
    null
  );
  assert.equal(
    FA.HandleSquirrelFileAssociations(['exe', 'show.showtraktimers'], { Platform: 'win32', Run }),
    null
  );
});

test('the taken request is the only one that can be opened, once', () => {
  FA.RequestShowFileOpen('/a.showtraktimers');
  FA.TakeShowFileRequest();
  FA.RequestShowFileOpen('/b.showtraktimers'); // arrives while the operator is asked about a
  assert.deepEqual(FA.ConsumeTakenShowFileRequest(), {
    FilePath: '/a.showtraktimers',
    Source: 'Launch',
  });
  assert.equal(FA.ConsumeTakenShowFileRequest(), null);
  assert.equal(FA.TakeShowFileRequest().FilePath, '/b.showtraktimers', 'b waits its turn');
});
