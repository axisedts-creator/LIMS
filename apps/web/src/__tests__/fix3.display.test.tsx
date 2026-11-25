// @vitest-environment jsdom
// T0D-FIX-3 (LD-446, CR DEPLOY-AXIS-012 items 7a, 7b, the Dues chart colour, the DataTable cell crash).
//  7a  Billing > Dues: the PAGE passes the centre list, every row shows the centre NAME (an unknown centre shows a dash, never the id; 07-SECURITY).
//  7b  Reports worklist: the Centre cell shows the centre name resolved from the centre list, not the code the report DTO carries (DM-BKT, SYN-A1).
//  chart  the Dues by age bar takes the first colour of the chart palette, not the inherited near-black.
//  crash  an undefined list prop renders the empty state instead of "TypeError: Cannot read properties of undefined (reading 'map')"
//         (Broadcasts in engagement, SalesTable in partners/SalesCommon); a broadcast without audience_filter.party_kinds does not crash its row.
// Fixtures are synthetic and in CONTRACT shape (identity Centre = centre_id, code, name, kind, is_active, version).
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ToastProvider } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import { ADMIN, ORDER, REPORT, summary } from '@/features/reporting/__tests__/c6-t31.fixtures';

const push = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/billing/dues',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
  redirect: (to: string) => { throw new Error(`NEXT_REDIRECT ${to}`); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: [...ADMIN, 'billing.due.read', 'billing.invoice.read'], displayName: 'Synthetic Finance', membershipId: '01950c12-0000-7000-8000-000000000900', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/billing/dues',
}));
const stub = vi.hoisted(() => () => new Proxy({}, { get: (_t, k) => (k === 'then' || k === '__esModule' || typeof k === 'symbol' ? undefined : async () => ({ ok: true })) }));
vi.mock('@/features/engagement/server/broadcastActions', stub);

const A = '01950c16-0000-7000-8000-000000000001';
const B = '01950c16-0000-7000-8000-000000000002';
const GONE = '01950c16-0000-7000-8000-0000000000ff';
const CENTRES = [
  { centre_id: A, code: 'SYN-A1', name: 'Synthetic Centre A1', branch_id: '01950c16-0000-7000-8000-0000000000b1', kind: 'own', is_active: true, version: 1 },
  { centre_id: B, code: 'SYN-B2', name: 'Synthetic Centre B2', branch_id: '01950c16-0000-7000-8000-0000000000b1', kind: 'own', is_active: true, version: 1 },
];
const npr = (paisa: number) => ({ amount_paisa: paisa, currency: 'NPR' });
const due = (n: number, centre: string) => ({ order_id: `01a1a98a-ac40-7000-8000-${String(500 + n).padStart(12, '0')}`, registration_no: `REG-9${String(n).padStart(5, '0')}`, patient_display: `S*** B${n}`, centre_id: centre,
  invoiced: npr(113000), paid: npr(50000), credited: npr(0), balance_due: npr(63000), oldest_invoice_at: '2026-10-01T04:00:00.000Z' });

const { seen } = vi.hoisted(() => ({ seen: [] as string[] }));
vi.mock('@/core/api/server-fetch', () => {
  class ApiError extends Error {
    constructor(readonly status: number, readonly problem: { code: string; status: number; title: string }) { super(`${problem.code} (${status})`); }
  }
  const serverFetch = async (target: string) => {
    seen.push(target);
    const [path = '', query = ''] = target.split('?');
    // the API rejects a limit on the centre list (contract has none): the web must not send it
    if (path === '/v1/identity/centres') {
      if (/(^|&)limit=/.test(query)) throw new ApiError(400, { code: 'common.validation_failed', status: 400, title: 'limit not allowed' });
      return { data: (globalThis as any).__FIX3_CENTRES ?? [] };
    }
    if (path === '/v1/billing/dues') return { data: (globalThis as any).__FIX3_DUES ?? [], page: { limit: 100 } };
    if (path === '/v1/reporting/reports') return { data: (globalThis as any).__FIX3_REPORTS ?? [], page: { limit: 50 } };
    return { data: [], page: { limit: 50 } };
  };
  return { ApiError, serverFetch };
});
const set = (k: string, v: unknown) => { (globalThis as any)[k] = v; };
afterEach(() => { cleanup(); seen.length = 0; set('__FIX3_CENTRES', undefined); set('__FIX3_DUES', undefined); set('__FIX3_REPORTS', undefined); });

