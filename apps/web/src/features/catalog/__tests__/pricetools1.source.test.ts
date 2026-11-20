// T0D-PRICETOOLS-1 static checks (tester-owned; node environment, no rendering). What these pin (done_when 4, 5 and the LD-353 / LD-321 rules):
//   - the first walk is written down (done_when 1): .orchestra/notes/T0D-PRICETOOLS-1-walk.md names the ElabAssist screens and what is missing;
//   - no spreadsheet / CSV / PDF library in apps/web (the SERVER reads the xlsx, the browser only uploads; CSV is built by hand);
//   - the typed calls of the operations live in features/catalog/server files marked server-only, writes carry an Idempotency-Key, ids are shape checked;
//   - client components never fetch the API themselves, never import a *.server module for values (types only), and use the kit FileUpload (5 MB, no raw file input);
//   - money: no float parsing or printing in the price tool files (integer paisa end to end);
//   - text comes from the message catalogue (keys catalog.price_tools.*), no exclamation marks, no HTML;
//   - NO route, no nav entry is added by this task (the screens are views of existing routes; testimport1.source pins the 26 route files, nav-complete.catalog the 15 entries).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = join(import.meta.dirname, '..', '..', '..', '..'); // apps/web
const ROOT = join(WEB, '..', '..');
const SRC = join(WEB, 'src');
const CAT = join(SRC, 'features', 'catalog');
const read = (p: string) => readFileSync(p, 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((e) => { const p = join(d, e); return statSync(p).isDirectory() ? (e === '__tests__' || e === 'node_modules' ? [] : walk(p)) : [p]; });
const rel = (p: string) => relative(WEB, p).split('\\').join('/');
const src = (dir: string) => walk(dir).filter((f) => /\.(ts|tsx)$/.test(f));
const SERVER = src(join(CAT, 'server'));
const COMPONENTS = src(join(CAT, 'components'));

/** The price tool files: any server / component file that talks about one of the operations or one of the screens by its pinned wording. */
const SERVER_MARKERS = /price-list-import-template|import-dry-run|price-list-import-batches|bulk-update|price-list-comparisons|price-lists\/\$\{[^}]+\}\/copy/;
const CLIENT_MARKERS = /Upload and check|Bulk update|Compare price lists|Copy to|Commit to draft|Version A/;
const serverFiles = SERVER.filter((f) => SERVER_MARKERS.test(read(f)));
const clientFiles = COMPONENTS.filter((f) => CLIENT_MARKERS.test(read(f)));
const messagesSrc = read(join(SRC, 'core', 'i18n', 'messages.ts'));
const keys = [...messagesSrc.matchAll(/'(catalog\.price_tools\.[a-z0-9_.]+)':\s*(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/g)].map((m) => ({ key: m[1]!, text: m[2] ?? m[3]! }));

describe('T0D-PRICETOOLS-1 first walk (done_when 1)', () => {
  const walkNote = join(ROOT, '.orchestra', 'notes', 'T0D-PRICETOOLS-1-walk.md');
  it('.orchestra/notes/T0D-PRICETOOLS-1-walk.md exists and says which ElabAssist screen each price list screen replaces and what is missing', () => {
    expect(existsSync(walkNote), 'the writer writes the walk note first').toBe(true);
    const t = read(walkNote);
    for (const w of [/Price Allocation/i, /Rate Master/i, /Test Rate Card/i, /replaces/i, /missing/i]) expect(t, String(w)).toMatch(w);
    expect(t.length).toBeGreaterThan(400);
  });
});

describe('T0D-PRICETOOLS-1 no new library, no new route', () => {
  const pkg = JSON.parse(read(join(WEB, 'package.json'))) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const FORBIDDEN = ['xlsx', 'exceljs', 'sheetjs', 'papaparse', 'csv-stringify', 'csv-parse', 'jspdf', 'pdfmake', 'file-saver', 'react-datepicker', 'moment', 'lodash'];
  it('apps/web/package.json has no spreadsheet, CSV, PDF, date picker or utility library', () => {
    const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    expect(all.filter((d) => FORBIDDEN.includes(d) || /^(@sheet|xlsx-)/.test(d))).toEqual([]);
  });
  it('no catalog source imports one of them', () => {
    const bad = [...SERVER, ...COMPONENTS].filter((f) => new RegExp(`from ['"](${FORBIDDEN.join('|')})['"/]`).test(read(f)));
    expect(bad.map(rel)).toEqual([]);
  });
  it('no page, route or layout file was added for the tools (they are views of price-lists and price-lists/[id]); no compare / copy / bulk / template folder', () => {
    const dirs: string[] = [];
    const go = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) { dirs.push(e); go(p); } } };
    go(join(SRC, 'app', '(staff)', 'catalog'));
    expect(dirs.filter((x) => /compare|copy|bulk|template|upload/i.test(x))).toEqual([]);
  });
});

