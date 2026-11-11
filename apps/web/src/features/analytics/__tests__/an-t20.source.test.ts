// AN-T20 — source-level done_when / security rules for apps/web/src/app/(staff)/analytics/{referral-incentive,exports,schedules,report-runs}/**
// (04-UI-UX §5–§9, TRD §2 tree, REQ-SEC-088/089 text nodes only, US-07.3 no "commission", no client-side token/storage, kit-only components).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../../../app/(staff)/analytics/', import.meta.url));
const FEATURE = fileURLToPath(new URL('../', import.meta.url));
const DIRS = ['referral-incentive', 'exports', 'schedules', 'report-runs'];

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) ? [p] : [];
  });
}
const files = DIRS.flatMap((d) => walk(join(APP, d)));
const read = (f: string) => readFileSync(f, 'utf8');
const isRoute = (f: string) => /[\\/]route\.ts$/.test(f);

describe('route files exist (TRD §2 tree; routes.yaml staff.analytics.*)', () => {
  it.each([
    ['referral-incentive', 'page.tsx'], ['referral-incentive', 'loading.tsx'], ['referral-incentive', 'error.tsx'],
    ['exports', 'page.tsx'], ['exports', 'loading.tsx'], ['exports', 'error.tsx'], ['exports', '[export_id]/file/route.ts'],
    ['schedules', 'page.tsx'], ['schedules', 'new/page.tsx'], ['schedules', '[schedule_id]/page.tsx'], ['schedules', 'loading.tsx'], ['schedules', 'error.tsx'],
    ['report-runs', '[report_run_id]/page.tsx'], ['report-runs', '[report_run_id]/error.tsx'],
  ])('%s/%s', (d, f) => {
    expect(existsSync(join(APP, d, ...f.split('/'))), `${d}/${f}`).toBe(true);
  });

  it('routes.yaml still maps the four paths to staff.analytics.* with the permissions the pages check', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../../../../../../contracts/routes.yaml', import.meta.url)), 'utf8');
    expect(yaml).toMatch(/id: staff\.analytics\.referral_incentive,\s*origin: staff_web,\s*path: \/analytics\/referral-incentive,\s*permission: analytics\.referral_report\.read/);
    expect(yaml).toMatch(/id: staff\.analytics\.exports,\s*origin: staff_web,\s*path: \/analytics\/exports,\s*permission: analytics\.data\.export/);
    expect(yaml).toMatch(/id: staff\.analytics\.schedules,\s*origin: staff_web,\s*path: \/analytics\/schedules,\s*permission: analytics\.schedule\.manage/);
    expect(yaml).toMatch(/id: staff\.analytics\.report_run,\s*origin: staff_web,\s*path: "\/analytics\/report-runs\/\{report_run_id\}",\s*permission: analytics\.dashboard\.read/);
  });
});

describe.skipIf(files.length === 0)('source rules', () => {
  it('imports only react, next/*, @lims/ui/*, @/core/*, @/features/analytics/*, server-only or relative paths (no look-alike kit components, no other libs)', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? m[2]!;
        if (!/^(react|react\/jsx-runtime|server-only|next\/[a-z-]+|@lims\/ui(\/.*)?|@\/core\/.*|@\/features\/analytics\/.*|\.\.?\/.*)$/.test(spec)) bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("page.tsx and route.ts are server code (no 'use client'); error.tsx is a client component", () => {
    for (const f of files.filter((x) => /[\\/](page\.tsx|route\.ts)$/.test(x))) expect(read(f), f).not.toMatch(/^\s*['"]use client['"]/m);
    for (const f of files.filter((x) => /[\\/]error\.tsx$/.test(x))) expect(read(f), f).toMatch(/^\s*['"]use client['"]/m);
  });

  it('no dangerouslySetInnerHTML / innerHTML / outerHTML / document.write (REQ-SEC-088/089)', () => {
    for (const f of files) expect(read(f), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  });

  it('no browser storage, cookies, blob URLs or in-memory file handling (§7: download is a plain <a>)', () => {
    for (const f of files) {
      const s = read(f);
      expect(s, f).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
      expect(s, f).not.toMatch(/createObjectURL|revokeObjectURL|blob:|new Blob\(/);
    }
  });

  it('pages never touch the bearer token; only the download route handler reads it (REQ-SEC-068)', () => {
    for (const f of files.filter((x) => !isRoute(x))) expect(read(f), f).not.toMatch(/\bBearer\b|authorization|getAccessToken|NEXT_PUBLIC_/i);
    for (const f of files.filter(isRoute)) expect(read(f), f).not.toMatch(/NEXT_PUBLIC_|console\.(log|info|debug)/);
  });

  it('the download route never redirects to or exposes a storage URL and never follows redirects', () => {
    for (const f of files.filter(isRoute)) {
      const s = read(f);
      expect(s, f).not.toMatch(/redirect\(|NextResponse\.redirect|Response\.redirect|signedUrl|presign/i);
      expect(s, f).toMatch(/redirect:\s*['"]error['"]|serverFetch/);
    }
  });
});

describe('US-07.3: the word "commission" appears nowhere in C8 web paths (CI grep, case-insensitive)', () => {
  it('app/(staff)/analytics/** and features/analytics/** (tests excluded)', () => {
    const all = [...walk(APP), ...walk(FEATURE)].filter((f) => !/__tests__/.test(f));
    expect(all.length).toBeGreaterThan(0);
    const hits = all.filter((f) => /commission/i.test(read(f)));
    expect(hits).toEqual([]);
  });
});
