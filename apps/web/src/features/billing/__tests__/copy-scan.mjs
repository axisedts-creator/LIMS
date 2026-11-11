// c04-copy-scan (02-TRD §CI jobs for C0-0A; PRD US-BL-16; 04-UI-UX §1). Fails on banned IRD/commission wording in shipped C4 billing/front-desk
// UI, renderer templates and manuals. Also fails if the scan set is empty (BL-T20 not implemented) so it cannot pass vacuously.
// Usage: node apps/web/src/features/billing/__tests__/copy-scan.mjs   (from repo root; exit 1 on any hit)
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
// [CONV] whitespace-tolerant (\s covers newline/tab/nbsp) and matched over whole file text so wrapped phrases cannot slip through.
const BANNED = [/IRD[\s-]+approved/gi, /IRD\s+certified/gi, /approved\s+by\s+IRD/gi, /commission/gi];
const ROOTS = [
  'apps/web/src/features/billing', 'apps/web/src/features/frontdesk', 'apps/web/src/app/(staff)/billing', 'apps/web/src/app/(staff)/frontdesk',
  'services/renderer/templates/billing', 'docs/manual/billing', 'docs/manual/frontdesk',
];
const SKIP = (p) => p.split(sep).includes('__tests__') || p.split(sep).includes('node_modules');
const walk = (d) => (existsSync(d) ? readdirSync(d).flatMap((n) => { const p = join(d, n); return SKIP(p) ? [] : statSync(p).isDirectory() ? walk(p) : [p]; }) : []);

const files = ROOTS.flatMap((r) => walk(join(root, r)));
const hits = files.flatMap((f) => {
  const text = readFileSync(f, 'utf8');
  return BANNED.flatMap((re) => [...text.matchAll(re)].map((m) => `${relative(root, f)}:${text.slice(0, m.index).split('\n').length}: ${re}`));
});
// Billing screens must exist for the scan to mean anything (BL-T20 owns these).
const screens = files.filter((f) => /[\\/]app[\\/]\(staff\)[\\/]billing[\\/].*page\.tsx$/.test(f)).length;
const comps = files.filter((f) => /features[\\/]billing[\\/]components[\\/].*\.tsx$/.test(f)).length;
if (screens === 0 || comps === 0) { console.error(`copy-scan: empty scan set (billing pages=${screens}, billing components=${comps}) — BL-T20 not implemented`); process.exit(1); }
if (hits.length) { console.error(`copy-scan: banned wording found:\n${hits.join('\n')}`); process.exit(1); }
console.log(`copy-scan: ${files.length} files clean (${screens} billing pages, ${comps} components)`);
