// Concatenates the CSS parts (src/UI/css/parts/*.css, in filename order) into
// src/UI/css/main.css, which copy-assets.js ships verbatim to
// dist/UI/css/main.css for the desktop window and the Web Dashboard.
//
// The 0* parts are ShowTrak Server's (copied in by scripts/sync-server-css.js);
// 10-timers.css is this app's. Concatenation is strictly order-preserving
// (Buffer.concat), so the cascade is exactly the parts' order. Edit the parts
// under src/UI/css/parts/, NOT main.css (it is regenerated on every build).
const fs = require('node:fs');
const path = require('node:path');

const PARTS_DIR = path.resolve(__dirname, '..', 'src', 'UI', 'css', 'parts');
const OUT = path.resolve(__dirname, '..', 'src', 'UI', 'css', 'main.css');

function main() {
  const parts = fs
    .readdirSync(PARTS_DIR)
    .filter((name) => name.endsWith('.css'))
    .sort();
  const buffers = parts.map((name) => fs.readFileSync(path.join(PARTS_DIR, name)));
  const next = Buffer.concat(buffers);

  // Skip the write when nothing changed so `main.css`'s mtime does not churn on
  // every build (it lives under src/, which `npm start`'s nodemon watches; a
  // needless rewrite would retrigger the watcher). nodemon also ignores this
  // file explicitly; this is belt-and-suspenders.
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT) : null;
  if (current && current.equals(next)) {
    console.log(`[build-css] ${parts.length} CSS part(s) unchanged -> src/UI/css/main.css`);
    return;
  }
  fs.writeFileSync(OUT, next);
  console.log(`[build-css] Concatenated ${parts.length} CSS part(s) -> src/UI/css/main.css`);
}

main();
