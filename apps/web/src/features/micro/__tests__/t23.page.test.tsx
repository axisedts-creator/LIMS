// @vitest-environment jsdom
// C10.T-23 — /micro/instrument-records page + list (04-UI-UX §4, §9; AC-08.4 "until LabPort.lookupSpecimens is enabled" banner; 07-SECURITY REQ-SEC-121, AC-08.10, S-22; LD-140).
// Server component awaited directly and its element rendered (MSW plays the API). Seams: see t23.harness.tsx header.
// LD-140 (2026-11-13): kit components only; one primary button per page (this page has no page action -> zero); every status shows tone + icon + word.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { BANNER_TEXT, BARCODE, FLAG_ENV, ID, INSTRUMENT_A, LIST, OPEN_STATUSES, ORIGIN, PERM_READ, PERM_WORK, api, clean, hit, instrumentList, orgRec, problem, rec, recordList, resetHits, router, rowAction, state, statusChip, useRecords } from './t23.harness';

vi.mock('next/navigation', async () => (await import('./t23.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t23.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); state.permissions = PERM_WORK; delete process.env[FLAG_ENV]; });
afterEach(() => { cleanup(); api.resetHandlers(); delete process.env[FLAG_ENV]; });
afterAll(() => api.close());

const show = async (sp: Record<string, string | string[] | undefined> = {}) => {
  const mod = await import('../../../app/(staff)/micro/instrument-records/page');
  const el = await mod.default({ searchParams: Promise.resolve(sp) } as never);
  return render(<ToastProvider>{el}</ToastProvider>);
};
const lists = () => hit('GET', LIST);
const q = (h: { search: string }) => new URLSearchParams(h.search);
const ALL = [
  rec(1, { match_status: 'pending_match', match_reason: 'lookup_unavailable' }),
  rec(2, { match_status: 'needs_mapping', match_reason: undefined, culture_id: ID(1) }),
  rec(3, { match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: ID(1) }),
  rec(4, { match_status: 'late_after_final', match_reason: undefined, culture_id: ID(1) }),
];

describe('request shape (04-UI-UX §4; TRD M19)', () => {
  it('no filters -> the four open statuses, newest first, one page of at most 50', async () => {
    useRecords(ALL);
    await show();
    const m = lists()[0]!;
    expect((q(m).get('match_status') ?? '').split(',').sort().join(',')).toBe(OPEN_STATUSES.split(',').sort().join(','));
    expect(q(m).get('sort')).toBe('-received_at');
    expect(Number(q(m).get('limit') ?? '50')).toBeLessThanOrEqual(50);
  });
  it('valid filters are forwarded: match_status, instrument_id, received range, cursor', async () => {
    useRecords(ALL);
    await show({ match_status: 'applied,ignored', instrument_id: INSTRUMENT_A, received_at_from: '2026-11-01T00:00:00.000Z', received_at_to: '2026-11-14T00:00:00.000Z', cursor: 'abc123' });
    const m = lists()[0]!;
    expect(q(m).get('match_status')).toBe('applied,ignored');
    expect(q(m).get('instrument_id')).toBe(INSTRUMENT_A);
    expect(q(m).get('received_at_from')).toBe('2026-11-01T00:00:00.000Z');
    expect(q(m).get('received_at_to')).toBe('2026-11-14T00:00:00.000Z');
    expect(q(m).get('cursor')).toBe('abc123');
  });
  it.each([['bogus'], ['applied,drop table'], ['PENDING_MATCH'], [['applied', 'ignored']], ['']])('an invalid match_status %j falls back to the open statuses (nothing user-controlled reaches the API)', async (v) => {
    useRecords(ALL);
    await show({ match_status: v as never });
    expect((q(lists()[0]!).get('match_status') ?? '').split(',').sort().join(',')).toBe(OPEN_STATUSES.split(',').sort().join(','));
  });
  it('a non-uuid instrument_id is dropped', async () => {
    useRecords(ALL);
    await show({ instrument_id: "x' or 1=1" });
    expect(q(lists()[0]!).get('instrument_id')).toBeNull();
  });
  it('the barcode is never sent in a query string (AC-08.10)', async () => {
    useRecords(ALL);
    await show({ barcode: BARCODE, sample_barcode: BARCODE } as never);
    for (const h of lists()) expect(h.search).not.toContain(BARCODE);
  });
});

describe('layout and columns (§4)', () => {
  it('h1 "Micro instrument data", no primary button on the page (LD-140: no page action)', async () => {
    useRecords(ALL);
    await show();
    expect(screen.getByRole('heading', { level: 1, name: /^micro instrument data$/i })).toBeTruthy();
    expect(document.querySelectorAll('button.lims-btn-primary')).toHaveLength(0);
  });
  it('columns: Received, Instrument, Kind, Barcode, Isolate no., Code, Value, Status, Reason', async () => {
    useRecords(ALL);
    await show();
    const heads = within(screen.getByRole('grid')).getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Received', 'Instrument', 'Kind', 'Barcode', 'Isolate no.', 'Code', 'Value', 'Status', 'Reason']) expect(heads, h).toContain(h);
  });
  it('an AST row reads: instrument name, "AST", barcode, isolate no., raw antibiotic code and "<=0.25 · S · CLSI 2026"', async () => {
    useRecords([rec(1)]);
    await show();
    const row = within(screen.getByRole('grid')).getAllByRole('row').find((r) => (r.textContent ?? '').includes(BARCODE))!;
    const t = row.textContent ?? '';
    expect(t).toContain('SYN-VITEK');
    expect(t).toMatch(/\bAST\b/);
    expect(t).toContain('SYN-CEF-A');
    expect(t).toContain('<=0.25 · S · CLSI 2026');
    expect(within(row).getByText('2')).toBeTruthy();
  });
  it('an organism row reads "Organism ID" with the raw organism code and "—" where there is no value', async () => {
    useRecords([orgRec(1)]);
    await show();
    const row = within(screen.getByRole('grid')).getAllByRole('row').find((r) => (r.textContent ?? '').includes('SYN-ORG-9'))!;
    expect(row.textContent).toMatch(/Organism ID/);
    expect(row.textContent).toContain('—');
  });
  it('without an instrument list (C7 refused) the page still renders; the instrument shows its id-free fallback, no raw uuid column', async () => {
    api.use(recordList([rec(1)]), http.get(`${ORIGIN}/v1/instruments/instruments`, () => problem('auth.forbidden', 403)));
    await show();
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^instrument$/i })).toBeNull(); // filter hidden
  });
});

