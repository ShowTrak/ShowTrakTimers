const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

// Every type that crosses a process or network boundary (IPC, renderer pushes,
// the Web Dashboard socket, show files) is declared once, in the protocol
// submodule's @showtrak/protocol/timers entry point, and imported from there.
// A copy declared again under the same name in src/ is how the two ends of a
// boundary drift apart, so this fails on one.

const ROOT = path.join(__dirname, '..');
const TIMERS = path.join(ROOT, 'shared', 'src', 'timers');

// Declared locally on purpose, with the reason.
const ALLOWED = new Map([
  [
    'SettingDefinition',
    'extends the protocol’s SettingDefinition with what only the main process reads',
  ],
]);

function Parse(File) {
  return ts.createSourceFile(File, fs.readFileSync(File, 'utf8'), ts.ScriptTarget.Latest, true);
}

const IsExported = (Node) => (ts.getCombinedModifierFlags(Node) & ts.ModifierFlags.Export) !== 0;

/** The type names a protocol module exports, following `export *` and `export type { }`. */
function ProtocolExports(File, Seen = new Set()) {
  const Names = new Set();
  if (Seen.has(File)) return Names;
  Seen.add(File);
  for (const Node of Parse(File).statements) {
    if ((ts.isInterfaceDeclaration(Node) || ts.isTypeAliasDeclaration(Node)) && IsExported(Node)) {
      Names.add(Node.name.text);
    } else if (ts.isExportDeclaration(Node)) {
      if (Node.exportClause && ts.isNamedExports(Node.exportClause)) {
        for (const Element of Node.exportClause.elements) Names.add(Element.name.text);
      } else if (Node.moduleSpecifier && ts.isStringLiteral(Node.moduleSpecifier)) {
        const Target = path.resolve(path.dirname(File), `${Node.moduleSpecifier.text}.d.ts`);
        for (const Name of ProtocolExports(Target, Seen)) Names.add(Name);
      }
    }
  }
  return Names;
}

/** Every interface and type alias declared in src/, as [name, file]. */
function SourceDeclarations(Dir, Found = []) {
  for (const Entry of fs.readdirSync(Dir, { withFileTypes: true })) {
    const Full = path.join(Dir, Entry.name);
    if (Entry.isDirectory()) {
      if (Entry.name !== 'vendors') SourceDeclarations(Full, Found);
    } else if (Entry.name.endsWith('.ts')) {
      const Visit = (Node) => {
        if (ts.isInterfaceDeclaration(Node) || ts.isTypeAliasDeclaration(Node)) {
          Found.push([Node.name.text, path.relative(ROOT, Full)]);
        }
        ts.forEachChild(Node, Visit);
      };
      Visit(Parse(Full));
    }
  }
  return Found;
}

const Protocol = ProtocolExports(path.join(TIMERS, 'index.d.ts'));

test('the protocol’s Timers entry point is read (the submodule is checked out)', () => {
  for (const Name of ['TimersAPI', 'InvokeMap', 'TimerView', 'DashboardTimer', 'ResultTuple']) {
    assert.ok(Protocol.has(Name), Name);
  }
});

test('no source file declares a type @showtrak/protocol/timers already exports', () => {
  const Copies = SourceDeclarations(path.join(ROOT, 'src'))
    .filter(([Name]) => Protocol.has(Name) && !ALLOWED.has(Name))
    .map(([Name, File]) => `${Name} (${File})`);
  assert.deepEqual(Copies, [], 'import these from @showtrak/protocol/timers instead');
});

test('each type declared locally on purpose still extends the protocol’s', () => {
  const Source = fs.readFileSync(
    path.join(ROOT, 'src', 'Modules', 'SettingsManager', 'DefaultSettings.ts'),
    'utf8'
  );
  assert.match(
    Source,
    /interface SettingDefinition extends ProtocolSettingDefinition<SettingType>/,
    ALLOWED.get('SettingDefinition')
  );
});
