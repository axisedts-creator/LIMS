// @vitest-environment jsdom
// AN-T19 — per-report specifics (04-UI-UX §4.1–4.12 controls, notes and edge rules). Generic behaviour is in an-t19.reports.test.tsx.
// ACs: US-03.1/.6, US-04.2, US-05.1–.3, US-09.3, US-10.2–.4, US-11.1–.2, US-12.2, US-13.1, US-14.1–.2. Same ASSUMED contract as an-t19.reports.test.tsx.
// Filter controls are driven through the kit DOM (RadioGroup role=radiogroup "Group by", Switch role=switch/checkbox, Checkbox group);
// a filter change navigates with router.push/replace to the same page with the new query (server component re-reads).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpResponse } from 'msw';
import {
  AGENT, INST_3, ORDER, REF_ID, api, respond, bodies, bySlug, calls, gridNamed, headersOf, lastRow, norm, pageText, resetApi, router, rowTexts, session, show,
} from './an-t19.harness';

vi.mock('next/navigation', async () => (await import('./an-t19.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./an-t19.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => resetApi());
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const navigated = () => [...router.push.mock.calls, ...router.replace.mock.calls].map((c) => String(c[0]));
const cells = (row: HTMLElement) => [...row.querySelectorAll('[role=rowheader],[role=gridcell]')].map((c) => norm(c.textContent));
const body = (slug: string) => structuredClone(bySlug(slug).body);

describe('Income (§4.1, US-03)', () => {
  it('Group by RadioGroup [Day, A.D. month, B.S. month, Branch, Centre], Day selected by default', async () => {
    await show('income');
    const rg = screen.getByRole('radiogroup', { name: /group by/i });
    expect(within(rg).getAllByRole('radio').map((r) => norm(r.closest('label')?.textContent))).toEqual(['Day', 'A.D. month', 'B.S. month', 'Branch', 'Centre']);
    expect((within(rg).getByRole('radio', { name: 'Day' }) as HTMLInputElement).checked).toBe(true);
  });

  it('choosing "B.S. month" re-queries the same page with group_by=bs_month', async () => {
    await show('income');
    await userEvent.click(screen.getByRole('radio', { name: 'B.S. month' }));
    await waitFor(() => expect(navigated().some((u) => u.includes('/analytics/reports/income') && u.includes('group_by=bs_month'))).toBe(true));
  });

  it('a negative net-sales cell keeps its minus sign (colour is never the only cue, US-03.4)', async () => {
    const b = body('income');
    b.rows[0].net_sales_paisa = -150000;
    b.rows[0].credit_notes_paisa = 23150000;
    bodies['/v1/analytics/reports/income'] = b;
    await show('income');
    const row = rowTexts(gridNamed(/income/i))[0]!;
    expect(row).toMatch(/[-−]\s?(NPR\s?)?1,500/);
  });

  it('draws the net-sales chart for up to 31 groups; above that hides it and says so', async () => {
    await show('income');
    expect(pageText()).not.toContain('Chart shows up to 31 groups');
    cleanup();
    const b = body('income');
    b.rows = Array.from({ length: 32 }, (_, i) => ({ ...b.rows[0], key: `k${i}`, label: `Group ${i}` }));
    bodies['/v1/analytics/reports/income'] = b;
    await show('income');
    expect(pageText()).toContain('Chart shows up to 31 groups');
  });
});

describe('Departments (§4.2, US-04)', () => {
  it('shows an inactive department with its name and "(inactive)" (US-04.2)', async () => {
    const b = body('department-income');
    b.rows[0].is_inactive = true;
    bodies['/v1/analytics/reports/department-income'] = b;
    await show('department-income');
    expect(rowTexts(gridNamed(/department/i))[0]).toContain('Synthetic Biochemistry (inactive)');
  });

  it('package row is "Multiple departments" (the API label is ignored)', async () => {
    await show('department-income');
    const t = rowTexts(gridNamed(/department/i)).join(' | ');
    expect(t).toContain('Multiple departments');
    expect(t).not.toContain('ignored for multiple');
  });

  it('reconciles_with_income=false: warning banner "Department totals do not match income for this period. The team has been alerted." and the figures stay', async () => {
    const b = body('department-income');
    b.reconciles_with_income = false;
    bodies['/v1/analytics/reports/department-income'] = b;
    await show('department-income');
    expect(pageText()).toContain('Department totals do not match income for this period. The team has been alerted.');
    expect(rowTexts(gridNamed(/department/i)).join(' ')).toContain('9,000');
  });

  it('reconciles_with_income=true: no mismatch banner', async () => {
    await show('department-income');
    expect(pageText()).not.toContain('Department totals do not match income');
  });
});

describe('Referrers (§4.5, US-05) — volume only, no money', () => {
  it('has no money column or money text anywhere (D-44), even if the API sent a stray money field', async () => {
    const b = body('top-referrers');
    b.rows[0].net_billed_paisa = 99900000;
    b.rows[0].net_sales_paisa = 99900000;
    b.totals.net_billed_paisa = 99900000;
    bodies['/v1/analytics/reports/top-referrers'] = b;
    await show('top-referrers');
    expect(headersOf(gridNamed(/referrer/i)).join(' ')).not.toMatch(/billed|sales|amount|income|NPR|paisa/i);
    expect(document.body.textContent).not.toMatch(/9,99,000|99900000|Net billed/);
  });

  it('"Combine merged doctors" Switch is on by default and switching it off re-queries with rollup=none (US-05.2)', async () => {
    await show('top-referrers');
    const sw = screen.getByRole('switch', { name: 'Combine merged doctors' }) as HTMLInputElement;
    expect(sw.checked).toBe(true);
    await userEvent.click(sw);
    await waitFor(() => expect(navigated().some((u) => u.includes('/analytics/reports/top-referrers') && u.includes('rollup=none'))).toBe(true));
  });

  it('SELF row reads "SELF (no referrer)" and an inactive referrer keeps its name with "(inactive)"', async () => {
    const b = body('top-referrers');
    b.rows[0].is_inactive = true;
    bodies['/v1/analytics/reports/top-referrers'] = b;
    await show('top-referrers');
    const t = rowTexts(gridNamed(/referrer/i)).join(' | ');
    expect(t).toContain('SELF (no referrer)');
    expect(t).toContain('Dr Synthetic One (inactive)');
  });

  it('offers Sort [Orders, Patient visits, Tests ordered] and Limit [10, 20, 50, 100] controls', async () => {
    await show('top-referrers');
    expect(screen.getByRole('button', { name: /sort/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /limit/i })).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: /limit/i }));
    expect(within(screen.getByRole('listbox', { name: /limit/i })).getAllByRole('option').map((o) => norm(o.textContent))).toEqual(['10', '20', '50', '100']);
  });

  it('Referrer filter is a multi Combobox: searchAnalyticsReferrers POST {query} only from 2 chars, and picking one writes referrer_id (04-UI-UX §4.5, US-05.3)', async () => {
    respond['/v1/analytics/referrers/search'] = () => HttpResponse.json({ data: [{ referrer_id: REF_ID, label: 'Dr Synthetic One', is_active: true }] });
    await show('top-referrers');
    const search = () => calls.filter((c) => c.method === 'POST' && c.url.pathname === '/v1/analytics/referrers/search');
    const cb = screen.getByRole('combobox', { name: /referrer/i });
    await userEvent.type(cb, 'S');
    await new Promise((r) => setTimeout(r, 400));
    expect(search()).toHaveLength(0);
    await userEvent.type(cb, 'y');
    await waitFor(() => expect(search()).toHaveLength(1));
    expect(JSON.parse(search()[0]!.body!)).toEqual({ query: 'Sy' });
    expect(search()[0]!.url.search).toBe(''); // no search text in the URL (REQ-SEC-098)
    await userEvent.click(await screen.findByRole('option', { name: /Dr Synthetic One/ }));
    await waitFor(() => expect(navigated().some((u) => u.includes('/analytics/reports/top-referrers') && u.includes(`referrer_id=${REF_ID}`))).toBe(true));
  });
});

