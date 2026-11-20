// RS-C2 (LD-140; 10-DESIGN-SYSTEM s3, s4, s6, s8) static checks over the C2 web paths:
//   apps/web/src/features/admin, apps/web/src/features/platform, apps/web/src/app/(auth), apps/web/src/app/(platform)
// 1. no raw colour / pixel radius / inline style object (same detector rules as packages/ui/scripts/__tests__/no-raw-style-literals.test.ts),
//    whether or not the directory is still listed in raw-style-pending.json;
// 2. 10-DESIGN-SYSTEM s6 "do not" list (gradients, glass, emoji, "Welcome back", utility rounded-xl);
// 3. behaviour unchanged: data/action files byte-identical (line endings ignored), and the union of API paths, permission codes,
//    form field names and route files equals the baseline recorded from HEAD before the restyle (rs-c2.baseline.json).
//    Record again only on purpose: RS_C2_RECORD=1.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', '..'); // apps/web/src
const ROOTS = ['features/admin', 'features/platform', 'app/(auth)', 'app/(platform)'];
const EXTS = /\.(?:tsx?|jsx?|mjs|cjs|css|scss)$/;
const baselineFile = join(here, 'rs-c2.baseline.json');

function* walk(abs: string, rel: string): Generator<[string, string]> {
  for (const n of readdirSync(abs).sort()) {
    const a = join(abs, n);
    const r = `${rel}/${n}`;
    if (statSync(a).isDirectory()) {
      if (n !== '__tests__' && n !== 'node_modules') yield* walk(a, r);
    } else if (EXTS.test(n)) yield [a, r];
  }
}
const files: Array<{ rel: string; text: string }> = ROOTS.flatMap((r) => [...walk(join(src, r), r)]).map(([a, rel]) => ({ rel, text: readFileSync(a, 'utf8').replace(/\r\n/g, '\n') }));