describe('T0D-PRICETOOLS-1 typed calls (BFF)', () => {
  const FILE_OF: [string, RegExp][] = [
    ['downloadPriceListTemplate', /price-list-import-template/],
    ['dryRunPriceListImport', /import-dry-run/],
    ['commitPriceListImport', /price-list-import-batches\/\$\{[^}]+\}\/commit|\/commit/],
    ['listPriceListImportBatches', /price-list-import-batches/],
    ['bulkUpdatePriceListDraft', /bulk-update/],
    ['copyPriceList', /\/copy/],
    ['comparePriceLists', /price-list-comparisons/],
  ];
  it.each(FILE_OF)('%s has a typed call in a features/catalog/server file', (_op, re) => {
    expect(serverFiles.some((f) => re.test(read(f))), `no server file calls ${re}`).toBe(true);
  });
  it('every file that carries an operation path is server-only (REQ-SEC-068: the bearer JWT stays on the server) or a "use server" actions file', () => {
    expect(serverFiles.length).toBeGreaterThanOrEqual(1);
    for (const f of serverFiles) { const t = read(f); expect(/import 'server-only'|import "server-only"|^'use server'|^"use server"/m.test(t), rel(f)).toBe(true); }
  });
  it('the four writes (dry run, commit, bulk update, copy) send an Idempotency-Key', () => {
    for (const re of [/import-dry-run/, /\/commit/, /bulk-update/, /\/copy/]) {
      const f = serverFiles.filter((x) => re.test(read(x)));
      expect(f.length, String(re)).toBeGreaterThan(0);
      expect(f.some((x) => /idempotency-key/i.test(read(x))), `Idempotency-Key for ${re}`).toBe(true);
    }
  });
  it('ids are shape checked before they reach a path (uuid helper or UUID regex) and the upload size / name are re-checked', () => {
    const t = serverFiles.map(read).join('\n');
    expect(t).toMatch(/uuid\(|UUID_RE|isUuid/i);
    expect(t).toMatch(/5 \* 1024 \* 1024|5242880|MAX_BYTES/);
    expect(t).toMatch(/\.xlsx/i);
  });
  it('the multipart body is forwarded with ONLY the file part (no client controlled extra fields)', () => {
    const f = serverFiles.find((x) => /import-dry-run/.test(read(x)));
    expect(f).toBeTruthy();
    const t = read(f!);
    expect(t).toMatch(/name="file"/);
    expect(t.match(/name="[a-z_]+"/g)?.filter((n) => n !== 'name="file"') ?? []).toEqual([]);
  });
});

