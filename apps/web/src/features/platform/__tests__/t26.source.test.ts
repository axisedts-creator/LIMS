// C2.T26 — source-level done_when / security rules for apps/web/src/app/(platform)/** and apps/web/src/features/platform/**
// (04-UI-UX §1 route table, §7 platform screens, REQ-SEC-088/089 text nodes only, REQ-SEC-068 no client-side token, kit-only components, 04-UI-UX §3 nav manifest).
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_GROUP = fileURLToPath(new URL('../../../app/(platform)/', import.meta.url));
const APP = join(APP_GROUP, 'platform');
const FEATURE = fileURLToPath(new URL('../', import.meta.url));

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? (n === '__tests__' ? [] : walk(p)) : /\.(ts|tsx)$/.test(n) && !/\.test\./.test(n) && !/vitest\./.test(n) ? [p] : [];
  });
}
const files = [...walk(APP_GROUP), ...walk(FEATURE)];
const read = (f: string) => readFileSync(f, 'utf8');

describe('route files exist (04-UI-UX §1: PL-1..PL-8; CR-C2-001 puts them under the (platform) group)', () => {
  it.each([
    ['layout.tsx', true], ['platform/page.tsx', false], ['platform/loading.tsx', false], ['platform/error.tsx', false],
    ['platform/tenants/page.tsx', false], ['platform/tenants/new/page.tsx', false], ['platform/tenants/[tenant_id]/page.tsx', false],
    ['platform/ird/page.tsx', false], ['platform/support-sessions/page.tsx', false],
    ['platform/dead-letters/page.tsx', false], ['platform/dead-letters/[dead_letter_id]/page.tsx', false],
    ['platform/staff/page.tsx', false], ['platform/auth-events/page.tsx', false],
  ])('%s', (f) => {
    expect(existsSync(join(APP_GROUP, ...f.split('/'))), f).toBe(true);
  });

  it('there is no (staff)/platform route (CR-C2-001 removed it) — the platform console lives only in the (platform) group', () => {
    expect(existsSync(fileURLToPath(new URL('../../../app/(staff)/platform', import.meta.url)))).toBe(false);
  });

  it('routes.yaml keeps the two platform detail routes with the permissions the pages check', () => {
    const yaml = readFileSync(fileURLToPath(new URL('../../../../../../contracts/routes.yaml', import.meta.url)), 'utf8');
    expect(yaml).toMatch(/id: staff\.platform\.tenant,\s*origin: staff_web,\s*path: "\/platform\/tenants\/\{tenant_id\}",\s*owner: C2,\s*permission: platform\.tenant\.read/);
    expect(yaml).toMatch(/id: staff\.platform\.dead_letter,\s*origin: staff_web,\s*path: "\/platform\/dead-letters\/\{dead_letter_id\}",\s*owner: C2,\s*permission: platform\.dead_letter\.manage/);
  });
});

describe('nav manifest (04-UI-UX §1): features/platform/nav.manifest.ts, used only by the (platform) layout', () => {
  const manifest = join(FEATURE, 'nav.manifest.ts');
  it('exists, module "platform", group "platform", one entry per list screen with the permission from the route table', () => {
    expect(existsSync(manifest), 'features/platform/nav.manifest.ts').toBe(true);
    const src = read(manifest);
    expect(src).toMatch(/module:\s*'platform'/);
    expect(src.match(/group:\s*'platform'/g)?.length ?? 0).toBeGreaterThanOrEqual(7); // PL-1, PL-2, PL-4..PL-8 (PL-3 is a detail page, not a nav entry)
    for (const perm of ['platform.tenant.read', 'platform.dead_letter.manage', 'platform.staff.manage']) expect(src).toContain(perm);
  });
});

describe.skipIf(files.length === 0)('source rules', () => {
  it('imports only react, next/*, @lims/ui/*, @/core/*, @/features/platform/*, server-only or relative paths (no look-alike kit components, no other libs)', () => {
    const bad: string[] = [];
    for (const f of files) {
      for (const m of read(f).matchAll(/(?:^|\n)\s*import\s[^'"]*?from\s+['"]([^'"]+)['"]|(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1] ?? m[2]!;
        if (!/^(react|react\/jsx-runtime|server-only|next\/[a-z-]+|@lims\/ui(\/.*)?|@\/core\/.*|@\/features\/platform\/.*|\.\.?\/.*)$/.test(spec)) bad.push(`${f}: ${spec}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('no dangerouslySetInnerHTML, innerHTML, eval or new Function (REQ-SEC-088/089: values render as text nodes)', () => {
    const bad = files.filter((f) => /dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('no browser-side token or storage use: no localStorage/sessionStorage/document.cookie, no supabase, no JWT literal (REQ-SEC-068)', () => {
    const bad = files.filter((f) => /localStorage|sessionStorage|document\.cookie|@supabase|eyJ[A-Za-z0-9_-]{8,}\./.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('client components never import server-only modules or the server fetch client (the bearer token must not reach the browser)', () => {
    const bad = files.filter((f) => /^\s*['"]use client['"]/m.test(read(f)) && /@\/core\/api\/server-fetch|@\/core\/session\/server|server-only/.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('API calls target /v1/identity/platform/* only (no tenant endpoints from the platform console, no raw fetch to other origins)', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = read(f);
      for (const m of src.matchAll(/['"`](\/v1\/[^'"`?$]*)/g)) if (!m[1]!.startsWith('/v1/identity/platform')) offenders.push(`${f}: ${m[1]}`);
      if (/\bfetch\(\s*['"`]https?:/.test(src)) offenders.push(`${f}: absolute fetch`);
    }
    expect(offenders).toEqual([]);
  });

  it('copy: no legal text about the Annexes beyond the tracking banner (AC-E3.5) — no "legally", "compliant", "certified"', () => {
    const bad = files.filter((f) => /\b(legally|compliant|compliance with|certified)\b/i.test(read(f)));
    expect(bad).toEqual([]);
  });

  it('no job payload is ever rendered or requested for dead letters (08 A8.5) — no `job_payload` reference', () => {
    expect(files.filter((f) => /job_payload|jobPayload/.test(read(f)))).toEqual([]);
  });

  it('every page.tsx is a server component (no "use client") and every route folder has an error boundary or inherits platform/error.tsx', () => {
    const pages = files.filter((f) => /[\\/]page\.tsx$/.test(f));
    expect(pages.length).toBeGreaterThanOrEqual(10);
    expect(pages.filter((f) => /^\s*['"]use client['"]/m.test(read(f)))).toEqual([]);
    expect(existsSync(join(APP, 'error.tsx'))).toBe(true);
  });
});
