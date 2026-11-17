// RS-C4 static guards (node env). LD-140 + 10-DESIGN-SYSTEM s7/s8: appearance and arrangement only.
//  (1) no raw colour, pixel radius or inline style object remains under this task's four paths;
//  (2) behaviour unchanged: the API client / validation / permission / shortcut / nav files are byte-identical to the pre-restyle baseline,
//      and the permission codes, route strings, server imports and form field names found in the four paths still match the baseline.
// EXCEPTION (arbiter ruling, LD-310 / T0D-REGSCREEN-1): a named allow-list (LD310_ALLOW in rs-c4.signature.ts) permits the feature task's additions only; nothing may be removed.
// Baseline = rs-c4.baseline.json, generated from the tree before the restyle (rs-c4.signature.ts --write). Do not regenerate it to make a test pass.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LD310_ALLOW, OWNED, rawStyleHits, read, rel, routeFiles, signature, logicFiles, web, type Area } from './rs-c4.signature';

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('./rs-c4.baseline.json', import.meta.url)), 'utf8')) as {
  logic: Record<string, string>;
  signatures: Record<Area, ReturnType<typeof signature>>;
  route_files: string[];
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('RS-C4 no raw colour, pixel radius or inline style (10-DESIGN-SYSTEM s6, s7.3; LD-140)', () => {
  it('scanner self-check: it does flag a planted literal', async () => {
    const { scanSource } = await import('./rs-c4.signature');
    // built by concatenation so this file itself stays clean under the T0D-UI-R07 scan
    const planted = ['const a = <div ' + 'sty' + 'le={{ gap: 8 }} />;', 'const b = "color: ' + '#0E4B' + '3B";', 'const c = { border' + 'Radius: 8 };'].join('\n');
    expect(scanSource('x.tsx', planted).map((h) => h.kind).sort()).toEqual(['hex-colour', 'inline-style', 'radius-px']);
    expect(scanSource('x.tsx', 'const a = <div className="lims-card" />;')).toEqual([]);
  });

  it('the four task paths contain no hex/rgb/hsl colour, no px border-radius and no style={{ }} (hits listed by file:line)', () => {
    const hits = rawStyleHits();
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });
});

describe('RS-C4 behaviour unchanged (LD-140: no change to API calls, fields, validation, permissions or routes)', () => {
  it('the baseline covers the files this guard is about (not vacuous)', () => {
    expect(Object.keys(baseline.logic).length).toBeGreaterThanOrEqual(14);
    expect(Object.keys(baseline.logic)).toEqual(expect.arrayContaining([
      'src/features/frontdesk/server/actions.ts', 'src/features/frontdesk/server/write.server.ts', 'src/features/frontdesk/forms/draft.ts',
      'src/features/frontdesk/forms/shortcuts.ts', 'src/features/billing/server/actions.ts', 'src/features/billing/server/read.server.ts',
    ]));
  });

  it('api-client, validation, shortcut-table, nav-manifest and url-filter files: same bytes as before (CRLF-insensitive)', () => {
    const now: Record<string, string> = {};
    for (const f of logicFiles()) now[rel(f)] = sha(read(f));
    expect(Object.keys(now).sort()).toEqual(Object.keys(baseline.logic).sort());
    // LD-310 / T0D-REGSCREEN-1: only the four named frontdesk logic files may differ; every other file stays byte-identical
    const changed = Object.keys(baseline.logic).filter((k) => now[k] !== baseline.logic[k] && !(LD310_ALLOW.logic_files as readonly string[]).includes(k));
    expect(changed).toEqual([]);
  });

  it.each(Object.keys(OWNED) as Area[])('%s: nothing removed from permission codes, routes, imports, symbols or field names; additions limited to the LD-310 allow-list', (area) => {
    const now = signature(area);
    const was = baseline.signatures[area];
    const removed = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
    const added = (a: string[], b: string[]) => b.filter((x) => !a.includes(x));
    expect(removed(was.permissions, now.permissions)).toEqual([]);
    expect(removed(was.server_imports, now.server_imports)).toEqual([]);
    expect(removed(was.server_symbols, now.server_symbols)).toEqual([]);
    expect(removed(was.routes, now.routes)).toEqual([]);
    expect(removed(was.field_names, now.field_names)).toEqual([]);
    expect(added(was.permissions, now.permissions).filter((p) => !(LD310_ALLOW.permissions as readonly string[]).includes(p))).toEqual([]);
    expect(added(was.server_imports, now.server_imports).filter((s) => !(LD310_ALLOW.server_imports as readonly string[]).includes(s))).toEqual([]);
    const extraSymbols = added(was.server_symbols, now.server_symbols).filter((s) => !(LD310_ALLOW.server_symbols as readonly string[]).includes(s));
    expect(extraSymbols.filter((s) => !LD310_ALLOW.trf_symbol.test(s))).toEqual([]); // anything that is not the TRF action is forbidden
    expect(extraSymbols.length).toBeLessThanOrEqual(1); // exactly one TRF action
    expect(added(was.routes, now.routes)).toEqual([]); // no route added: POST credit-parties / doctors / trf-attachments already exist
  });

  it('allow-list guard is not vacuous: an unlisted addition would be rejected', () => {
    expect(LD310_ALLOW.logic_files).toHaveLength(4);
    expect(LD310_ALLOW.logic_files).not.toContain('src/features/frontdesk/forms/draft.ts'); // validation stays pinned
    expect(LD310_ALLOW.permissions).not.toContain('frontdesk.order.cancel');
    expect(LD310_ALLOW.trf_symbol.test('deleteEverythingAction')).toBe(false);
  });

  it('route tree: the same page/route/layout/loading/error files exist (no route added, removed or renamed)', () => {
    expect(routeFiles()).toEqual(baseline.route_files);
  });

  it('the existing registration and billing pages still exist at the same paths', () => {
    for (const p of ['src/app/(staff)/frontdesk/registrations/new/page.tsx', 'src/app/(staff)/billing/daily-cash/page.tsx', 'src/app/(staff)/billing/credit-parties/[credit_party_id]/page.tsx']) {
      expect(existsSync(join(web, p)), p).toBe(true);
    }
  });
});
