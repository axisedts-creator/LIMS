// @vitest-environment jsdom
// T0D-UILIST-1 (LD-353 template 1 LIST, UI rules 5, 6, 8): micro list screens. Each page renders twice (no rows, one row) through the REAL page + BFF + MSW.
// Pinned (done_when): (1) PageHeader = menu label, primary action at right; (2) micro instrument records: status chips + instrument + Received from/to in exactly ONE FilterBar;
// (4) table header row always (also empty) + EmptyState in the body; (5) breakpoint sets title = menu name; micro settings: "Escherichia coli" and "Gram negative" cells do not wrap
// (jsdom has no layout, so the check is: some css rule that reaches the cell says white-space: nowrap, or min-width/width >= 12rem; read from kit.css, shell.css, features/micro/**/*.css, inline style);
// (6) micro worklist: a failed read renders ErrorState inside the page (h1 kept, Retry, Reference), 501 operation_pending renders NotAvailable (h1 kept) - today both THROW to error.tsx;
// (7) tables sit in `.lims-table-scroll`. Helpers: src/__tests__/uilist1.helpers.tsx. Reuses the C10 T-19 harness (MSW + session mock), synthetic data only.
// Skipped (other tasks / not template 1): culture detail, breakpoint set detail, settings other tabs (protocols, panels, mappings, general: T0D-UISETTINGS-1).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { http } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { expectEmptyState, expectErrorState, expectFilterBars, expectHeader, expectNotAvailable, expectTable } from '@/__tests__/uilist1.helpers';
import { ID, ORIGIN, PERM_READ, api, culture, page, problem, resetHits, state } from './t19.harness';

