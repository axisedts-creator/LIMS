// @vitest-environment jsdom
// C10.T-24 — breakpoint set detail: description list, issues/rows tabs, activate/retire/discard, four-eyes copy
// (04-UI-UX §6.2, §9, §10; AC-12.2, AC-13.1, AC-13.3, AC-13.5; 07-SECURITY S-13 "UI renders issue text as text (component test)").
// Real server actions + MSW API. ASSUMED seam: BreakpointSetDetail({ set, issues, rows, permissions }) — see t24.harness.tsx.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { ID, ORIGIN, PERM_BP, PERM_READ_ONLY, api, hit, hits, issueDto, problem, resetHits, router, rowDto, setDto, band } from './t24.harness';

vi.mock('next/navigation', async () => (await import('./t24.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t24.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const show = async (o: { set?: Record<string, unknown>; issues?: unknown[]; rows?: unknown[]; permissions?: string[] } = {}) => {
  const { BreakpointSetDetail } = await import('../components/breakpoints/BreakpointSetDetail');
  return render(<ToastProvider><BreakpointSetDetail set={setDto(o.set) as never} issues={(o.issues ?? []) as never} rows={(o.rows ?? []) as never} permissions={o.permissions ?? PERM_BP} /></ToastProvider>);
};
const btn = (name: RegExp) => screen.queryByRole('button', { name });

describe('header and description list (§6.2)', () => {
  it('shows status word, standard, version, licence text, sha256, size, counts, users', async () => {
    await show({ set: { status: 'active', activated_by_display: 'Synthetic Activator', effective_from: '2026-12-01T00:00:00.000Z' } });
    const t = document.body.textContent ?? '';
    expect(t).toContain('In use');
    for (const s of ['CLSI', '2099-test', 'Synthetic attestation: test data only, licensed for this laboratory.', 'ab'.repeat(32), 'Synthetic Importer', 'Synthetic Activator']) expect(t, s).toContain(s);
    expect(t).toMatch(/2,?048|2 ?KiB|2\.0 ?KB/); // file size
    expect(t).toMatch(/\b12\b/); // rows
    expect(t).toMatch(/\b30\b/); // bands
  });

  it('licence text and title are text nodes (S-13)', async () => {
    await show({ set: { licence_attestation_text: '<script>window.__x=1</script> licensed for us', title: '<b>bold</b>' } });
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('b')).toBeNull();
    expect((window as any).__x).toBeUndefined();
  });
});

describe('issues tab (AC-12.2; S-13)', () => {
  const issues = [
    issueDto({ line_no: 3, severity: 'error', code: 'row.category_invalid', field: 'category', message: 'Category not allowed.' }),
    issueDto({ line_no: 4, severity: 'warning', code: 'row.band_gap', field: 'bands', message: 'Gap between bands.' }),
    issueDto({ line_no: undefined, severity: 'error', code: 'file.too_many_rows', field: undefined, message: 'Too many rows.' }),
  ];
  it('Issues is the first tab; columns Line, Severity, Code, Field, Message', async () => {
    await show({ set: { status: 'invalid', error_count: 2, warning_count: 1 }, issues });
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(tabs.slice(0, 2)).toEqual([expect.stringMatching(/^Issues/), expect.stringMatching(/^Rows/)]);
    expect(screen.getAllByRole('tab')[0]!.getAttribute('aria-selected')).toBe('true');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Line', 'Severity', 'Code', 'Field', 'Message']) expect(headers, h).toContain(h);
    for (const c of ['row.category_invalid', 'row.band_gap', 'file.too_many_rows']) expect(document.body.textContent).toContain(c);
  });

  it('severity is shown as a word, not only a colour', async () => {
    await show({ set: { status: 'invalid' }, issues });
    expect(screen.getAllByText(/^(Error|Warning)$/i).length).toBeGreaterThanOrEqual(3);
  });

  it('severity filter narrows to errors', async () => {
    await show({ set: { status: 'invalid' }, issues });
    await userEvent.click(screen.getByRole('button', { name: /severity/i }));
    await userEvent.click(await screen.findByRole('option', { name: /^errors?$/i }));
    await waitFor(() => expect(document.body.textContent).not.toContain('Gap between bands.'));
    expect(document.body.textContent).toContain('Category not allowed.');
  });

  it('CSV-injection / HTML payloads in issue text render as inert text nodes (S-13, T-B4)', async () => {
    const evil = ['=HYPERLINK("http://evil.test")', '+cmd|calc', '-2+3', '@SUM(A1)', '<script>window.__pwn=1</script>', '<img src=x onerror="window.__pwn=2">'];
    await show({ set: { status: 'invalid' }, issues: evil.map((m, i) => issueDto({ line_no: i + 1, message: m })) });
    for (const m of evil) expect(document.body.textContent, m).toContain(m);
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('a[href^="http://evil"]')).toBeNull();
    expect((window as any).__pwn).toBeUndefined();
  });
});