describe('T0D-PRICETOOLS-1 client components', () => {
  it('there are client components for the tools', () => {
    expect(clientFiles.length).toBeGreaterThanOrEqual(2);
  });
  it('no client component calls fetch, XMLHttpRequest or a storage URL directly', () => {
    for (const f of clientFiles) expect(/\bfetch\(|XMLHttpRequest|https?:\/\/(?!www\.w3\.org)/.test(read(f)), rel(f)).toBe(false);
  });
  it('client components import *.server modules for TYPES only', () => {
    for (const f of clientFiles) for (const m of read(f).matchAll(/^import\s+(?!type\b)[^;]*from ['"][^'"]*\.server['"]/gm)) throw new Error(`${rel(f)} imports a .server module for values: ${m[0]}`);
  });
  it('the upload goes through the kit FileUpload with a 5 MB limit; no raw <input type="file">', () => {
    const f = clientFiles.filter((x) => /Upload and check/.test(read(x)));
    expect(f.length).toBeGreaterThan(0);
    const t = f.map(read).join('\n');
    expect(t).toMatch(/@lims\/ui\/components\/FileUpload/);
    expect(t).toMatch(/5 \* 1024 \* 1024|5242880|5 \* MB|MAX_BYTES/);
    expect(/<input[^>]*type=["']file["']/.test(t)).toBe(false);
  });
  it('the effective dates use native date inputs (no picker library)', () => {
    const t = COMPONENTS.map(read).join('\n');
    expect(t).toMatch(/type=["']date["']/);
  });
  it('tables of the tools use the compact table class and the empty-row kit parts (headers always drawn, LD-336)', () => {
    const t = clientFiles.map(read).join('\n');
    expect(t).toMatch(/lims-table-compact/);
    expect(t).toMatch(/EmptyRow|PlaceholderRows/);
  });
  it('money is integer paisa: no parseFloat, toFixed or float division in the price tool files', () => {
    for (const f of [...serverFiles, ...clientFiles]) {
      const t = read(f).replace(/\/\/.*$/gm, '');
      expect(/parseFloat\(|\.toFixed\(|Number\.parseFloat|\bMath\.(round|floor|ceil|trunc)\([^)]*\/\s*100\b/.test(t), `${rel(f)} handles money with floats`).toBe(false);
    }
  });
  it('percent and amounts are parsed from text by pattern (a regex with at most 2 decimals), not by Number(text)', () => {
    const t = clientFiles.map(read).join('\n');
    expect(t).toMatch(/\\d\{1,\d\}/); // e.g. /^(-?\d{1,4})(?:\.(\d{1,2}))?$/
    expect(/Number\(\s*(text|value|input|raw|s)\s*\)/.test(t), 'Number(text) accepts 1e2, 0x10 and blanks').toBe(false);
  });
  it('uses the shared double submit guard idiom (a ref or busy state) around every write', () => {
    for (const f of clientFiles.filter((x) => /Action\(/.test(read(x)))) expect(/useRef|isLoading|isDisabled=\{busy|busy/.test(read(f)), rel(f)).toBe(true);
  });
});

describe('T0D-PRICETOOLS-1 message catalogue (done_when 5)', () => {
  it('messages.ts holds the screen text under catalog.price_tools.* (at least 25 keys)', () => {
    expect(keys.length).toBeGreaterThanOrEqual(25);
  });
  it('every catalog.price_tools key used in a component exists in the catalogue', () => {
    const used = new Set(clientFiles.flatMap((f) => [...read(f).matchAll(/\bt\(\s*['"](catalog\.price_tools\.[a-z0-9_.]+)['"]/g)].map((m) => m[1]!)));
    expect(used.size).toBeGreaterThan(0);
    for (const k of used) expect(messagesSrc, k).toContain(`'${k}'`);
  });
  it('catalogue text is plain: no exclamation mark, no HTML, no development wording (LD-353 rule 8)', () => {
    for (const k of keys) {
      expect(k.text, k.key).not.toMatch(/!|<[a-z/]|TODO|placeholder|coming soon/i);
      expect(k.text.length, k.key).toBeGreaterThan(0);
    }
  });
  it('the permission reasons name the permission code exactly once per key (catalog.price_list.manage)', () => {
    expect(keys.some((k) => /catalog\.price_list\.manage/.test(k.text))).toBe(true);
  });
});

describe('T0D-PRICETOOLS-1 contract surface unchanged', () => {
  it('permissions are the existing ones: catalog.price_list.read and catalog.price_list.manage; no new permission string appears in the tool files', () => {
    const t = [...serverFiles, ...clientFiles].map(read).join('\n');
    const codes = new Set([...t.matchAll(/['"`](catalog\.[a-z_]+\.(?:read|manage|publish|approve))['"`]/g)].map((m) => m[1]));
    for (const c of codes) expect(['catalog.price_list.read', 'catalog.price_list.manage', 'catalog.price_list.publish', 'catalog.test.read', 'catalog.test.manage', 'catalog.referrer.read', 'catalog.referrer.manage']).toContain(c);
  });
  it('no 501 / operation_pending branch is left for the seven operations (they are live since T0B-PRICETOOLS-1)', () => {
    for (const f of [...serverFiles, ...clientFiles]) expect(/operation_pending/.test(read(f)), rel(f)).toBe(false);
  });
});