vi.mock('next/navigation', async () => (await import('./t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); state.permissions = [...PERM_READ, 'micro.culture.work', 'micro.breakpoint.manage', 'micro.config.manage']; });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const WEB = join(import.meta.dirname, '..', '..', '..'); // apps/web/src
const UI = join(WEB, '..', '..', '..', 'packages', 'ui', 'src', 'components');

/** Mount a server page. A throw IS the founder's error page: report it as the design failure it is. */
async function mount(path: string, load: () => Promise<unknown>) {
  let el: unknown;
  try { el = await load(); } catch (e) { expect.fail(`${path}: the page threw (${(e as Error).message}) instead of drawing ErrorState / NotAvailable inside the page`); }
  return render(<ToastProvider>{el as never}</ToastProvider>);
}
const sp = (o: Record<string, string> = {}) => ({ searchParams: Promise.resolve(o) }) as never;

const instrument = { id: ID(700), code: 'SYN-AN-1', name: 'Synthetic analyser 1' };
const record = (n: number) => ({
  id: ID(800 + n), version: 1, record_kind: 'organism_id', instrument_id: instrument.id, instrument_message_id: ID(900 + n), sample_barcode: `E26000${String(n).padStart(4, '0')}`,
  organism_code_raw: 'ECOLI', received_at: '2026-11-10T04:15:00.000Z', is_rerun: false, match_status: 'pending_match',
});
const bpSet = (n: number) => ({
  id: ID(1000 + n), version: 1, standard: 'CLSI', standard_version: 'SYN-2026', title: `Synthetic breakpoint table ${n}`, licence_attestation_text: 'Synthetic attestation', status: 'draft',
  file_sha256: 'a'.repeat(64), file_bytes: 1024, row_count: 12, band_count: 30, error_count: 0, warning_count: 1, imported_by_display: 'Synthetic Admin', created_at: '2026-11-10T04:15:00.000Z',
});

// ------------------------------------------------------------------------------------------------ micro instrument records
describe('/micro/instrument-records', () => {
  const PATH = '/micro/instrument-records';
  const use = (rows: unknown[]) => api.use(
    http.get(`${ORIGIN}/v1/micro/instrument-records`, () => page(rows)),
    http.get(`${ORIGIN}/v1/instruments/instruments`, () => page([instrument])),
  );
  const open = () => mount(PATH, async () => (await import('../../../app/(staff)/micro/instrument-records/page')).default(sp()));

  it('no rows: menu title, no header action, ONE FilterBar with status + instrument + received from/to, table header row, EmptyState', async () => {
    use([]);
    const { container } = await open();
    expectHeader(container, PATH, { noAction: true });
    expectFilterBars(container, PATH, 1);
    const bar = container.querySelector('.lims-filter-bar')!;
    for (const label of ['Status', 'Instrument', 'Received']) expect(bar.textContent, `FilterBar holds "${label}"`).toContain(label);
    expect(bar.querySelector('.lims-chip-list'), 'the status chips are inside the same bar').not.toBeNull();
    const range = bar.querySelector('.lims-date-range');
    expect(range, 'the Received range is inside the same bar').not.toBeNull();
    expect(range!.textContent, 'Received has a From and a To date').toMatch(/From[\s\S]*To/);
    expectTable(container, PATH, { headers: ['Received', 'Instrument', 'Status'] });
    expectEmptyState(container, PATH);
  });

  it('one row: the row is drawn under the same header row, no EmptyState', async () => {
    use([record(1)]);
    const { container } = await open();
    expectHeader(container, PATH, { noAction: true });
    expectFilterBars(container, PATH, 1);
    expectTable(container, PATH, { headers: ['Received', 'Instrument', 'Status'] });
    expect(await screen.findByText('E260000001')).toBeTruthy();
    expect(container.querySelectorAll('.lims-state:not(.lims-tone-danger)').length).toBe(0);
  });

  it('501 operation_pending: NotAvailable keeps the title and the table header row', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/instrument-records`, () => problem('operation_pending', 501)));
    const { container } = await open();
    expectNotAvailable(container, PATH, { table: true });
  });
});

// ------------------------------------------------------------------------------------------------ micro breakpoint sets
describe('/micro/breakpoint-sets', () => {
  const PATH = '/micro/breakpoint-sets';
  const use = (rows: unknown[]) => api.use(http.get(`${ORIGIN}/v1/micro/breakpoint-sets`, () => page(rows)));
  const open = () => mount(PATH, async () => (await import('../../../app/(staff)/micro/breakpoint-sets/page')).default());

  it('no rows: h1 is exactly the menu name "Breakpoint sets", one primary action "Import table" in the header, table header row, EmptyState', async () => {
    use([]);
    const { container } = await open();
    expectHeader(container, PATH, { action: 'Import table' });
    expect(container.querySelector('h1')!.textContent).toBe('Breakpoint sets');
    expectFilterBars(container, PATH, 0);
    expectTable(container, PATH, { headers: ['Title', 'Standard', 'Status'] });
    expectEmptyState(container, PATH);
  });

  it('one row: the title links to the set, header row stays', async () => {
    use([bpSet(1)]);
    const { container } = await open();
    expectHeader(container, PATH, { action: 'Import table' });
    expectTable(container, PATH, { headers: ['Title', 'Standard', 'Status'] });
    expect((await screen.findByText('Synthetic breakpoint table 1')).closest('a')?.getAttribute('href')).toBe(`/micro/breakpoint-sets/${ID(1001)}`);
  });

  it('501 operation_pending: NotAvailable keeps the title and the table header row', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/breakpoint-sets`, () => problem('operation_pending', 501)));
    const { container } = await open();
    expectNotAvailable(container, PATH, { table: true });
  });
});

// ------------------------------------------------------------------------------------------------ micro settings (Dictionaries tab)
const cssFiles = (): string[] => [
  join(UI, 'kit.css'), join(WEB, 'core', 'shell', 'shell.css'),
  ...(readdirSync(join(WEB, 'features', 'micro'), { recursive: true }) as string[]).filter((f) => f.endsWith('.css')).map((f) => join(WEB, 'features', 'micro', f)),
];
/** Selectors of every rule that keeps text on one line or sets a min width of at least 12rem (comments stripped; @media blocks flatten to their inner rules). */
function keepsOneLine(): { nowrap: string[]; wide: string[] } {
  const nowrap: string[] = [], wide: string[] = [];
  for (const f of cssFiles()) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const body = m[2]!;
      const sels = m[1]!.split(',').map((s) => s.trim()).filter((s) => s && !s.startsWith('@'));
      if (/white-space\s*:\s*nowrap/.test(body)) nowrap.push(...sels);
      const w = /(?:^|[;\s])(?:min-width|width)\s*:\s*([\d.]+)rem/.exec(body);
      if (w && Number(w[1]) >= 12) wide.push(...sels);
    }
  }
  return { nowrap, wide };
}
const hit = (el: Element, sels: string[], up: boolean) => sels.some((s) => { try { return up ? !!el.closest(s) : el.matches(s); } catch { return false; } });
/** True when something that reaches `cell` keeps its text on one line at 1366px: nowrap (inherited, so any ancestor) or a >= 12rem width on the cell / its column header. */
function wontWrap(cell: Element): boolean {
  const { nowrap, wide } = keepsOneLine();
  const th = cell.closest('table')?.querySelectorAll('thead th, [role="columnheader"]')[[...(cell.parentElement?.children ?? [])].indexOf(cell)];
  const inline = [cell, ...cell.querySelectorAll('*')].some((e) => /white-space:\s*nowrap/.test(e.getAttribute('style') ?? '') || /(min-)?width:\s*(1[2-9]|[2-9]\d)(\.\d+)?rem/.test(e.getAttribute('style') ?? ''));
  return inline || hit(cell, nowrap, true) || hit(cell, wide, false) || (!!th && hit(th, wide, false));
}