describe('Centres (§4.6, US-06)', () => {
  it('limit options stop at 50 (API max)', async () => {
    await show('top-centres');
    await userEvent.click(screen.getByRole('button', { name: /limit/i }));
    expect(within(screen.getByRole('listbox', { name: /limit/i })).getAllByRole('option').map((o) => norm(o.textContent))).toEqual(['10', '20', '50']);
  });
});

describe('Tests done (§4.7, US-09)', () => {
  it('captions the seven analyte-level columns "Results (analyte level)" and keeps "Tests completed" as its own column', async () => {
    await show('tests-done');
    expect(pageText()).toContain('Results (analyte level)');
    expect(headersOf(gridNamed(/tests done/i)).at(-1)).toBe('Tests completed');
  });
});

describe('TAT (§4.8, US-11)', () => {
  it('a segment with n = 0 shows "—" in Median, 90th percentile and Max (never 0 or blank)', async () => {
    await show('tat');
    const g = gridNamed(/tat|turnaround/i);
    const h = headersOf(g);
    const row = dataRowFor(g, 'Transport');
    for (const col of ['Median', '90th percentile', 'Max']) expect(cells(row)[h.indexOf(col)], col).toBe('—');
  });

  it('shows anomalies in "Excluded (anomalies)"', async () => {
    await show('tat');
    const g = gridNamed(/tat|turnaround/i);
    expect(cells(dataRowFor(g, 'Pre-analytical'))[headersOf(g).indexOf('Excluded (anomalies)')]).toBe('1');
  });

  it('segment Checkbox group: five segments, all checked by default; unchecking one re-queries without it', async () => {
    await show('tat');
    const names = ['Pre-analytical', 'Transport', 'Within-lab', 'Total (first report)', 'Total (final report)'];
    for (const n of names) expect((screen.getByRole('checkbox', { name: n }) as HTMLInputElement).checked, n).toBe(true);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Transport' }));
    await waitFor(() => expect(navigated().some((u) => u.includes('/analytics/reports/tat') && u.includes('segment=pre_analytical%2Cwithin_lab%2Ctotal_first_release%2Ctotal_final_release'))).toBe(true));
  });

  it('segment definition list ("always visible above the table") shows start → stop for all five segments even when there are no rows', async () => {
    const b = body('tat');
    b.rows = [];
    bodies['/v1/analytics/reports/tat'] = b;
    await show('tat');
    for (const s of ['Pre-analytical', 'Transport', 'Within-lab', 'Total (first report)', 'Total (final report)', 'Sample collected', 'Received at lab', 'Scanned out at centre', 'Scanned in at lab', 'First result verified', 'Registered', 'First report released', 'Final report released']) expect(pageText(), s).toContain(s);
  });
});

