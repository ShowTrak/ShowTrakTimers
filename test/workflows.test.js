const test = require('node:test');
const assert = require('node:assert/strict');

// The GitHub Actions workflows: .github/workflows/ci.yml (lint, format,
// typecheck, then the tests on every shipping platform) and
// build-and-draft-release.yml (gated on that CI run, builds, writes the macOS
// updater manifest, drafts or publishes the release).
//
// Parsed crudely as text: the workflows are ours and Prettier-formatted, so
// splitting on job and step indentation is enough, and no YAML dependency is
// needed. The macOS manifest step is a self-contained Node script, so it is
// extracted and actually run against a fake artifact tree in a temp dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { readText, exists } = require('./helpers/ui-source');
const { IsPrereleaseVersion } = require('@showtrak/protocol/runtime');
const Package = require('../package.json');

const CI = readText('.github', 'workflows', 'ci.yml');
const RELEASE = readText('.github', 'workflows', 'build-and-draft-release.yml');

/** Job name -> the job's text, for the jobs under `jobs:` (two-space indent). */
function jobs(Workflow) {
  const Body = Workflow.slice(Workflow.indexOf('\njobs:\n') + 7);
  const Out = new Map();
  let Name = null;
  for (const Line of Body.split('\n')) {
    const Header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(Line);
    if (Header) {
      Name = Header[1];
      Out.set(Name, '');
    } else if (Name) {
      Out.set(Name, `${Out.get(Name)}${Line}\n`);
    }
  }
  return Out;
}

/** A job's steps, each as its own text. */
function steps(JobText) {
  return JobText.split(/\n(?= {6}- )/).filter((Step) => /^ {6}- /.test(Step.replace(/^\n/, '')));
}

/** The `needs:` of a job, as a list. */
function needs(JobText) {
  const M = /^ {4}needs:\s*(\[[^\]]*\]|\S+)\s*$/m.exec(JobText);
  if (!M) return [];
  return M[1]
    .replace(/[[\]]/g, '')
    .split(',')
    .map((S) => S.trim())
    .filter(Boolean);
}

const CI_JOBS = jobs(CI);
const RELEASE_JOBS = jobs(RELEASE);

// --- ci.yml -----------------------------------------------------------------------

test('CI runs on every push and pull request', () => {
  assert.match(CI, /^on:\n {2}push:\n {2}pull_request:/m);
});

test('CI lints, checks formatting and typechecks with the package scripts', () => {
  const Quality = [...CI_JOBS.values()].find((Job) => /npm run lint/.test(Job));
  assert.ok(Quality, 'no job runs npm run lint');
  for (const Script of ['lint', 'format:check', 'typecheck']) {
    assert.match(
      Quality,
      new RegExp(`run: npm run ${Script.replace(':', '\\:')}\\s*$`, 'm'),
      Script
    );
    assert.ok(Package.scripts[Script], `package.json has no "${Script}" script`);
  }
});

test('CI runs the tests on Linux (x64 and ARM64), macOS and Windows without cancelling the others', () => {
  const Test = [...CI_JOBS.values()].find((Job) => /run: npm test\s*$/m.test(Job));
  assert.ok(Test, 'no job runs npm test');
  const Matrix = /os:\s*\[([^\]]+)\]/.exec(Test);
  assert.ok(Matrix, 'the test job has no os matrix');
  assert.deepEqual(
    Matrix[1]
      .split(',')
      .map((S) => S.trim())
      .sort(),
    ['macos-latest', 'ubuntu-24.04-arm', 'ubuntu-latest', 'windows-latest']
  );
  assert.match(Test, /runs-on: \$\{\{ matrix\.os \}\}/);
  assert.match(Test, /fail-fast: false/);
});

test('every CI job has a timeout, so a hung test cannot run for six hours', () => {
  for (const [Name, Job] of CI_JOBS) assert.match(Job, /timeout-minutes: \d+/, Name);
});

test('every CI checkout fetches the shared submodule recursively', () => {
  let Checkouts = 0;
  for (const [Name, Job] of CI_JOBS) {
    for (const Step of steps(Job).filter((S) => /uses: actions\/checkout@/.test(S))) {
      assert.match(Step, /submodules: recursive/, `${Name}: a checkout without the submodule`);
      Checkouts += 1;
    }
  }
  assert.equal(Checkouts, CI_JOBS.size);
});

test('Windows test runners keep LF line endings, set before the checkout', () => {
  const Test = [...CI_JOBS.values()].find((Job) => /run: npm test\s*$/m.test(Job));
  const Steps = steps(Test);
  const Autocrlf = Steps.findIndex((S) => /git config --global core\.autocrlf false/.test(S));
  const Checkout = Steps.findIndex((S) => /uses: actions\/checkout@/.test(S));
  assert.ok(Autocrlf >= 0, 'no autocrlf step');
  assert.ok(Autocrlf < Checkout, 'autocrlf must be set before checking out');
  assert.match(Steps[Autocrlf], /if: runner\.os == 'Windows'/);
});

// --- build-and-draft-release.yml: gating -------------------------------------------

