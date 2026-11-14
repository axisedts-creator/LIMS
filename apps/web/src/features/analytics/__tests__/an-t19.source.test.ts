// AN-T19 — source-level done_when / security rules for apps/web/src/app/(staff)/analytics/{reports,collections}/**
// (04-UI-UX §3 intro "components only from @lims/ui", REQ-SEC-088/089 text nodes only, US-07.3 no "commission", no client-side token/storage).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../../app/(staff)/analytics/', import.meta.url));
const SLUGS = ['income', 'department-income', 'volume', 'top-referrers', 'top-centres', 'tests-done', 'tat', 'pending-tests', 'quality-indicators', 'delivery', 'interfaces'];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|tsx)$/.test(n) && !/__tests__|\.test\./.test(p) ? [p] : [];
  });
}
const files = [...walk(join(APP, 'reports')), ...walk(join(APP, 'collections'))];
const read = (f: string) => readFileSync(f, 'utf8');

describe('route files exist (done_when: per 04-UI-UX §4; route staff.analytics.collections)', () => {
  it('has the hub, the Collections page, and a page for each of the 11 report codes (static folder or one [param] route)', () => {
    expect(existsSync(join(APP, 'reports', 'page.tsx')), 'reports/page.tsx (hub)').toBe(true);
    expect(existsSync(join(APP, 'collections', 'page.tsx')), 'collections/page.tsx').toBe(true);
    const dyn = existsSync(join(APP, 'reports')) ? readdirSync(join(APP, 'reports')).find((d) => /^\[[A-Za-z_]+\]$/.test(d) && existsSync(join(APP, 'reports', d, 'page.tsx'))) : undefined;
    for (const s of SLUGS) expect(dyn !== undefined || existsSync(join(APP, 'reports', s, 'page.tsx')), `report page ${s}`).toBe(true);
  });

  it('a [param] report route (if used) rejects unknown report codes via notFound() instead of calling the API', () => {
    const dir = existsSync(join(APP, 'reports')) ? readdirSync(join(APP, 'reports')).find((d) => /^\[[A-Za-z_]+\]$/.test(d)) : undefined;
    if (!dir) return; // static folders: nothing to check
    expect(read(join(APP, 'reports', dir, 'page.tsx'))).toMatch(/notFound\(\)/);
  });

  it('collections page sits under staff.analytics.collections: path /analytics/collections (routes.yaml owner C8)', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../../../../../../contracts/routes.yaml', import.meta.url)), 'utf8');
    expect(yaml).toMatch(/id: staff\.analytics\.collections,\s*origin: staff_web,\s*path: \/analytics\/collections,\s*permission: analytics\.collections\.read/);
  });
});

describe.skipIf(files.length === 0)('source rules for the new pages', () => {
  it('imports only react, next/*, @lims/ui/*, @/core/*, @/features/analytics/*, or relative paths (no look-alike kit components, no other libs)', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? m[2]!;
        if (!/^(react|react\/jsx-runtime|server-only|next\/[a-z-]+|@lims\/ui(\/.*)?|@\/core\/.*|@\/features\/analytics\/.*|\.\.?\/.*)$/.test(spec)) bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('never injects HTML (dangerouslySetInnerHTML / innerHTML / outerHTML / insertAdjacentHTML), never evals, never touches web storage', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|\beval\(|new Function\(|localStorage|sessionStorage|document\.cookie/);
  });

  it('keeps the Bearer token server-side: no Authorization/Bearer/access-token handling in files marked \'use client\'', () => {
    for (const f of files.filter((x) => /^\s*['"]use client['"]/.test(read(x)))) {
      const t = read(f);
      expect(t, f).not.toMatch(/authorization|bearer|getAccessToken|serverFetch|server-only/i);
    }
  });

  it('the word "commission" appears nowhere (US-07.3, CI grep)', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/commission/i);
  });

  it('no raw fetch() to /v1/ from the pages (server reads go through serverFetch, i.e. the BFF whitelist)', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/fetch\(\s*[`'"][^`'"]*\/v1\//);
  });
});
