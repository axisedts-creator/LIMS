// C5 T-10 — static source scans (no render). done_when: "page calls neither #15 nor #47; #14a writes nothing / no key; needs CR-C5-007 route"; 07-SECURITY S-09 (no barcode / registration_no in URLs), REQ-SEC-068 (BFF only).
// Files: apps/web/src/app/(staff)/lab/orders/[order_id]/labels/**, apps/web/src/features/lab/components/labels/**, apps/web/src/features/lab/server/printSpecimenLabels.server.ts.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const web = fileURLToPath(new URL('../../../../', import.meta.url)); // apps/web/
const PAGE_DIR = join(web, 'src', 'app', '(staff)', 'lab', 'orders', '[order_id]', 'labels');
const COMP_DIR = join(web, 'src', 'features', 'lab', 'components', 'labels');
const SERVER = join(web, 'src', 'features', 'lab', 'server', 'printSpecimenLabels.server.ts');
const walk = (d: string): string[] => (!existsSync(d) ? [] : readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; }));
const sources = [...walk(PAGE_DIR), ...walk(COMP_DIR), SERVER].filter((f) => /\.(ts|tsx)$/.test(f) && !/__tests__|\.test\./.test(f));
const read = (f: string) => readFileSync(f, 'utf8');
const all = () => sources.filter(existsSync).map((f) => [f, read(f)] as const);

describe('files exist (06 row T-10)', () => {
  it('route page + loading/error states, LabelRenderer, LabelPage and the server module are present', () => {
    for (const f of [join(PAGE_DIR, 'page.tsx'), join(COMP_DIR, 'LabelRenderer.ts'), join(COMP_DIR, 'LabelPage.tsx'), SERVER]) expect(existsSync(f), f).toBe(true);
  });
});

describe('08 A13 D-4 — the page needs only #14a and #14', () => {
  it('never references getLabOrder (#15), getLabSettings (#47), /v1/lab/settings or any other lab path than label-prints and specimens/labels', () => {
    expect(all().length).toBeGreaterThan(0);
    for (const [f, src] of all()) {
      expect(src, f).not.toMatch(/getLabOrder|getLabSettings|\/v1\/lab\/settings/);
      for (const m of src.matchAll(/\/v1\/lab\/[^'"`\s]*/g)) expect(m[0], `${f}: ${m[0]}`).toMatch(/^\/v1\/lab\/(orders\/\$\{[^}]+\}\/label-prints|specimens\/labels)$/);
    }
  });

  it('the server module is server-only, wraps both operations through serverFetch (bearer stays server-side), and sends NO Idempotency-Key (#14a: none; #14 is counted per print)', () => {
    const src = read(SERVER);
    expect(src).toMatch(/^\s*import\s+['"]server-only['"]/m);
    expect(src).toMatch(/serverFetch/);
    expect(src).toMatch(/label-prints/);
    expect(src).toMatch(/specimens\/labels/);
    expect(src).not.toMatch(/idempotency/i);
    expect(src).toMatch(/export\s+(async\s+)?(function|const)\s+requestOrderLabelPrint/);
    expect(src).toMatch(/export\s+(async\s+)?(function|const)\s+printSpecimenLabels/);
    expect(src).toMatch(/UUID|uuid/);                                        // order id validated before it reaches a path (no path injection)
  });

  it('S-09: no barcode / registration_no in a URL or query string', () => {
    for (const [f, src] of all()) expect(src, f).not.toMatch(/[?&](barcode|registration_no)=|\/(barcode|registration)[-_]?no?\//i);
  });
});

describe('page wiring', () => {
  it('the route page reads LIMS_LAB_LABEL_WAIT_SECONDS (default 15) server-side and gates on lab.specimen.label_print', () => {
    const src = read(join(PAGE_DIR, 'page.tsx'));
    expect(src).toMatch(/LIMS_LAB_LABEL_WAIT_SECONDS/);
    expect(src).toMatch(/\b15\b/);
    expect(src).toMatch(/lab\.specimen\.label_print/);
  });
  it('the label renderer uses the kit BarcodeSymbol (Code 128, C0-0D) and the label page calls window.print()', () => {
    expect(read(join(COMP_DIR, 'LabelRenderer.ts'))).toMatch(/BarcodeSymbol/);
    expect(read(join(COMP_DIR, 'LabelPage.tsx'))).toMatch(/window\.print\(\)/);
  });
  it('no raw HTML injection of API fields in the page component (dangerouslySetInnerHTML only for the renderer output)', () => {
    const src = read(join(COMP_DIR, 'LabelPage.tsx'));
    expect(src.match(/dangerouslySetInnerHTML/g)?.length ?? 0).toBeLessThanOrEqual(2); // renderer output (print region) [+ style]
  });
});
