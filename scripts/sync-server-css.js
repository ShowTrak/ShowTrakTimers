// Brings ShowTrak Server's styling into Timers.
//
// Timers takes every UI element it shares with ShowTrak Server (the title bar,
// bottom bar, segmented toggles, menus, modals and their headers, Preferences,
// toasts, the confirmation dialog, the Software Update and About modals, the
// audio rows) straight from Server's stylesheet. Copying Server's CSS parts
// wholesale would ship thousands of rules for things Timers does not have, so
// this keeps only the rules whose class and id selectors are ALL used somewhere
// in Timers' markup or renderer code, plus element-only rules and the design
// tokens. The output lands in src/UI/css/parts/0*.css; Timers' own rules live in
// src/UI/css/parts/10-timers.css and are never touched by this script.
//
// Usage (from the Timers repo, with ShowTrakServer checked out beside it):
//   npm run sync:server-css                 # ../ShowTrakServer
//   npm run sync:server-css -- /path/to/ShowTrakServer
//
// Re-run it after changing Server's styling, or after Timers starts using a
// Server class it did not use before, then review the diff.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ServerRoot = path.resolve(process.argv[2] || path.join(ROOT, '..', 'ShowTrakServer'));
const PartsDir = path.join(ServerRoot, 'src', 'UI', 'css', 'parts');
const OutDir = path.join(ROOT, 'src', 'UI', 'css', 'parts');

function ListFiles(Dir, Filter) {
  const Out = [];
  for (const Entry of fs.readdirSync(Dir, { withFileTypes: true })) {
    const Full = path.join(Dir, Entry.name);
    if (Entry.isDirectory()) Out.push(...ListFiles(Full, Filter));
    else if (Filter(Entry.name)) Out.push(Full);
  }
  return Out;
}

// Everything that can name a class or id: the markup, and the renderer code
// that builds markup at runtime.
const Sources = [
  path.join(ROOT, 'src', 'UI', 'index.html'),
  path.join(ROOT, 'src', 'WebDashboard', 'index.html'),
  ...ListFiles(path.join(ROOT, 'src', 'UI', 'js', 'app'), (Name) => Name.endsWith('.ts')),
];

if (!fs.existsSync(PartsDir)) {
  console.error(`[sync-server-css] No ShowTrak Server CSS at ${PartsDir}`);
  process.exit(1);
}

// ---- used tokens ----
const Used = new Set();
for (const File of Sources) {
  const Text = fs.readFileSync(File, 'utf8');
  for (const M of Text.matchAll(/[A-Za-z_][A-Za-z0-9_-]*/g)) Used.add(M[0]);
}
// Classes Bootstrap adds at runtime, and states toggled by our code generically.
for (const C of [
  'show',
  'fade',
  'modal-backdrop',
  'modal-open',
  'modal-static',
  'collapsing',
  'active',
  'disabled',
  'focus',
  'showing',
  'hiding',
  'dropdown-menu-end',
  'is-invalid',
  'was-validated',
  'modal-dialog',
  'modal-content',
])
  Used.add(C);

// ---- tokenizer: top-level items (comments, rules, at-blocks) ----
function parseBlock(Text) {
  const Items = [];
  let i = 0;
  const N = Text.length;
  let PendingComments = [];
  while (i < N) {
    // whitespace
    if (/\s/.test(Text[i])) {
      i++;
      continue;
    }
    if (Text.startsWith('/*', i)) {
      const End = Text.indexOf('*/', i + 2);
      PendingComments.push(Text.slice(i, End + 2));
      i = End + 2;
      continue;
    }
    // read prelude up to { or ;
    let j = i,
      Depth = 0,
      Prelude = '';
    while (j < N && Text[j] !== '{' && Text[j] !== ';') {
      if (Text.startsWith('/*', j)) {
        const E = Text.indexOf('*/', j + 2);
        j = E + 2;
        continue;
      }
      if (Text[j] === '"' || Text[j] === "'") {
        const Q = Text[j];
        j++;
        while (j < N && Text[j] !== Q) {
          if (Text[j] === '\\') j++;
          j++;
        }
      }
      j++;
    }
    Prelude = Text.slice(i, j).trim();
    if (Text[j] === ';') {
      Items.push({ Kind: 'stmt', Prelude, Comments: PendingComments, Raw: Text.slice(i, j + 1) });
      PendingComments = [];
      i = j + 1;
      continue;
    }
    // block: find matching }
    let k = j + 1;
    Depth = 1;
    while (k < N && Depth > 0) {
      if (Text.startsWith('/*', k)) {
        const E = Text.indexOf('*/', k + 2);
        k = E + 2;
        continue;
      }
      if (Text[k] === '"' || Text[k] === "'") {
        const Q = Text[k];
        k++;
        while (k < N && Text[k] !== Q) {
          if (Text[k] === '\\') k++;
          k++;
        }
        k++;
        continue;
      }
      if (Text[k] === '{') Depth++;
      else if (Text[k] === '}') Depth--;
      k++;
    }
    const Body = Text.slice(j + 1, k - 1);
    Items.push({
      Kind: Prelude.startsWith('@') ? 'at' : 'rule',
      Prelude,
      Body,
      Comments: PendingComments,
    });
    PendingComments = [];
    i = k;
  }
  return Items;
}