describe('statuses: tone + icon + word (LD-140, §9) and reasons (§9)', () => {
  it.each([
    ['Waiting for match', 'warning'], ['Needs code mapping', 'warning'], ['Conflict', 'danger'], ['After final report', 'warning'],
  ])('%s -> tone %s with an icon', async (label, tone) => {
    useRecords(ALL);
    await show();
    const chip = within(screen.getByRole('grid')).getAllByText(label, { selector: '*' }).map((e) => e.closest('[data-tone]')).find(Boolean) as HTMLElement | undefined;
    expect(chip, label).toBeTruthy();
    expect(chip!.getAttribute('data-tone')).toBe(tone);
    expect(chip!.querySelector('svg,[data-icon],[aria-hidden=true]'), 'icon').toBeTruthy();
  });
  it.each([['applied', 'Applied', 'success'], ['ignored', 'Ignored', 'neutral']])('%s -> "%s", tone %s (shown when the filter asks for it)', async (status, label, tone) => {
    api.use(recordList([rec(1, { match_status: status, match_reason: undefined })]), instrumentList());
    await show({ match_status: status });
    const chip = statusChip(label);
    expect(chip, label).toBeTruthy();
    expect(chip!.getAttribute('data-tone')).toBe(tone);
    expect(chip!.querySelector('svg,[data-icon],[aria-hidden=true]'), 'icon').toBeTruthy();
  });
  it.each([
    ['lookup_unavailable', 'Automatic matching not enabled'], ['unknown_barcode', 'Barcode not found'], ['no_culture', 'No culture for this specimen'], ['multiple_cultures', 'Several cultures for this specimen'],
    ['isolate_missing', 'Isolate not yet recorded'], ['isolate_seq_out_of_range', 'Isolate number above 99 — choose one'], ['organism_differs', 'Different organism already recorded'],
    ['manual_value_exists', 'Manual value already recorded'], ['culture_cancelled', 'Culture cancelled'],
  ])('reason %s reads "%s" — never the raw code', async (reason, text) => {
    api.use(recordList([rec(1, { match_reason: reason })]), instrumentList());
    await show();
    expect(within(screen.getByRole('grid')).getByText(text)).toBeTruthy();
    expect(document.body.textContent).not.toContain(reason);
  });
});

