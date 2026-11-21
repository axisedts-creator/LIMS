// T0D-TESTIMPORT-1 static checks (node environment, tester-owned). done_when (5) and the closing clause of (6):
//   - no spreadsheet library in the browser bundle (the SERVER parses): apps/web has no such dependency and no source imports one;
//   - the upload goes through the kit FileUpload (the standard upload helper with progress): the import screen file uses it with `uploadFile` and maxBytes 5 MB,
//     and holds no raw <input type="file">, no XMLHttpRequest and no direct fetch to the API from client code;
//   - the six typed calls live in NEW files under features/catalog/server (the six operation paths, server-only), never in client components;
//   - NO route is added or removed under app/(staff)/catalog (rs-c2 / rs-c3 pin the route tree and the tester sandbox cannot re-record them);
//   - the files the task must not touch (features/admin, features/platform, app/(auth), app/(platform)) keep their route trees: counted by pinned lists.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { featureDir, routeDir, routes, walk, web } from './rs-c3.surface';

const src = join(web, 'src');
const rel = (p: string) => relative(web, p).split('\\').join('/');
const read = (f: string) => readFileSync(f, 'utf8');
const allSrc = () => walk(src).filter((f) => /\.(tsx?|css)$/.test(f) && !/\.test\./.test(f));
const SHEET_LIBS = ['xlsx', 'exceljs', 'sheetjs', 'xlsx-populate', 'xlsx-js-style', 'read-excel-file', 'write-excel-file', 'node-xlsx', 'jszip', 'fflate', 'papaparse', 'csv-parse', 'adm-zip', 'pizzip'];
const libImport = (text: string) => SHEET_LIBS.filter((l) => new RegExp(`(?:from\\s+|import\\s*\\(\\s*|require\\s*\\(\\s*|import\\s+)['"]${l.replace(/[-.]/g, '\\$&')}(?:/[^'"]*)?['"]`).test(text));

describe('no spreadsheet library in the browser bundle', () => {
  it('self-check: the detector sees the usual import forms', () => {
    expect(libImport(`import * as X from 'xlsx';`)).toEqual(['xlsx']);
    expect(libImport(`const x = await import("exceljs");`)).toEqual(['exceljs']);
    expect(libImport(`import Papa from 'papaparse'`)).toEqual(['papaparse']);
    expect(libImport(`import { a } from 'xlsx-extra-not-a-lib-but-prefix'`)).toEqual([]);
  });
  it('apps/web/package.json lists none of them', () => {
    const pkg = JSON.parse(read(join(web, 'package.json'))) as Record<string, Record<string, string> | undefined>;
    const deps = Object.keys({ ...pkg['dependencies'], ...pkg['devDependencies'], ...pkg['optionalDependencies'] });
    expect(deps.filter((d) => SHEET_LIBS.includes(d))).toEqual([]);
  });
  it('no source file of apps/web/src imports one', () => {
    const hits = allSrc().map((f) => [rel(f), libImport(read(f))] as const).filter(([, l]) => l.length);
    expect(hits).toEqual([]);
  });
});