test('the release workflow has a CI gate and every other job waits for it', () => {
  assert.ok(RELEASE_JOBS.has('ci-gate'), 'no ci-gate job');
  const Reaches = (Name, Seen = new Set()) => {
    if (Name === 'ci-gate') return true;
    if (Seen.has(Name)) return false;
    Seen.add(Name);
    return needs(RELEASE_JOBS.get(Name) || '').some((Dep) => Reaches(Dep, Seen));
  };
  for (const Name of RELEASE_JOBS.keys()) {
    if (Name !== 'ci-gate') assert.ok(Reaches(Name), `${Name} does not wait for ci-gate`);
  }
  assert.deepEqual(needs(RELEASE_JOBS.get('release-meta')), ['ci-gate']);
});

test('the CI gate waits for a successful run of ci.yml on this exact commit', () => {
  const Gate = RELEASE_JOBS.get('ci-gate');
  const Polled = /actions\/workflows\/([^/]+)\/runs\?head_sha=\$SHA/.exec(Gate);
  assert.ok(Polled, 'ci-gate does not query workflow runs by head_sha');
  assert.ok(exists('.github', 'workflows', Polled[1]), `${Polled[1]} is not a workflow here`);
  assert.match(Gate, /SHA: \$\{\{ github\.sha \}\}/);
  assert.match(Gate, /\.conclusion == "success"/);
  assert.match(Gate, /exit 1/);
});

test('the build checks out the shared submodule and builds on every platform', () => {
  const Make = RELEASE_JOBS.get('make');
  assert.ok(Make, 'no make job');
  const Checkout = steps(Make).find((S) => /uses: actions\/checkout@/.test(S));
  assert.match(Checkout, /submodules: recursive/);
  const Matrix = /os:\s*\[([^\]]+)\]/
    .exec(Make)[1]
    .split(',')
    .map((S) => S.trim());
  assert.equal(Matrix.length, 4);
  // x64 Linux, and ARM64 Linux for the Raspberry Pi packages
  assert.ok(
    Matrix.some((Os) => /^ubuntu-[\d.]+$/.test(Os)),
    'no x64 Linux build'
  );
  assert.ok(
    Matrix.some((Os) => /^ubuntu-[\d.]+-arm$/.test(Os)),
    'no ARM64 Linux build'
  );
  assert.ok(Matrix.includes('macos-latest'));
  assert.ok(Matrix.includes('windows-latest'));
  assert.match(Make, /npm run make/);
});

test('the Linux packages are checked, on each Linux runner, before they are uploaded', () => {
  const Steps = steps(RELEASE_JOBS.get('make'));
  const Check = Steps.findIndex((S) => /run: bash scripts\/check-linux-packages\.sh\s*$/m.test(S));
  const Upload = Steps.findIndex((S) => /uses: actions\/upload-artifact@/.test(S));
  assert.ok(Check >= 0, 'no step runs scripts/check-linux-packages.sh');
  assert.ok(exists('scripts', 'check-linux-packages.sh'), 'the check script is missing');
  assert.match(Steps[Check], /if: runner\.os == 'Linux'/);
  assert.ok(Check < Upload, 'the check must pass before anything is uploaded');
  // readelf (binutils) for the check, zip for the zip maker
  const Tools = Steps.find((S) => /name: Install Linux packaging tools/.test(S));
  assert.match(Tools, /apt-get install -y [^\n]*\bzip\b/);
  assert.match(Tools, /apt-get install -y [^\n]*\bbinutils\b/);
});

// --- build-and-draft-release.yml: pre-releases -------------------------------------

test('a pre-release version is drafted as a GitHub pre-release', () => {
  const Release = RELEASE_JOBS.get('release');
  assert.match(
    Release,
    /case "\$RELEASE_VERSION" in \*-\*\) PRERELEASE_FLAG="--prerelease" ;; esac/
  );
  for (const M of Release.matchAll(/gh release create [^\n]*/g)) {
    assert.match(M[0], /--draft \$PRERELEASE_FLAG/, M[0]);
  }
});

test('a pre-release is published without becoming "latest"; a stable release becomes it', () => {
  const Publish = steps(RELEASE_JOBS.get('release')).find((S) => /name: Publish release/.test(S));
  assert.ok(Publish, 'no publish step');
  assert.match(Publish, /\*-\*\) gh release edit [^\n]*--draft=false --prerelease --latest=false/);
  assert.match(Publish, /\*\) gh release edit [^\n]*--draft=false --latest\b(?!=)/);
});

test("the workflow's pre-release test agrees with the updater's for this version", () => {
  // The shell treats any "-" as a pre-release (case *-*); the update channels
  // use the semver pre-release part. They must agree for the version shipping.
  assert.equal(Package.version.includes('-'), IsPrereleaseVersion(Package.version));
});

test('the release title is read from package.json', () => {
  const Meta = RELEASE_JOBS.get('release-meta');
  assert.match(Meta, /require\('\.\/package\.json'\)\.version/);
  assert.match(Meta, /require\('\.\/package\.json'\)\.productName/);
});

