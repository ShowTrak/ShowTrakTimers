// Text-level helpers for tests that read the project's own files (markup,
// stylesheets, renderer sources, workflows) rather than running them.
//
// Every read normalises CRLF to LF, so a Windows checkout with autocrlf on
// parses exactly like the other two platforms. No HTML or YAML parser is pulled
// in: the files under test are our own, consistently formatted (Prettier), and
// a crude tokenizer is enough to answer "does this id exist".
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');

/** Read a file under the project root as LF-normalised UTF-8 text. */
function readText(...Segments) {
  return fs.readFileSync(path.join(ROOT, ...Segments), 'utf8').replace(/\r\n?/g, '\n');
}

/** True when a path under the project root exists. */
function exists(...Segments) {
  return fs.existsSync(path.join(ROOT, ...Segments));
}

function stripHtmlComments(Html) {
  return Html.replace(/<!--[\s\S]*?-->/g, '');
}

/** Attributes of one start tag's attribute text, keyed by lower-cased name. */
function parseAttributes(Source) {
  const Attrs = {};
  for (const M of String(Source).matchAll(/([^\s=/"]+)(?:\s*=\s*"([^"]*)")?/g)) {
    Attrs[M[1].toLowerCase()] = M[2] ?? '';
  }
  return Attrs;
}

/**
 * Every start tag in `Html`, in document order, with comments removed first.
 * `Index` is the offset into the comment-stripped text (see `stripHtmlComments`).
 */
function startTags(Html) {
  const Tags = [];
  for (const M of stripHtmlComments(Html).matchAll(/<([a-zA-Z][\w-]*)([^>]*)>/g)) {
    Tags.push({ Name: M[1].toLowerCase(), Attrs: parseAttributes(M[2]), Index: M.index });
  }
  return Tags;
}

/** Every id attribute in `Html`, duplicates included, in document order. */
function htmlIds(Html) {
  return startTags(Html)
    .map((Tag) => Tag.Attrs.id)
    .filter(Boolean);
}

/** Files directly inside `Dir` (relative to the root) whose names match `Pattern`. */
function listFiles(Dir, Pattern) {
  return fs
    .readdirSync(path.join(ROOT, Dir), { withFileTypes: true })
    .filter((Entry) => Entry.isFile() && Pattern.test(Entry.name))
    .map((Entry) => path.join(Dir, Entry.name))
    .sort();
}

/** Every file under `Dir` (relative to the root), recursively, skipping `Skip` dir names. */
function walkFiles(Dir, Skip = new Set()) {
  const Out = [];
  for (const Entry of fs.readdirSync(path.join(ROOT, Dir), { withFileTypes: true })) {
    const Rel = path.join(Dir, Entry.name);
    if (Entry.isDirectory()) {
      if (!Skip.has(Entry.name)) Out.push(...walkFiles(Rel, Skip));
    } else if (Entry.isFile()) {
      Out.push(Rel);
    }
  }
  return Out.sort();
}

module.exports = {
  ROOT,
  readText,
  exists,
  stripHtmlComments,
  parseAttributes,
  startTags,
  htmlIds,
  listFiles,
  walkFiles,
};