describe('/micro/settings (Dictionaries)', () => {
  const PATH = '/micro/settings';
  const use = (rows: unknown[]) => api.use(http.get(`${ORIGIN}/v1/micro/coded-sets/:set`, () => page(rows)));
  const open = () => mount(PATH, async () => (await import('../../../app/(staff)/micro/settings/page')).default());
  const ecoli = { code: 'escherichia_coli', display: 'Escherichia coli', sort_order: 1, is_active: true, source: 'global', organism_group_code: 'enterobacterales', gram_class: 'gram_negative', is_alert: false };

  it('no rows: menu title, table header row, EmptyState (after the tab loads)', async () => {
    use([]);
    const { container } = await open();
    await screen.findByText('No codes.');
    expectHeader(container, PATH, { noAction: true });
    expectTable(container, PATH, { headers: ['Code', 'Display', 'Gram class'] });
    expectEmptyState(container, PATH);
  });

  it('one organism row: "Escherichia coli" and "Gram negative" cells do not wrap at 1366 px', async () => {
    use([ecoli]);
    const { container } = await open();
    const name = (await screen.findByText('Escherichia coli')).closest('td, [role="gridcell"]')!;
    const gram = (await screen.findByText('Gram negative')).closest('td, [role="gridcell"]')!;
    expectTable(container, PATH, { headers: ['Code', 'Display', 'Gram class'] });
    expect(wontWrap(name), 'the Display cell keeps "Escherichia coli" on one line (white-space: nowrap or width >= 12rem)').toBe(true);
    expect(wontWrap(gram), 'the Gram class cell keeps "Gram negative" on one line (white-space: nowrap or width >= 12rem)').toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------ micro worklist
describe('/micro/worklist', () => {
  const PATH = '/micro/worklist';
  const open = () => mount(PATH, async () => (await import('../../../app/(staff)/micro/worklist/page')).default(sp()));

  it('no rows: menu title "Microbiology", no header action, ONE FilterBar, table header row, EmptyState', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => page([])));
    const { container } = await open();
    expectHeader(container, PATH, { noAction: true });
    expectFilterBars(container, PATH, 1);
    expectTable(container, PATH, { headers: ['Barcode', 'Test', 'Status'] });
    expectEmptyState(container, PATH);
  });

  it('one row: the culture is drawn under the same header row', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => page([culture(1)])));
    const { container } = await open();
    expectHeader(container, PATH, { noAction: true });
    expectFilterBars(container, PATH, 1);
    expectTable(container, PATH, { headers: ['Barcode', 'Test', 'Status'] });
    expect(await screen.findByText(/Synthetic culture 1/)).toBeTruthy();
  });

  it('500 on the culture list: ErrorState inside the page, title kept, Reference and Retry (today: thrown to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => problem('common.internal', 500, { request_id: '01950c12-0000-7000-8000-000000000001' })));
    const { container } = await open();
    expectErrorState(container, PATH);
  });

  it('501 operation_pending on the culture list: NotAvailable, title kept, table header row (today: thrown to error.tsx)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures`, () => problem('operation_pending', 501)));
    const { container } = await open();
    expectNotAvailable(container, PATH, { table: true });
  });
});
