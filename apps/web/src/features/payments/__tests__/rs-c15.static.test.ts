// RS-C15 static guards (node env). LD-140 + 10-DESIGN-SYSTEM s7/s8: appearance and arrangement only.
//  (1) no raw colour, pixel radius or inline style object remains under this task's two paths;
//  (2) behaviour unchanged: the API client / validation / query / error files are byte-identical to the pre-restyle baseline, and the permission codes,
//      route strings, server imports and form field names found in the two paths still match the baseline ("diff of the chunk api-client usage is empty").
// Baseline = rs-c15.baseline.json, generated from the tree before the restyle (rs-c15.signature.ts --write). Do not regenerate it to make a test pass.
import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { OWNED, rawStyleHits, read, rel, routeFiles, signature, logicFiles, web, type Area } from './rs-c15.signature';

const baseline = JSON.parse(readFileSync(fileURLToPath(new URL('./rs-c15.baseline.json', import.meta.url)), 'utf8')) as {
  logic: Record<string, string>;
  signatures: Record<Area, ReturnType<typeof signature>>;
  route_files: string[];
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

describe('RS-C15 no raw colour, pixel radius or inline style (10-DESIGN-SYSTEM s6, s7.3; LD-140)', () => {
  it('scanner self-check: it does flag a planted literal', async () => {
    const { scanSource } = await import('./rs-c15.signature');
    // built by concatenation so this file itself stays clean under the T0D-UI-R07 scan
    const planted = ['const a = <div ' + 'sty' + 'le={{ gap: 8 }} />;', 'const b = "color: ' + '#0E4B' + '3B";', 'const c = { border' + 'Radius: 8 };'].join('\n');
    expect(scanSource('x.tsx', planted).map((h) => h.kind).sort()).toEqual(['hex-colour', 'inline-style', 'radius-px']);
    expect(scanSource('x.tsx', 'const a = <div className="lims-card" />;')).toEqual([]);
  });

  it('the two task paths contain no hex/rgb/hsl colour, no px border-radius and no style={{ }} (hits listed by file:line)', () => {
    const hits = rawStyleHits();
    expect(hits.map((h) => `${h.file}:${h.line} ${h.kind} ${h.text}`)).toEqual([]);
  });
});

describe('RS-C15 behaviour unchanged (LD-140: no change to API calls, fields, validation, permissions or routes)', () => {
  it('the baseline covers the files this guard is about (not vacuous)', () => {
    expect(Object.keys(baseline.logic)).toEqual(expect.arrayContaining([
      'src/features/payments/server/actions.ts', 'src/features/payments/server/read.server.ts', 'src/features/payments/server/write.server.ts',
      'src/features/payments/query.ts', 'src/features/payments/types.ts', 'src/features/payments/errors.ts',
    ]));
    expect(baseline.signatures.payments_feature.permissions).toContain('payments.intent.resolve');
    expect(baseline.route_files.length).toBeGreaterThanOrEqual(15);
  });

  it('api-client, validation, query-whitelist, error-map and DTO-type files: same bytes as before (CRLF-insensitive)', () => {
    const now: Record<string, string> = {};
    for (const f of logicFiles()) now[rel(f)] = sha(read(f));
    expect(Object.keys(now).sort()).toEqual(Object.keys(baseline.logic).sort());
    const changed = Object.keys(baseline.logic).filter((k) => now[k] !== baseline.logic[k]);
    expect(changed).toEqual([]);
  });

  it.each(Object.keys(OWNED) as Area[])('%s: permission codes, /v1 + page routes and server imports are exactly the baseline; every baseline form field name still exists', (area) => {
    const now = signature(area);
    const was = baseline.signatures[area];
    expect(now.permissions).toEqual(was.permissions);
    expect(now.server_imports).toEqual(was.server_imports);
    expect(now.server_symbols).toEqual(was.server_symbols);
    expect(now.routes).toEqual(was.routes);
    expect(was.field_names.filter((n) => !now.field_names.includes(n))).toEqual([]);
  });

  it('route tree: the same page/route/layout/loading/error files exist (no route added, removed or renamed)', () => {
    expect(routeFiles()).toEqual(baseline.route_files);
  });

  it('the six staff payment pages still exist at the same paths', () => {
    for (const s of ['review', 'reconciliation', 'refunds', 'settings', 'static-qr', 'intents/[intent_id]']) {
      expect(existsSync(join(web, `src/app/(staff)/payments/${s}/page.tsx`)), s).toBe(true);
    }
  });
});
