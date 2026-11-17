// AN-T17 done_when: "components composed only of @lims/ui (PeriodPicker, DurationText, FreshnessBadge from @lims/ui, CR-C8-013)".
// Static checks on the files the task owns. Node environment (no DOM).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FEATURE = join(import.meta.dirname, '..');
const COMPONENTS = join(FEATURE, 'components');
const SERVER = join(FEATURE, 'server');
const read = (f: string) => readFileSync(f, 'utf8');
const imports = (src: string) => [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)].map((m) => (m[1] ?? m[2])!);
const NAMES = ['ExportDialog', 'ScopeBanner'] as const;

describe('components/{ExportDialog,ScopeBanner}.tsx', () => {
  for (const n of NAMES) {
    const file = join(COMPONENTS, `${n}.tsx`);
    it(`${n}: exists and imports only react, @lims/ui/components/*, ../server/*, @/core/*, or relative modules`, () => {
      expect(existsSync(file), `missing ${file}`).toBe(true);
      const bad = imports(read(file)).filter((s) => !(s === 'react' || s.startsWith('@lims/ui/components/') || s.startsWith('@/core/') || s.startsWith('./') || s.startsWith('../')));
      expect(bad).toEqual([]);
    });
    it(`${n}: no raw HTML injection, no storage/env/console access`, () => {
      expect(existsSync(file)).toBe(true);
      const src = read(file);
      expect(src).not.toMatch(/dangerouslySetInnerHTML|innerHTML|localStorage|sessionStorage|process\.env|console\.log/);
    });
  }

  it('ExportDialog is a client component and does not import server-only modules directly (goes through a server action)', () => {
    const file = join(COMPONENTS, 'ExportDialog.tsx');
    expect(existsSync(file)).toBe(true);
    const src = read(file);
    expect(src).toMatch(/^\s*(['"])use client\1/);
    expect(imports(src).filter((s) => /\.server(\.ts)?$/.test(s))).toEqual([]);
  });

  it('no look-alike of the kit components PeriodPicker / DurationText / FreshnessBadge / FilterBar (08 R22)', () => {
    const files = existsSync(COMPONENTS) ? readdirSync(COMPONENTS, { recursive: true }).map(String) : [];
    expect(files.filter((f) => /(PeriodPicker|DurationText|FreshnessBadge|FilterBar)/i.test(f))).toEqual([]);
    expect(files.length).toBeGreaterThan(0);
  });
});

describe('server/*.server.ts', () => {
  const files = () => (existsSync(SERVER) ? readdirSync(SERVER).filter((f) => f.endsWith('.server.ts')) : []);

  it('at least one BFF module exists', () => {
    expect(files().length).toBeGreaterThan(0);
  });

  it("every module starts with `import 'server-only'` and is not a client module", () => {
    for (const f of files()) {
      const src = read(join(SERVER, f));
      const first = src.split('\n').find((l) => l.trim() && !l.trim().startsWith('//'));
      expect(first?.trim(), f).toMatch(/^import ['"]server-only['"];?$/);
      expect(src, f).not.toMatch(/['"]use client['"]/);
    }
  });

  it('every module reaches the API only through the shared serverFetch (no raw fetch, no env token, no logging of tokens)', () => {
    for (const f of files()) {
      const src = read(join(SERVER, f));
      expect(src, f).toContain('@/core/api/server-fetch');
      expect(src, f).not.toMatch(/(^|[^.\w])fetch\(|process\.env|console\.(log|info|debug)/);
    }
  });
});