// --- build-and-draft-release.yml: the macOS updater manifest -----------------------

/** The `node <<'NODE' ... NODE` script of the manifest step. */
function manifestScript() {
  const Step = steps(RELEASE_JOBS.get('release')).find(
    (S) => /latest-mac\.yml/.test(S) && /<<'NODE'/.test(S)
  );
  assert.ok(Step, 'no latest-mac.yml step');
  const M = /node <<'NODE'\n([\s\S]*?)\n[ \t]*NODE[ \t]*(?:\n|$)/.exec(Step);
  assert.ok(M, 'manifest heredoc not found');
  return M[1];
}

test('the manifest names the canonical zip built from the product name', () => {
  const Script = manifestScript();
  const Canonical = Package.productName.replace(/\s+/g, '-');
  assert.equal(Canonical, 'ShowTrak-Timers');
  assert.ok(
    Script.includes(`\`${Canonical}-darwin-\${arch}-\${version}.zip\``),
    'canonical name changed'
  );
  // GitHub renames spaces to dots on upload; that form is kept as an alias.
  assert.ok(
    Script.includes(
      `\`${Package.productName.replace(/\s+/g, '.')}-darwin-\${arch}-\${version}.zip\``
    )
  );
});

function runManifest(Files, Version = '2.0.0-beta.1') {
  const Script = manifestScript(); // before the temp dir, so a failure leaks nothing
  const Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-timers-manifest-'));
  const Artifacts = path.join(Dir, 'release-artifacts');
  for (const [Rel, Content] of Object.entries(Files)) {
    const Full = path.join(Artifacts, ...Rel.split('/'));
    fs.mkdirSync(path.dirname(Full), { recursive: true });
    fs.writeFileSync(Full, Content);
  }
  fs.mkdirSync(Artifacts, { recursive: true });
  const Result = spawnSync(process.execPath, ['-'], {
    cwd: Dir,
    input: Script,
    encoding: 'utf8',
    env: { ...process.env, RELEASE_VERSION: Version },
  });
  return { Dir, Artifacts, Result };
}

function cleanup(Dir) {
  fs.rmSync(Dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

test("the manifest step points latest-mac.yml at a canonical copy of forge's macOS zip", (t) => {
  const Zip = 'pretend zip bytes';
  const Forged = 'zip/darwin/arm64/ShowTrak Timers-darwin-arm64-2.0.0-beta.1.zip';
  const { Dir, Artifacts, Result } = runManifest({
    [Forged]: Zip,
    'squirrel.windows/x64/RELEASES': 'x',
  });
  t.after(() => cleanup(Dir));
  assert.equal(Result.status, 0, Result.stderr);

  const Folder = path.join(Artifacts, 'zip', 'darwin', 'arm64');
  const Canonical = 'ShowTrak-Timers-darwin-arm64-2.0.0-beta.1.zip';
  assert.equal(fs.readFileSync(path.join(Folder, Canonical), 'utf8'), Zip);
  assert.ok(fs.existsSync(path.join(Folder, 'ShowTrak.Timers-darwin-arm64-2.0.0-beta.1.zip')));

  const Manifest = fs.readFileSync(path.join(Artifacts, 'latest-mac.yml'), 'utf8');
  const Sha = crypto.createHash('sha512').update(Zip).digest('base64');
  assert.match(Manifest, /^version: 2\.0\.0-beta\.1$/m);
  assert.match(Manifest, new RegExp(`^ {2}- url: ${Canonical.replace(/\./g, '\\.')}$`, 'm'));
  assert.match(Manifest, new RegExp(`^path: ${Canonical.replace(/\./g, '\\.')}$`, 'm'));
  assert.ok(Manifest.includes(`sha512: ${Sha}`));
  assert.match(Manifest, new RegExp(`size: ${Buffer.byteLength(Zip)}\\b`));
});

test('the manifest step prefers the Apple silicon zip when both architectures are built', (t) => {
  const { Dir, Artifacts, Result } = runManifest(
    {
      'zip/darwin/x64/ShowTrak Timers-darwin-x64-2.1.0.zip': 'intel',
      'zip/darwin/arm64/ShowTrak Timers-darwin-arm64-2.1.0.zip': 'apple',
    },
    '2.1.0'
  );
  t.after(() => cleanup(Dir));
  assert.equal(Result.status, 0, Result.stderr);
  const Manifest = fs.readFileSync(path.join(Artifacts, 'latest-mac.yml'), 'utf8');
  assert.match(Manifest, /url: ShowTrak-Timers-darwin-arm64-2\.1\.0\.zip/);
  assert.ok(Manifest.includes(crypto.createHash('sha512').update('apple').digest('base64')));
});

test('the manifest step writes nothing when there is no macOS build', (t) => {
  const { Dir, Artifacts, Result } = runManifest({ 'squirrel.windows/x64/RELEASES': 'x' });
  t.after(() => cleanup(Dir));
  assert.equal(Result.status, 0, Result.stderr);
  assert.equal(fs.existsSync(path.join(Artifacts, 'latest-mac.yml')), false);
});