// ---------------------------------------------------------------- 1. raw style literals
type Hit = { file: string; line: number; kind: string; text: string };
const nonZeroPx = (v: string) => [...v.matchAll(/(?<![\w.-])(\d*\.?\d+)px/g)].some((m) => parseFloat(m[1]!) !== 0);
function stripComments(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((l) => (/^\s*(?:\/\/|\*)/.test(l) ? '' : l.replace(/(^|\s)\/\/.*$/, '$1')));
}
function scan(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  const lines = stripComments(text);
  const add = (i: number, kind: string) => hits.push({ file, line: i + 1, kind, text: lines[i]!.trim().slice(0, 120) });
  lines.forEach((l, i) => {
    if (/(?<![\w&.#])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/.test(l)) add(i, 'hex-colour');
    if (/\b(?:rgba?|hsla?)\(\s*\d/.test(l)) add(i, 'colour-fn');
    const css = /border(?:-[a-z]+)*-radius\s*:\s*([^;}\n]+)/i.exec(l);
    if (css && nonZeroPx(css[1]!)) add(i, 'radius-px');
    const camel = /\bborder\w*Radius\s*:\s*([^,}\n]+)/.exec(l);
    if (camel && (nonZeroPx(camel[1]!) || (/^\s*\d*\.?\d+\s*$/.test(camel[1]!) && parseFloat(camel[1]!) !== 0))) add(i, 'radius-px');
    if (/\bstyle\s*=\s*["']/.test(l)) add(i, 'inline-style');
  });
  const joined = lines.join('\n');
  for (const m of joined.matchAll(/\bstyle\s*=\s*\{\s*\{/g)) add(joined.slice(0, m.index).split('\n').length - 1, 'inline-style');
  return hits;
}

describe('no raw colour, pixel radius or inline style under the RS-C2 paths (LD-140)', () => {
  it('scans a non-trivial number of source files', () => {
    expect(files.length).toBeGreaterThan(40);
  });
  it('has no hit', () => {
    const hits = files.flatMap((f) => scan(f.rel, f.text));
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 2. s6 "do not" list
describe('10-DESIGN-SYSTEM s6: nothing that reads as AI-generated', () => {
  const code = files.map((f) => ({ rel: f.rel, lines: stripComments(f.text) }));
  const offenders = (re: RegExp) => code.flatMap((f) => f.lines.flatMap((l, i) => (re.test(l) ? [`${f.rel}:${i + 1} ${l.trim().slice(0, 100)}`] : [])));
  it('no gradient, glass blur or glow shadow', () => {
    expect(offenders(/(?:linear|radial|conic)-gradient\(|backdrop-?filter|backdropFilter|\bbox-?[sS]hadow\b|\bdrop-shadow\b/)).toEqual([]);
  });
  it('no emoji (one stroke icon family only)', () => {
    expect(offenders(/\p{Extended_Pictographic}/u)).toEqual([]);
  });
  it('no "Welcome back" greeting; left-aligned work first', () => {
    // T0D-MSERIES-5 / LD-276: the M1-entry board h1 is "Welcome back" (sources/M1-entry.dc.html:51); LoginForm.tsx is the only exemption.
    expect(offenders(/welcome back/i).filter((o) => !o.startsWith('features/admin/auth/LoginForm.tsx:'))).toEqual([]);
  });
  it('no utility rounded-* / bg-* classes (the radius ladder comes from the kit tokens)', () => {
    expect(offenders(/className\s*=\s*["'`{][^"'`}]*\b(?:rounded(?:-\w+)?|bg-\w+|shadow(?:-\w+)?)\b/)).toEqual([]);
  });
});

// ---------------------------------------------------------------- 3. behaviour unchanged
// Files with no markup: server actions, API client, copy/validation tables, nav manifests. A restyle has no reason to touch them.
const DATA_FILES = [
  'features/admin/actions.ts', 'features/admin/lib.ts', 'features/admin/server/api.ts', 'features/admin/auth/actions.ts',
  'features/admin/auth/messages.ts', 'features/admin/roles/actions.ts', 'features/admin/nav.manifest.ts',
  'features/platform/actions.ts', 'features/platform/server.ts', 'features/platform/shared.ts', 'features/platform/nav.manifest.ts',
];
const sha = (t: string) => createHash('sha256').update(t).digest('hex');
const uniq = (xs: string[]) => [...new Set(xs)].sort();
const uiText = files.filter((f) => !DATA_FILES.includes(f.rel));
function surface() {
  const all = files.map((f) => f.text).join('\n');
  return {
    data_files: Object.fromEntries(DATA_FILES.map((d) => [d, sha(files.find((f) => f.rel === d)?.text ?? 'MISSING')])),
    routes: files.filter((f) => f.rel.startsWith('app/')).map((f) => f.rel).sort(),
    api_paths: uniq([...all.matchAll(/(?:\/v1|\$\{[A-Z_]+\})\/[\w/${}.:-]+/g)].map((m) => m[0])),
    permission_codes: uniq([...all.matchAll(/['"`]([a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)['"`]/g)].map((m) => m[1]!)),
    field_names: uniq([
      ...uiText.flatMap((f) => [...f.text.matchAll(/\bname\s*=\s*["']([\w.[\]-]+)["']/g)].map((m) => m[1]!)),
      ...[...all.matchAll(/\.get\(\s*['"]([\w.-]+)['"]\s*\)/g)].map((m) => m[1]!),
    ]),
  };
}

describe('behaviour unchanged: API calls, field names, validation, permissions, routes', () => {
  if (process.env['RS_C2_RECORD'] === '1') {
    it('records the baseline', () => {
      writeFileSync(baselineFile, `${JSON.stringify(surface(), null, 2)}\n`);
    });
    return;
  }
  const base = JSON.parse(readFileSync(baselineFile, 'utf8')) as ReturnType<typeof surface>;
  const now = surface();
  it('data, action, validation-table and nav files are untouched', () => {
    expect(now.data_files).toEqual(base.data_files);
  });
  it('same route files', () => {
    expect(now.routes).toEqual(base.routes);
  });
  it('same API paths', () => {
    expect(now.api_paths).toEqual(base.api_paths);
  });
  it('same permission codes', () => {
    expect(now.permission_codes).toEqual(base.permission_codes);
  });
  it('same form field names', () => {
    expect(now.field_names).toEqual(base.field_names);
  });
  it('baseline is not empty (guards against a vacuous pass)', () => {
    expect(base.api_paths.length).toBeGreaterThan(10);
    expect(base.permission_codes.length).toBeGreaterThan(5);
    expect(base.field_names.length).toBeGreaterThan(10);
    expect(base.routes.length).toBeGreaterThan(15);
  });
});

// ---------------------------------------------------------------- 4. structure the done_when names
describe('structure (10-DESIGN-SYSTEM s4): masters are a list + right drawer with per-section Save; roles use PermissionMatrix', () => {
  const read = (rel: string) => files.find((f) => f.rel === rel)?.text ?? '';
  it('branches / centres drawer is built from the kit Drawer with at least two DrawerSection blocks (per-section Save)', () => {
    const t = read('features/admin/components/OrgUnits.tsx');
    expect(/from '@lims\/ui\/components\/Drawer'/.test(t)).toBe(true);
    expect((t.match(/<DrawerSection\b/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
  it('role editor keeps the kit PermissionMatrix', () => {
    expect(/from '@lims\/ui\/components\/PermissionMatrix'/.test(read('features/admin/components/RoleEditor.tsx'))).toBe(true);
  });
});