function splitSelectors(Prelude) {
  const Out = [];
  let Depth = 0,
    Cur = '';
  for (const Ch of Prelude) {
    if (Ch === '(') Depth++;
    if (Ch === ')') Depth--;
    if (Ch === ',' && Depth === 0) {
      Out.push(Cur.trim());
      Cur = '';
    } else Cur += Ch;
  }
  if (Cur.trim()) Out.push(Cur.trim());
  return Out;
}

// Whether every class and id a selector names is used. Attribute selectors and
// pseudo-classes are ignored, except that :has(), :is() and :where() name
// elements that must exist, so their contents count too. (:not() names ones
// that must NOT match, so whether it is used does not matter.)
function selectorUsed(Sel) {
  const Clean = Sel.replace(/\[[^\]]*\]/g, '')
    .replace(/:not\([^)]*\)/g, '')
    .replace(/:(has|is|where)\(([^)]*)\)/g, ' $2 ')
    .replace(/::?[a-zA-Z-]+(\([^)]*\))?/g, '');
  const Tokens = [...Clean.matchAll(/[.#]([A-Za-z_][A-Za-z0-9_-]*)/g)].map((m) => m[1]);
  return Tokens.every((T) => Used.has(T));
}

function filterItems(Items) {
  const Out = [];
  for (const It of Items) {
    if (It.Kind === 'stmt') {
      Out.push(It.Comments.join('\n') + (It.Comments.length ? '\n' : '') + It.Raw);
      continue;
    }
    if (It.Kind === 'at') {
      if (/^@keyframes/.test(It.Prelude)) {
        Out.push({
          Keyframes: It.Prelude.split(/\s+/)[1],
          Text:
            It.Comments.join('\n') +
            (It.Comments.length ? '\n' : '') +
            `${It.Prelude} {${It.Body}}`,
        });
        continue;
      }
      if (/^@(media|supports|container)/.test(It.Prelude)) {
        const Inner = filterItems(parseBlock(It.Body)).filter((x) => typeof x === 'string');
        if (Inner.length)
          Out.push(
            It.Comments.join('\n') +
              (It.Comments.length ? '\n' : '') +
              `${It.Prelude} {\n${Inner.map((s) => s.replace(/^/gm, '  ')).join('\n\n')}\n}`
          );
        continue;
      }
      Out.push(
        It.Comments.join('\n') + (It.Comments.length ? '\n' : '') + `${It.Prelude} {${It.Body}}`
      );
      continue;
    }
    const Sels = splitSelectors(It.Prelude);
    const Kept = Sels.filter(selectorUsed);
    if (!Kept.length) continue;
    Out.push(
      It.Comments.join('\n') + (It.Comments.length ? '\n' : '') + `${Kept.join(',\n')} {${It.Body}}`
    );
  }
  return Out;
}

fs.mkdirSync(OutDir, { recursive: true });
// Remove the previous extraction (never Timers' own 10-*.css and later).
for (const File of fs.readdirSync(OutDir)) {
  if (/^0\d-.*\.css$/.test(File)) fs.rmSync(path.join(OutDir, File));
}
const Report = [];
const Written = [];
const AllKept = [];
for (const File of fs
  .readdirSync(PartsDir)
  .filter((f) => f.endsWith('.css'))
  .sort()) {
  const Text = fs.readFileSync(path.join(PartsDir, File), 'utf8');
  const Items = parseBlock(Text);
  const Out = filterItems(Items);
  AllKept.push({ File, Out });
}
// keyframes: keep those referenced anywhere in kept text
const KeptText = AllKept.map((p) => p.Out.filter((x) => typeof x === 'string').join('\n')).join(
  '\n'
);
for (const Part of AllKept) {
  const Final = Part.Out.map((x) =>
    typeof x === 'string' ? x : new RegExp(`\\b${x.Keyframes}\\b`).test(KeptText) ? x.Text : null
  ).filter(Boolean);
  if (!Final.length) continue;
  const Header = `/* Extracted from ShowTrak Server's src/UI/css/parts/${Part.File}: only the rules
   the Timers markup uses (scripts/sync-server-css.js). Edit Server's copy and
   re-run the sync, rather than editing these by hand. */\n\n`;
  Written.push([path.join(OutDir, Part.File), Header + Final.join('\n\n') + '\n']);
  Report.push(`${Part.File}: ${Final.length} items`);
}

// Written through Prettier (the repo's own config), so the extraction always
// passes `npm run format:check` and a re-sync only shows real changes, then
// main.css is rebuilt from the parts.
(async () => {
  const Prettier = require('prettier');
  for (const [File, Text] of Written) {
    const Options = (await Prettier.resolveConfig(File)) || {};
    fs.writeFileSync(File, await Prettier.format(Text, { ...Options, filepath: File }));
  }
  require('node:child_process').execFileSync(
    process.execPath,
    [path.join(__dirname, 'build-css.js')],
    { stdio: 'ignore' }
  );
  console.log(`[sync-server-css] From ${PartsDir}:\n  ${Report.join('\n  ')}`);
})().catch((Err) => {
  console.error('[sync-server-css] Failed:', Err);
  process.exit(1);
});