describe('rows tab (§6.2: bands rendered from stored data, no example values shipped)', () => {
  const open = async (rows: unknown[]) => { await show({ rows }); await userEvent.click(screen.getByRole('tab', { name: /^rows/i })); };

  it('columns Line, Scope, Organism/group, Antibiotic, Method, Site, Qualifier, Bands', async () => {
    await open([rowDto(1)]);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    for (const h of ['Line', 'Scope', 'Antibiotic', 'Method', 'Site', 'Qualifier', 'Bands']) expect(headers, h).toContain(h);
    expect(headers.some((h) => /organism/i.test(h ?? ''))).toBe(true);
  });

  it('open lower bound → "{category} ≤ upper", open upper bound → "{category} ≥ lower"; no dash for open bounds', async () => {
    await open([rowDto(1)]);
    const cell = Array.from(document.querySelectorAll('td')).find((c) => /S/.test(c.textContent ?? '') && /22/.test(c.textContent ?? ''))!;
    const text = cell.textContent!.replace(/\s+/g, ' ');
    expect(text).toMatch(/S ?≥ ?22/);
    expect(text).toMatch(/R ?≤ ?17/);
    expect(text).not.toMatch(/22 ?[–-]/); // open upper bound: the dash is omitted
    expect(text).not.toMatch(/[–-] ?17/);
  });

  it('exclusive bounds use > and <', async () => {
    await open([rowDto(1, { bands: [band(1, { category_code: 'I', lower_value: '18', lower_inclusive: false }), band(2, { category_code: 'R', upper_value: '19', upper_inclusive: false })] })]);
    const t = document.body.textContent!.replace(/\s+/g, ' ');
    expect(t).toMatch(/I ?> ?18/);
    expect(t).toMatch(/R ?< ?19/);
  });

  it('closed band shows "{category} {lower}–{upper}"', async () => {
    await open([rowDto(1, { bands: [band(1, { category_code: 'I', lower_value: '18', lower_inclusive: true, upper_value: '21', upper_inclusive: true })] })]);
    expect(document.body.textContent!.replace(/\s+/g, ' ')).toMatch(/I .*18.*[–-].*21/);
  });

  it('shows no data it was not given (no invented rows / example values)', async () => {
    await open([]);
    expect(document.querySelectorAll('tbody tr').length).toBeLessThanOrEqual(1); // at most the empty-state row
  });

  it('filters rows by antibiotic and organism', async () => {
    await open([rowDto(1, { antibiotic_code: 'abx_one' }), rowDto(2, { antibiotic_code: 'abx_two', organism_code: 'org_two' })]);
    const filter = screen.getByRole('textbox', { name: /antibiotic|organism|filter/i });
    await userEvent.type(filter, 'abx_two');
    await waitFor(() => expect(document.body.textContent).not.toContain('abx_one'));
    expect(document.body.textContent).toContain('abx_two');
  });
});

