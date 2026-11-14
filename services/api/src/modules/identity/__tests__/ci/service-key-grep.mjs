// identity-service-key-grep (CR-C2-014, 02-TRD s13, 07-SECURITY service-key confinement; LD-154).
// Exit 1 if the GoTrue service-key env var is read outside services/api/src/modules/identity/gotrue/gateway.http.ts.
// Usage: node service-key-grep.mjs [root]   (root defaults to the repo root). Prints offending paths only, never values.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const KEY = ['LIMS', 'IDENTITY', 'GOTRUE', 'SERVICE', 'KEY'].join('_');
const ALLOWED = 'services/api/src/modules/identity/gotrue/gateway.http.ts';
const TOP = ['services', 'apps', 'packages'];
const EXT = /\.(ts|tsx|js|mjs|cjs|dart|go|py|sh|yml|yaml)$/;
const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
const isTest = (p) => p.split('/').includes('__tests__') || /\.(test|spec)\.[^/]+$/.test(p);

const root = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ...Array(7).fill('..'));
const bad = [];

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIR.has(e.name)) walk(full); continue; }
    if (!e.isFile() || !EXT.test(e.name)) continue;
    const rel = relative(root, full).split(sep).join('/');
    if (rel === ALLOWED || isTest(rel)) continue;
    if (readFileSync(full, 'utf8').includes(KEY)) bad.push(rel);
  }
}

for (const t of TOP) walk(join(root, t));
if (bad.length) {
  console.error(`service key read outside ${ALLOWED}:`);
  for (const p of bad.sort()) console.error(p);
  process.exit(1);
}