const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const rowOf = (root: HTMLElement, text: string) => {
  const el = [...root.querySelectorAll('a, td, th, [role="gridcell"], [role="rowheader"]')].find((e) => norm(e.textContent) === text);
  const row = el?.closest('tr, [role="row"]') as HTMLElement | null;
  expect(row, `a table row holding "${text}"`).toBeTruthy();
  return row!;
};
const props = { searchParams: Promise.resolve({}), params: Promise.resolve({}) } as never;

describe('7a Billing > Dues passes the centre list (page -> DuesList)', () => {
  const show = async () => {
    const mod = await import('../app/(staff)/billing/dues/page');
    return render(<ToastProvider>{await (mod.default as unknown as (p: never) => Promise<never>)(props)}</ToastProvider>);
  };
  it('every row shows the centre name; the centre id is never rendered; an unknown centre is a dash', async () => {
    set('__FIX3_CENTRES', CENTRES);
    set('__FIX3_DUES', [due(1, A), due(2, B), due(3, GONE)]);
    const { container } = await show();
    expect(norm(rowOf(container, 'REG-900001').textContent)).toContain('Synthetic Centre A1');
    expect(norm(rowOf(container, 'REG-900002').textContent)).toContain('Synthetic Centre B2');
    const unknown = norm(rowOf(container, 'REG-900003').textContent);
    expect(unknown).toContain('—');
    expect(container.textContent).not.toContain(GONE);
    expect(seen.filter((p) => /identity\/centres/.test(p)).every((p) => !/limit/.test(p))).toBe(true);
  });
  it('a centre list that cannot be read does not break the page (rows stay, centre cells are dashes)', async () => {
    set('__FIX3_DUES', [due(1, A)]);
    set('__FIX3_CENTRES', undefined);
    const { container } = await show();
    expect(norm(rowOf(container, 'REG-900001').textContent)).toContain('—');
  });
});

describe('7b Reports worklist shows centre names, not codes', () => {
  const show = async () => {
    const mod = await import('../app/(staff)/reporting/page');
    return render(<ToastProvider>{await (mod.default as unknown as (p: never) => Promise<never>)(props)}</ToastProvider>);
  };
  it('Centre cell = name resolved from the centre list; the code SYN-A1 is not printed', async () => {
    set('__FIX3_CENTRES', CENTRES);
    set('__FIX3_REPORTS', [
      summary({ id: REPORT, order_id: ORDER, registration_no: 'R2611050001', centre_id: A, centre_code: 'SYN-A1' }),
      summary({ id: '01a1a98a-ac40-7000-8000-000000000099', registration_no: 'R2611050002', centre_id: B, centre_code: 'SYN-B2' }),
    ]);
    const { container } = await show();
    const r1 = norm(rowOf(container, 'R2611050001').textContent);
    const r2 = norm(rowOf(container, 'R2611050002').textContent);
    expect(r1).toContain('Synthetic Centre A1');
    expect(r1).not.toContain('SYN-A1');
    expect(r2).toContain('Synthetic Centre B2');
    expect(r2).not.toContain('SYN-B2');
  });
  it('a centre missing from the list falls back to the code the report carries (never blank)', async () => {
    set('__FIX3_CENTRES', CENTRES);
    set('__FIX3_REPORTS', [summary({ registration_no: 'R2611050003', centre_id: GONE, centre_code: 'OLD-9' })]);
    const { container } = await show();
    expect(norm(rowOf(container, 'R2611050003').textContent)).toContain('OLD-9');
  });
});