function dataRowFor(g: HTMLElement, label: string) {
  const r = within(g).getAllByRole('row').find((x) => cells(x)[0] === label);
  if (!r) throw new Error(`no row "${label}"`);
  return r;
}

describe('Pending tests (§4.9, US-10)', () => {
  it('top StatTiles Pending / Overdue / No TAT target and the "Reports pending" card', async () => {
    await show('pending-tests');
    const tiles = Object.fromEntries([...document.querySelectorAll('.lims-stat')].map((e) => [norm(e.querySelector('.lims-stat-label')?.textContent), norm(e.textContent)]));
    expect(tiles['Pending']).toContain('9');
    expect(tiles['Overdue']).toContain('1');
    expect(tiles['No TAT target']).toContain('2');
    expect(screen.getAllByText('Reports pending').length).toBeGreaterThan(0);
  });

  it('no patient name / number / barcode column or text (US-10.3)', async () => {
    const b = body('pending-tests');
    b.data[0].patient_name = 'Synthetic Patient';
    b.data[0].barcode = 'BC123456';
    b.data[0].registration_no = 'REG-1';
    bodies['/v1/analytics/reports/pending-tests/items'] = b;
    await show('pending-tests');
    expect(headersOf(gridNamed(/pending/i)).join(' ')).not.toMatch(/patient|barcode|registration|accession/i);
    expect(document.body.textContent).not.toMatch(/Synthetic Patient|BC123456|REG-1/);
  });

  it('"Overdue" text and "Urgent" badge only on the rows that are overdue / urgent (not colour only)', async () => {
    await show('pending-tests');
    const [first, second] = rowTexts(gridNamed(/pending/i));
    expect(first).toContain('Urgent');
    expect(first).not.toContain('Overdue');
    expect(second).toContain('Overdue');
    expect(second).not.toContain('Urgent');
  });

  it('shows "Open" only for rows with open_route_id, linking to the order results page (US-10.3)', async () => {
    const b = body('pending-tests');
    delete b.data[1].open_route_id;
    bodies['/v1/analytics/reports/pending-tests/items'] = b;
    session.permissions = ['analytics.dashboard.read', 'lab.result.read'];
    await show('pending-tests');
    const links = within(gridNamed(/pending/i)).getAllByRole('link', { name: /open/i });
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute('href')).toBe(`/lab/orders/${ORDER}/results`);
  });

  it('cursor pagination: Previous disabled on the first page, Next opens the next cursor (limit 50, no page numbers)', async () => {
    await show('pending-tests');
    expect((screen.getByRole('button', { name: 'Previous' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(navigated().some((u) => u.includes('/analytics/reports/pending-tests') && u.includes('cursor=cur2'))).toBe(true));
    const items = calls.filter((c) => c.url.pathname.endsWith('/pending-tests/items'));
    expect(items[0]!.url.searchParams.get('limit')).toBe('50');
  });

  it('Next is disabled on the last page (no next_cursor)', async () => {
    const b = body('pending-tests');
    delete b.page.next_cursor;
    bodies['/v1/analytics/reports/pending-tests/items'] = b;
    await show('pending-tests');
    expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('has the "Overdue only" Switch (off by default)', async () => {
    await show('pending-tests');
    expect((screen.getByRole('switch', { name: 'Overdue only' }) as HTMLInputElement).checked).toBe(false);
  });
});

describe('Quality (§4.10, US-12)', () => {
  it('critical-values summary row shows the maximum but no median (medians are not additive, US-12.2)', async () => {
    await show('quality-indicators');
    const last = norm(lastRow(gridNamed(/critical/i)).textContent);
    expect(last).toContain('5 h 12 min');
    expect(last).not.toContain('42 min');
  });

  it('rejection rate comes from per_100_received_bp with one decimal; an undefined rate shows "—"', async () => {
    const b = body('quality-indicators');
    delete b.rejections.rows[0].per_100_received_bp;
    bodies['/v1/analytics/reports/quality-indicators'] = b;
    await show('quality-indicators');
    expect(rowTexts(gridNamed(/rejection/i))[0]).toContain('—');
    expect(rowTexts(gridNamed(/rejection/i))[0]).not.toMatch(/NaN|undefined/);
  });
});

describe('Delivery (§4.11, US-13)', () => {
  it('failure share is a percent with one decimal and the cohort note labels it', async () => {
    await show('delivery');
    expect(rowTexts(gridNamed(/deliver/i))[0]).toContain('8.7%');
    expect(pageText()).toContain('Counted on the day each message was created; later status changes update that day.');
  });
});

describe('Interfaces (§4.12, US-14)', () => {
  it('agent counts by state with text labels (Online/Offline), not colour only', async () => {
    await show('interfaces');
    const t = pageText();
    expect(t).toMatch(/Online\D{0,6}2/);
    expect(t).toMatch(/Offline\D{0,6}1/);
  });

  it('instrument label = display name with code; inactive gets "(inactive)"; a directory miss falls back to a short id', async () => {
    await show('interfaces');
    const t = rowTexts(gridNamed(/instrument|message/i)).join(' | ');
    expect(t).toContain('Synthetic Haematology Analyser');
    expect(t).toContain('XN-1000');
    expect(t).toContain('Synthetic Retired Analyser (inactive)');
    expect(t).toMatch(new RegExp(`${INST_3.slice(0, 8)}|${INST_3.slice(-8)}`));
    expect(t).not.toContain(INST_3);
  });

  it('links each agent to staff.instruments.agent only for holders of instruments.agent.read', async () => {
    await show('interfaces');
    expect(within(gridNamed(/agent/i)).queryAllByRole('link')).toHaveLength(0);
    cleanup();
    session.permissions = ['analytics.dashboard.read', 'instruments.agent.read'];
    await show('interfaces');
    expect(within(gridNamed(/agent/i)).getAllByRole('link')[0]!.getAttribute('href')).toBe(`/instruments/agents/${AGENT}`);
  });
});