describe('available actions per status (AC-13.5; §6.2) and permission gating', () => {
  const names = () => ['Activate', 'Retire', 'Discard'].filter((n) => btn(new RegExp(`^${n}$`, 'i')));
  it.each([
    ['uploaded', ['Discard']], ['validating', []], ['validated', ['Activate', 'Discard']], ['invalid', ['Discard']],
    ['active', ['Retire']], ['retired', []], ['discarded', []],
  ])('status %s offers %j', async (status, expected) => {
    await show({ set: { status } });
    expect(names()).toEqual(expected);
  });
  it('without micro.breakpoint.manage no action buttons are shown', async () => {
    await show({ set: { status: 'validated' }, permissions: PERM_READ_ONLY });
    expect(names()).toEqual([]);
  });
  it('one primary button at most (LD-140)', async () => {
    await show({ set: { status: 'validated' } });
    expect(document.querySelectorAll('button.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });
});

describe('activate (AC-13.1, AC-13.2; four-eyes copy)', () => {
  it('confirm dialog explains that the current standard table stops, has "Start using from", and POSTs with If-Match "<version>"', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets/${ID(1)}/activate`, () => HttpResponse.json(setDto({ status: 'active', version: 3 }))));
    await show({ set: { status: 'validated', version: 2, standard: 'EUCAST' } });
    await userEvent.click(btn(/^activate$/i)!);
    const d = screen.getByRole('dialog');
    expect(d.textContent).toContain('The current EUCAST table will stop being used from this time.');
    expect(within(d).getByText(/start using from/i)).toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(hit('POST', /\/activate$/)).toHaveLength(1));
    expect(hit('POST', /\/activate$/)[0]!.headers.get('if-match')).toBe('"2"');
    await waitFor(() => expect(router.refresh.mock.calls.length + router.push.mock.calls.length).toBeGreaterThan(0));
  });

  it('importer activating → 403 micro.breakpoint_four_eyes_required shows "Another user must activate a table you imported." and the set stays validated', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets/${ID(1)}/activate`, () => problem('micro.breakpoint_four_eyes_required', 403)));
    await show({ set: { status: 'validated' } });
    await userEvent.click(btn(/^activate$/i)!);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(document.body.textContent).toContain('Another user must activate a table you imported.'));
    expect(document.body.textContent).not.toMatch(/micro\.breakpoint_four_eyes_required/);
    expect(document.body.textContent).toContain('Ready to activate');
  });

  it('invalid transition (race with another user) → §10 copy', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets/${ID(1)}/activate`, () => problem('micro.breakpoint_set_invalid_transition', 409)));
    await show({ set: { status: 'validated' } });
    await userEvent.click(btn(/^activate$/i)!);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(document.body.textContent).toContain("This table can't change to that state."));
  });

  it('stale version → common.version_conflict shows the kit default copy', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets/${ID(1)}/activate`, () => problem('common.version_conflict', 412)));
    await show({ set: { status: 'validated' } });
    await userEvent.click(btn(/^activate$/i)!);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(document.body.textContent).toContain('Someone else changed this. Reload and try again.'));
  });

  it('double click sends one activation', async () => {
    let n = 0;
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets/${ID(1)}/activate`, async () => { n += 1; await new Promise((r) => setTimeout(r, 150)); return HttpResponse.json(setDto({ status: 'active', version: 3 })); }));
    await show({ set: { status: 'validated' } });
    await userEvent.click(btn(/^activate$/i)!);
    await userEvent.dblClick(within(screen.getByRole('dialog')).getByRole('button', { name: /^activate$/i }));
    await waitFor(() => expect(n).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 300));
    expect(n).toBe(1);
  });
});

describe('retire and discard (AC-13.3, AC-13.5)', () => {
  it('Retire uses a danger ConfirmDialog and POSTs /retire with If-Match', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets/${ID(1)}/retire`, () => HttpResponse.json(setDto({ status: 'retired', version: 4 }))));
    await show({ set: { status: 'active', version: 3 } });
    await userEvent.click(btn(/^retire$/i)!);
    const d = screen.getByRole('dialog');
    expect(d.querySelector('.lims-btn-danger'), 'confirm button is the danger variant').toBeTruthy();
    await userEvent.click(within(d).getByRole('button', { name: /^retire$/i }));
    await waitFor(() => expect(hit('POST', /\/retire$/)).toHaveLength(1));
    expect(hit('POST', /\/retire$/)[0]!.headers.get('if-match')).toBe('"3"');
  });

  it('Discard POSTs /discard with If-Match and leaves the detail', async () => {
    api.use(http.post(`${ORIGIN}/v1/micro/breakpoint-sets/${ID(1)}/discard`, () => HttpResponse.json(setDto({ status: 'discarded', version: 3 }))));
    await show({ set: { status: 'invalid', version: 2 } });
    await userEvent.click(btn(/^discard$/i)!);
    const d = screen.queryByRole('dialog');
    if (d) await userEvent.click(within(d).getByRole('button', { name: /^discard$/i }));
    await waitFor(() => expect(hit('POST', /\/discard$/)).toHaveLength(1));
    expect(hit('POST', /\/discard$/)[0]!.headers.get('if-match')).toBe('"2"');
  });

  it('cancelling the confirm dialog sends no request', async () => {
    await show({ set: { status: 'active' } });
    await userEvent.click(btn(/^retire$/i)!);
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /cancel/i }));
    expect(hits.filter((h) => h.method === 'POST')).toHaveLength(0);
  });
});
