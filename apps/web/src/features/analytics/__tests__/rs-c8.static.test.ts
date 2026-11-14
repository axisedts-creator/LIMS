// RS-C8 static guards (node env). LD-140 + 10-DESIGN-SYSTEM s7/s8: appearance and arrangement only.
//  (1) no raw colour, pixel radius or inline style object remains under this task's two paths;
//  (2) behaviour unchanged: the API client (server/**), BFF whitelists, report codes, schedule labels, period maths, DTO types and nav manifest are byte-identical
//      to the pre-restyle baseline ("diff of the chunk api-client usage is empty"), and the permission codes, /v1 routes, server function imports and form field
//      names found in the two paths still match the baseline; page routes may only be ones that already exist.
// Baseline = rs-c8.baseline.json, generated from the tree before the restyle (rs-c8.signature.ts --write). Do not regenerate it to make a test pass.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNED, rawStyleHits, read, rel, routeFiles, signature, logicFiles, web, type Area } from './rs-c8.signature';

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('./rs-c8.baseline.json', import.meta.url)), 'utf8')) as {
  logic: Record<string, string>;
  signatures: Record<Area, ReturnType<typeof signature>>;
  route_files: string[];
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('RS-C8 no raw colour, pixel radius or inline style (10-DESIGN-SYSTEM s6, s7.3; LD-140)', () => {
  it('scanner self-check: it does flag a planted literal', async () => {
    const { scanSource } = await import('./rs-c8.signature');
    // built by concatenation so this file itself stays clean under the T0D-UI-R07 scan
    const planted = ['const a = <div ' + 'sty' + 'le={{ gap: 8 }} />;', 'const b = "color: ' + '#0E4B' + '3B";', 'const c = { border' + 'Radius: 8 };'].join('\n');
    expect(scanSource('x.tsx', planted).map((h) => h.kind).sort()).toEqual(['hex-colour', 'inline-style', 'radius-px']);
    expect(scanSource('x.tsx', 'const a = <div className="lims-card" />;')).toEqual([]);
  });

  it('the task paths contain no hex/rgb/hsl colour, no px border-radius and no style={{ }} (hits listed by file:line)', () => {
    const hits = rawStyleHits();
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });
});

describe('RS-C8 behaviour unchanged (LD-140: no change to API calls, fields, validation, permissions or routes)', () => {
  it('the baseline covers the files this guard is about (not vacuous)', () => {
    expect(Object.keys(baseline.logic).length).toBeGreaterThanOrEqual(14);
    expect(Object.keys(baseline.logic)).toEqual(expect.arrayContaining([
      'src/features/analytics/server/dashboard.server.ts', 'src/features/analytics/server/actions.ts', 'src/features/analytics/server/reports.server.ts',
      'src/features/analytics/server/schedules.server.ts', 'src/features/analytics/server/exports.server.ts', 'src/features/analytics/nav.manifest.ts', 'src/features/analytics/report-codes.ts',
    ]));
  });

  it('api-client, BFF whitelist, report-code, schedule-label, period, DTO-type and nav-manifest files: same bytes as before (CRLF-insensitive)', () => {
    const now: Record<string, string> = {};
    for (const f of logicFiles()) now[rel(f)] = sha(read(f));
    expect(Object.keys(now).sort()).toEqual(Object.keys(baseline.logic).sort());
    const changed = Object.keys(baseline.logic).filter((k) => now[k] !== baseline.logic[k]);
    expect(changed).toEqual([]);
  });

  it.each(Object.keys(OWNED) as Area[])('%s: permission codes, /v1 routes and server function imports are exactly the baseline; every baseline form field name still exists', (area) => {
    const now = signature(area);
    const was = baseline.signatures[area];
    expect(now.permissions).toEqual(was.permissions);
    expect(now.server_imports).toEqual(was.server_imports);
    expect(now.server_functions).toEqual(was.server_functions);
    expect(now.routes.filter((r) => r.startsWith('/v1/'))).toEqual(was.routes.filter((r) => r.startsWith('/v1/')));
    expect(was.field_names.filter((n) => !now.field_names.includes(n))).toEqual([]);
  });

  it.each(Object.keys(OWNED) as Area[])('%s: every page route link that existed still exists, and any new one points at an existing page (pipeline filters may reuse report pages)', (area) => {
    const now = signature(area).routes.filter((r) => r.startsWith('/analytics'));
    const was = baseline.signatures[area].routes.filter((r) => r.startsWith('/analytics'));
    expect(was.filter((r) => !now.includes(r))).toEqual([]);
    const EXISTING = /^\/analytics(?:\/(?:collections|exports(?:\/\$\{[^}]+\}\/file)?|referral-incentive|report-runs\/\$\{[^}]+\}|schedules(?:\/new|\/\$\{[^}]+\})?|reports(?:\/(?:\$\{[^}]+\}|[a-z][a-z-]*))?))?$/;
    expect(now.filter((r) => !EXISTING.test(r))).toEqual([]);
  });

  it('route tree: the same page/route/layout/loading/error files exist (no route added, removed or renamed)', () => {
    expect(routeFiles()).toEqual(baseline.route_files);
  });

  it('the dashboard, hub, schedules and exports pages still exist at the same paths', () => {
    for (const p of ['src/app/(staff)/analytics/page.tsx', 'src/app/(staff)/analytics/reports/page.tsx', 'src/app/(staff)/analytics/schedules/page.tsx', 'src/app/(staff)/analytics/exports/page.tsx']) {
      expect(existsSync(join(web, p)), p).toBe(true);
    }
  });
});