describe('Dues by age: the bar takes the first colour of the chart palette (not near-black)', () => {
  const root = resolve(process.cwd(), '..', '..'); // vitest runs with root = apps/web (verify.cmd uses pnpm --dir apps/web)
  const css: { f: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (!['node_modules', '.next', '__tests__'].includes(n)) walk(p); }
      else if (n.endsWith('.css')) css.push({ f: p, text: readFileSync(p, 'utf8') });
    }
  };
  walk(join(root, 'packages', 'ui', 'src'));
  walk(join(root, 'apps', 'web', 'src'));
  /** colour/fill declarations of rules that style the FIRST series or every plain bar (not the `:has` / data-current accents). */
  const plain = (sel: string) => ['.lims-series-0', '.lims-chart-bar', '.lims-chart-bar.lims-series-0', '.lims-chart-svg .lims-series-0', '.lims-chart-svg .lims-chart-bar'].includes(sel.replace(/\s+/g, ' ').trim());
  const decls = css.flatMap(({ text }) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((m) => m[1]!.split(',').filter((s) => plain(s))
    .flatMap(() => [...m[2]!.matchAll(/(?:^|;)\s*(color|fill)\s*:\s*([^;]+)/g)].map((d) => d[2]!.trim()))));
  const nearBlack = (v: string) => /currentColor|inherit|#000|black|neutral-(8|9)\d\d|--lims-(text|ink|fg|foreground)/i.test(v)
    || (/^#[0-9a-f]{6}$/i.test(v) && Math.max(...[1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16))) < 0x60);

  it('a stylesheet colours .lims-series-0 (or the plain bar) with a palette colour, not currentColor / neutral-8xx / 9xx / text colour', () => {
    expect(decls.length, 'a colour or fill rule for the first series bar').toBeGreaterThan(0);
    for (const v of decls) expect(nearBlack(v), `colour "${v}" must not be near-black`).toBe(false);
  });
  it('the Dues bars are drawn as series 0 (so that rule applies)', async () => {
    set('__FIX3_CENTRES', CENTRES);
    set('__FIX3_DUES', [due(1, A)]);
    const mod = await import('../app/(staff)/billing/dues/page');
    const { container } = render(<ToastProvider>{await (mod.default as unknown as (p: never) => Promise<never>)(props)}</ToastProvider>);
    const bars = [...container.querySelectorAll('rect.lims-chart-bar')];
    expect(bars.length).toBeGreaterThan(0);
    expect(bars.every((b) => b.classList.contains('lims-series-0'))).toBe(true);
  });
});

describe('DataTable cell crash: an undefined list renders the empty state', () => {
  it('SalesTable with rows undefined shows the empty state and the header, no throw', async () => {
    const { SalesTable } = await import('@/features/partners/components/SalesCommon');
    const { container } = render(
      <SalesTable<{ id: string; name: string }> caption="Synthetic list" columns={[{ id: 'name', header: 'Name', isRowHeader: true, cell: (r) => r.name }]}
        rows={undefined as never} getRowId={(r) => r.id} empty={{ title: 'Nothing here yet', body: 'Add one.' }} />,
    );
    expect(container.querySelector('.sales-empty-state')).toBeTruthy();
    expect(container.textContent).toContain('Nothing here yet');
    expect(container.textContent).toContain('Name');
  });
  it('Broadcasts with rows undefined (and templates undefined) shows the broadcasts empty state', async () => {
    const { Broadcasts } = await import('@/features/engagement/components/Broadcasts');
    const { container } = render(
      <ToastProvider><Broadcasts rows={undefined as never} templates={undefined as never} me="u1" permissions={['engagement.broadcast.read']} status={undefined} /></ToastProvider>,
    );
    expect(container.querySelector('.sales-empty-state')).toBeTruthy();
    expect(container.textContent).toContain(t('engagement.msg.broadcasts_empty'));
  });
  it('a broadcast whose audience_filter has no party_kinds still renders its row (audience cell empty, not a crash)', async () => {
    const { Broadcasts } = await import('@/features/engagement/components/Broadcasts');
    const row = { id: 'b1', template_id: 't1', audience_filter: {}, status: 'draft', recipient_count: 3, opted_out_count: 0, requested_by: 'u1', created_at: '2026-11-05T04:15:00.000Z', updated_at: '2026-11-05T04:15:00.000Z', version: 1 };
    const { container } = render(
      <ToastProvider><Broadcasts rows={[row] as never} templates={[{ id: 't1', name: 'Synthetic template', channel: 'sms', is_active: true }] as never} me="u1" permissions={['engagement.broadcast.read', 'engagement.broadcast.manage']} status={undefined} /></ToastProvider>,
    );
    expect(container.textContent).toContain('Synthetic template');
    expect(container.textContent).not.toMatch(/undefined|NaN/);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