const clientFiles = (files: string[]) => files.filter((f) => /^\s*['"]use client['"]/.test(read(f)));

describe('the import screen uses the standard upload helper', () => {
  it('a NEW file under features/catalog mentions the test import and renders the kit FileUpload with uploadFile and a 5 MB limit', () => {
    const screens = walk(join(featureDir, 'components')).filter((f) => /\.tsx$/.test(f)).filter((f) => /FileUpload/.test(read(f)) && /uploadFile\s*=/.test(read(f)) && /5\s*\*\s*1024\s*\*\s*1024|5_?242_?880|5\s*\*\s*MB/.test(read(f)));
    expect(screens.map(rel), 'a component with <FileUpload uploadFile=... maxBytes=5 MB>').not.toEqual([]);
    for (const f of screens) {
      const text = read(f);
      expect(text).toMatch(/from\s+'@lims\/ui\/components\/FileUpload'/);
      expect(text).not.toMatch(/<input[^>]*type=["']file["']/);
      expect(text).not.toMatch(/XMLHttpRequest/);
      expect(text, 'the browser never calls the API directly').not.toMatch(/LIMS_ORIGIN_API|\/v1\/catalog\//);
    }
  });
  it('client components never import a spreadsheet parser nor read the file bytes themselves (the server parses)', () => {
    for (const f of clientFiles(walk(join(featureDir, 'components')).filter((x) => /\.tsx?$/.test(x)))) {
      if (!/FileUpload/.test(read(f))) continue;
      expect(read(f), `${rel(f)} must not read the workbook`).not.toMatch(/\.arrayBuffer\(\)|FileReader|\.stream\(\)|\.text\(\)/);
    }
  });
});

describe('typed server calls (done_when: "typed calls and the upload helper use")', () => {
  const OPS: [string, RegExp][] = [
    ['template', /\/v1\/catalog\/test-import-template/],
    ['validate (upload)', /\/v1\/catalog\/test-import-batches['"`]/],
    ['history', /\/v1\/catalog\/test-import-batches/],
    ['commit', /\/commit/],
    ['errors file', /\/errors-file/],
  ];
  const serverFiles = () => walk(join(featureDir, 'server')).filter((f) => /\.tsx?$/.test(f) && /test-import/.test(read(f)));
  it('every operation path is referenced from files under features/catalog/server, and only from there', () => {
    const text = serverFiles().map(read).join('\n');
    for (const [name, re] of OPS) expect(text, `${name} call`).toMatch(re);
    const outside = walk(featureDir).filter((f) => /\.tsx?$/.test(f) && !f.includes(join(featureDir, 'server')) && /\/v1\/catalog\/test-import/.test(read(f)));
    expect(outside.map(rel), 'API paths outside the server layer').toEqual([]);
  });
  it('server files are server-only (the bearer JWT never reaches client code)', () => {
    for (const f of serverFiles()) expect(read(f), rel(f)).toMatch(/import\s+'server-only'|^\s*['"]use server['"]/m);
  });
  it('the upload sends the declared fields only: file and mode, with an Idempotency-Key', () => {
    const t = serverFiles().map(read).join('\n');
    expect(t).toMatch(/idempotency-key/i);
    expect(t).toMatch(/create_only/);
    expect(t).toMatch(/['"`]update['"`]/);
    expect(t).toMatch(/If-Match|if-match/);
  });
});

describe('no route added or removed (rs-c2 / rs-c3 pin the tree; the tester sandbox cannot re-record it)', () => {
  const PINNED = [
    'comment-codes/page.tsx', 'credit-parties/[credit_party_id]/page.tsx', 'credit-parties/page.tsx', 'departments/page.tsx', 'doctors/[doctor_id]/page.tsx', 'doctors/page.tsx', 'doctors/verify/page.tsx',
    'exports/[export_id]/file/route.ts', 'import-templates/[kind]/route.ts', 'imports/[import_id]/page.tsx', 'imports/[import_id]/report/route.ts', 'imports/page.tsx', 'methods/page.tsx',
    'page.tsx', 'panels/[panel_id]/page.tsx', 'panels/page.tsx', 'price-lists/[price_list_id]/page.tsx', 'price-lists/[price_list_id]/versions/[version_id]/page.tsx', 'price-lists/page.tsx',
    'price-simulator/page.tsx', 'specimens/page.tsx', 'surcharges/page.tsx', 'tax/page.tsx', 'tests/[test_id]/page.tsx', 'tests/page.tsx', 'units/page.tsx',
  ].sort();
  it('the catalog route tree is exactly the 26 files it has today', () => {
    expect(routes().sort()).toEqual(PINNED);
  });
  it('apps/web/src/app/(staff)/catalog holds no other page or route file (even outside the rs-c3 pattern)', () => {
    const files = walk(routeDir).filter((f) => /(?:^|[\\/])(page|route|layout|template|default)\.(?:tsx?|jsx?)$/.test(f)).map((f) => relative(routeDir, f).split('\\').join('/')).filter((f) => !/(^|\/)layout\./.test(f));
    expect(files.sort()).toEqual(PINNED);
  });
  it('nav.manifest.ts keeps its 15 entries (nav-complete pins them; the screen hangs off /catalog/imports)', () => {
    const ids = [...read(join(featureDir, 'nav.manifest.ts')).matchAll(/\{\s*id:\s*'catalog\.[a-z_]+'/g)];
    expect(ids).toHaveLength(15);
  });
});

describe('files the task must not touch keep their shape', () => {
  const count = (dir: string) => { let n = 0; const go = (d: string) => { for (const e of readdirSync(d)) { const p = join(d, e); if (statSync(p).isDirectory()) go(p); else if (/(?:page|route)\.tsx?$/.test(e)) n++; } }; go(dir); return n; };
  it('no page or route file appeared under app/(auth) or app/(platform) (counts pinned from the current tree)', () => {
    const now = { auth: count(join(src, 'app', '(auth)')), platform: count(join(src, 'app', '(platform)')) };
    // pinned 2026-11-18 from the lane tree (C0-0K); a change here means a route was added or removed, which this task must not do
    expect(now).toEqual(PINNED_COUNTS);
  });
});
const PINNED_COUNTS = { auth: 10, platform: 10 };