describe('banner while LIMS_MICRO_SPECIMEN_LOOKUP_PORT is off (§4, AC-08.4)', () => {
  it.each([[undefined], ['false'], ['0'], ['']])('flag %j -> persistent info banner with the exact text', async (v) => {
    if (v !== undefined) process.env[FLAG_ENV] = v;
    useRecords(ALL);
    await show();
    const el = screen.getByText(BANNER_TEXT);
    expect(el.closest('[data-tone]')?.getAttribute('data-tone')).toBe('info');
    expect(el.closest('[data-tone]')?.querySelector('button[aria-label*="ismiss" i], button[aria-label*="lose" i]')).toBeNull(); // persistent: no dismiss
  });
  it('flag "true" -> no banner', async () => {
    process.env[FLAG_ENV] = 'true';
    useRecords(ALL);
    await show();
    expect(screen.queryByText(BANNER_TEXT)).toBeNull();
  });
  it('the banner also shows on an empty list while the flag is off (it is about the page, not the rows)', async () => {
    api.use(recordList([]), instrumentList());
    await show();
    expect(screen.getByText(BANNER_TEXT)).toBeTruthy();
  });
});

describe('empty, forbidden and failing states', () => {
  it('empty: "No instrument data waiting."', async () => {
    api.use(recordList([]), instrumentList());
    await show();
    expect(screen.getByText('No instrument data waiting.')).toBeTruthy();
  });
  it('403 -> full-page "no access"; no table, no rows, no barcode (S-22, REQ-SEC-081)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/instrument-records`, () => problem('auth.forbidden', 403)));
    await show();
    expect(screen.queryByRole('grid')).toBeNull();
    expect(document.body.textContent).toMatch(/don.t have access/i);
    expect(document.body.textContent).not.toContain(BARCODE);
    expect(hit('GET', /\/v1\/instruments\//)).toHaveLength(0);
  });
  it.each([500, 503])('%i rejects so error.tsx renders (no partial table)', async (status) => {
    api.use(http.get(`${ORIGIN}/v1/micro/instrument-records`, () => problem('common.internal', status)));
    await expect(show()).rejects.toBeTruthy();
  });
  it('400 (invalid cursor) rejects rather than showing stale rows', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/instrument-records`, () => problem('common.invalid_cursor', 400)));
    await expect(show({ cursor: 'abc' })).rejects.toBeTruthy();
  });
});

describe('filters and paging navigate by id / code only (AC-08.10: no barcode in a URL)', () => {
  it('a next cursor shows "Next"; clicking it pushes ?cursor=… and nothing else sensitive', async () => {
    api.use(recordList(ALL, { next_cursor: 'CUR2' }), instrumentList());
    await show();
    await userEvent.click(screen.getByRole('button', { name: /next/i }));
    const to = router.push.mock.calls.map((c) => String(c[0])).at(-1)!;
    expect(to).toMatch(/^\/micro\/instrument-records\?/);
    expect(to).toContain('cursor=CUR2');
    expect(to).not.toContain(BARCODE);
  });
  it('the row links / hrefs never contain the barcode', async () => {
    useRecords(ALL);
    await show();
    for (const a of Array.from(document.querySelectorAll('a[href]'))) expect(a.getAttribute('href')).not.toContain(BARCODE);
  });
});

describe('row actions per state (03-APP-FLOW §2.4 IR2–IR6; 04-UI-UX §4)', () => {
  const menuFor = async (r: Record<string, unknown>) => {
    api.use(recordList([r]), instrumentList());
    await show({ match_status: String(r['match_status']) });
    const row = within(screen.getByRole('grid')).getAllByRole('row').find((x) => (x.textContent ?? '').includes(BARCODE))!;
    const direct = within(row).queryAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '');
    if (direct.some((n) => /assign|apply|resolve|ignore/i.test(n))) return direct;
    const buttons = within(row).queryAllByRole('button');
    if (buttons.length === 0) return [];
    await userEvent.click(buttons[buttons.length - 1]!);
    const items = await screen.findAllByRole('menuitem').catch(() => []);
    return items.map((i) => i.textContent ?? '');
  };
  it.each([
    [{ match_status: 'pending_match', match_reason: 'no_culture' }, ['Assign to culture', 'Ignore'], ['Apply', 'Resolve conflict']],
    [{ match_status: 'pending_match', match_reason: 'isolate_missing', culture_id: ID(1) }, ['Assign to culture', 'Apply', 'Ignore'], ['Resolve conflict']],
    [{ match_status: 'needs_mapping', match_reason: undefined, culture_id: ID(1) }, ['Apply', 'Ignore'], ['Assign to culture', 'Resolve conflict']],
    [{ match_status: 'conflict', match_reason: 'manual_value_exists', culture_id: ID(1) }, ['Resolve conflict', 'Ignore'], ['Assign to culture']],
    [{ match_status: 'late_after_final', match_reason: undefined, culture_id: ID(1) }, ['Apply', 'Ignore'], ['Assign to culture', 'Resolve conflict']],
  ])('%j offers %j and not %j', async (over, offered, absent) => {
    const names = await menuFor(rec(1, over));
    for (const o of offered) expect(names.map((n) => n.trim()), o).toContain(o);
    for (const a of absent) expect(names.map((n) => n.trim()), a).not.toContain(a);
  });
  it.each(['applied', 'ignored'])('%s: no actions (IR "applied/ignored -> any" is forbidden)', async (status) => {
    const names = await menuFor(rec(1, { match_status: status, match_reason: undefined, culture_id: ID(1) }));
    expect(names.filter((n) => /assign|apply|resolve|ignore/i.test(n))).toEqual([]);
  });
  it('without micro.culture.work the list is readable but no row action exists (S-22 reads, micro.culture.work writes)', async () => {
    state.permissions = PERM_READ;
    api.use(recordList(ALL), instrumentList());
    await show();
    const grid = screen.getByRole('grid');
    expect(within(grid).queryAllByRole('button', { name: /assign|apply|resolve|ignore/i })).toHaveLength(0);
    for (const b of within(grid).queryAllByRole('button')) {
      await userEvent.click(b);
      expect(screen.queryAllByRole('menuitem')).toHaveLength(0);
      await userEvent.keyboard('{Escape}');
    }
  });
  it('rowAction helper sanity: the Ignore dialog opens from the row menu', async () => {
    useRecords([rec(1)]);
    await show();
    await rowAction(BARCODE, /^ignore$/i);
    expect(await screen.findByRole('dialog', { name: /ignore/i })).toBeTruthy();
  });
});

describe('untrusted data (REQ-SEC-121: never rendered as HTML)', () => {
  it('markup / script in raw codes and values is shown as text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    api.use(recordList([rec(1, { antibiotic_code_raw: evil, raw_value: '<b>1</b>', interpretation_raw: '<script>x</script>' })]), instrumentList());
    await show();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(document.body.textContent).toContain(evil);
  });
  it('an unknown future match_status / reason does not crash and shows no raw code', async () => {
    api.use(recordList([rec(1, { match_status: 'pending_match', match_reason: 'brand_new_reason' })]), instrumentList());
    await show();
    expect(screen.getByRole('grid')).toBeTruthy();
    expect(document.body.textContent).not.toContain('brand_new_reason');
  });
});

describe('accessibility', () => {
  it('populated page has no axe violations', async () => {
    useRecords(ALL);
    const { container } = await show();
    const v = (await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(v).toEqual([]);
  });
});

void clean; void waitFor;
