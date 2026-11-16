// T0B-OPSDOC-1 (RS-16, LD-277): the committed scan that lists every LIMS_* name the API, the worker and the web read.
// Names only. Comments are stripped first so a name that is only mentioned in prose is not counted as read.
// Limit: a name built at run time (`LIMS_${x}`) is invisible to a static scan; payments/config.ts and engagement/config.ts build names from a prefix; those rows are hand-maintained in docs/runbooks/environment.md (done_when (2) does not cover them).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCAN_ROOTS = ['services/api/src', 'services/worker/src', 'apps/web/src'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.next', 'coverage', '__tests__', '__fixtures__', 'fixtures', 'tests']);
const SOURCE = /\.(ts|tsx|mjs|js|cjs)$/;
const NOT_SOURCE = /(\.(test|spec)\.[cm]?[jt]sx?$|\.d\.ts$)/;
const NAME = /\bLIMS_[A-Z0-9_]*[A-Z0-9]\b/g;

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

function* files(dir) {
  for (const n of readdirSync(dir)) {
    if (SKIP_DIRS.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (SOURCE.test(n) && !NOT_SOURCE.test(n)) yield p;
  }
}

/** @returns {Map<string, string[]>} name -> repo-relative files that mention it (sorted by name). */
export function scanLimsEnv(repoRoot) {
  const found = new Map();
  for (const root of SCAN_ROOTS) {
    if (!existsSync(join(repoRoot, root))) continue;
    for (const f of files(join(repoRoot, root))) {
      const rel = relative(repoRoot, f).replace(/\\/g, '/');
      for (const m of stripComments(readFileSync(f, 'utf8')).matchAll(NAME)) {
        const list = found.get(m[0]) ?? [];
        if (!list.includes(rel)) list.push(rel);
        found.set(m[0], list);
      }
    }
  }
  return new Map([...found].sort(([a], [b]) => (a < b ? -1 : 1)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const [name, where] of scanLimsEnv(process.cwd())) console.log(`${name}\t${where.join(',')}`);
}
