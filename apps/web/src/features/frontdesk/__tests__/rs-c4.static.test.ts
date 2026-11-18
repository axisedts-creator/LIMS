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
    // LD-391/LD-393 follow-up, T0D-OFFLINE-3 arbiter: forgive only the named added accounting logic files; a real removal still fails below
    const addedOk = LD310_ALLOW.logic_files_added as readonly string[];
    expect(Object.keys(now).filter((k) => !(addedOk.includes(k) && !(k in baseline.logic))).sort()).toEqual(Object.keys(baseline.logic).sort());
    expect(Object.keys(baseline.logic).filter((k) => !(k in now))).toEqual([]);
    // LD-310 / T0D-REGSCREEN-1: only the four named frontdesk logic files may differ; every other file stays byte-identical
    const changed = Object.keys(baseline.logic).filter((k) => now[k] !== baseline.logic[k] && !(LD310_ALLOW.logic_files as readonly string[]).includes(k) && !(LD310_ALLOW.logic_files_changed as readonly string[]).includes(k));
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
    // T0D-UNSLOP-1 (D), ruling T0D-UNSLOP-1-ruling.md: "/billing/credit-parties" in billing_feature was only the href of the removed in-page CreditPartyDetail crumb (one trail, in the top bar);
    // the page route itself is still pinned by the "existing pages still exist" test below. Nothing else may be removed.
    // LD-398 (T0D-OFFLINE-3): "/v1/catalog/tests" moved into billing_feature's own code (already an allowed addition there); only a test-harness mock in frontdesk still mentions it, which this guard does not scan.
    const CRUMB_ONLY: Partial<Record<Area, string[]>> = { billing_feature: ['/billing/credit-parties'], frontdesk_feature: ['/v1/catalog/tests'] };
    expect(removed(was.routes, now.routes).filter((r) => !(CRUMB_ONLY[area] ?? []).includes(r))).toEqual([]);
    expect(removed(was.field_names, now.field_names)).toEqual([]);
    expect(added(was.permissions, now.permissions).filter((p) => !(LD310_ALLOW.permissions as readonly string[]).includes(p) && !LD310_ALLOW.billing_accounts_strings.test(p))).toEqual([]);
    expect(added(was.server_imports, now.server_imports).filter((s) => !(LD310_ALLOW.server_imports as readonly string[]).includes(s))).toEqual([]);
    // LD-391/LD-393 follow-up, T0D-OFFLINE-3 arbiter: accounting server symbols are excluded before the trf_symbol and length checks
    // LD-403, T0D-OFFLINE-3: regscreen2_symbols excluded the same way accounts_symbols already is
    const extraSymbols = added(was.server_symbols, now.server_symbols).filter((s) => !(LD310_ALLOW.server_symbols as readonly string[]).includes(s) && !(LD310_ALLOW.accounts_symbols as readonly string[]).includes(s) && !(LD310_ALLOW.regscreen2_symbols as readonly string[]).includes(s));
    expect(extraSymbols.filter((s) => !LD310_ALLOW.trf_symbol.test(s))).toEqual([]); // anything that is not the TRF action is forbidden
    expect(extraSymbols.length).toBeLessThanOrEqual(1); // exactly one TRF action
    // LD-391/LD-393 follow-up, T0D-OFFLINE-3 arbiter: only the named route string is forgiven
    expect(added(was.routes, now.routes).filter((r) => !LD310_ALLOW.route_strings_added.test(r))) /* LD-400, T0D-OFFLINE-3 arbiter */.toEqual([]); // no route added: POST credit-parties / doctors / trf-attachments already exist
  });

  it('allow-list guard is not vacuous: an unlisted addition would be rejected', () => {
    expect(LD310_ALLOW.logic_files).toHaveLength(4);
    expect(LD310_ALLOW.routes_added).toHaveLength(8);
    expect(LD310_ALLOW.logic_files).not.toContain('src/features/frontdesk/forms/draft.ts'); // validation stays pinned
    expect(LD310_ALLOW.permissions).not.toContain('frontdesk.order.cancel');
    expect(LD310_ALLOW.trf_symbol.test('deleteEverythingAction')).toBe(false);
    expect(LD310_ALLOW.billing_accounts_strings.test('frontdesk.order.cancel')).toBe(false);
    // LD-391/LD-393 follow-up, T0D-OFFLINE-3 arbiter
    expect(LD310_ALLOW.logic_files_added).toHaveLength(4);
    // LD-400, T0D-OFFLINE-3 arbiter
    expect(LD310_ALLOW.route_strings_added.test('/v1/billing/accounts/summary')).toBe(true);
    expect(LD310_ALLOW.route_strings_added.test('/v1/frontdesk/patients')).toBe(false);
    expect(LD310_ALLOW.accounts_symbols).toHaveLength(64); // LD-398: 19 + 45
    expect(LD310_ALLOW.logic_files_changed).toHaveLength(6);
    expect(LD310_ALLOW.accounts_symbols).not.toContain('deleteEverythingAction');
    expect(LD310_ALLOW.regscreen2_symbols).toHaveLength(32); // LD-403 (arbiter correction: the lead's 31 was a miscount)
    expect(LD310_ALLOW.regscreen2_symbols).not.toContain('deleteEverythingAction');
  });

  it('route tree: the same page/route/layout/loading/error files exist (no route added, removed or renamed)', () => {
    const now = routeFiles();
    const allowed = LD310_ALLOW.routes_added as readonly string[];
    // LD-391: only the named additions are forgiven; any other added route fails here
    expect(now.filter((f) => !(allowed.includes(f) && !baseline.route_files.includes(f)))).toEqual(baseline.route_files);
    // a real removal or rename of an existing route still fails
    expect(baseline.route_files.filter((f) => !now.includes(f))).toEqual([]);
  });

  it('the existing registration and billing pages still exist at the same paths', () => {
    for (const p of ['src/app/(staff)/frontdesk/registrations/new/page.tsx', 'src/app/(staff)/billing/daily-cash/page.tsx', 'src/app/(staff)/billing/credit-parties/[credit_party_id]/page.tsx']) {
      expect(existsSync(join(web, p)), p).toBe(true);
    }
  });
});
