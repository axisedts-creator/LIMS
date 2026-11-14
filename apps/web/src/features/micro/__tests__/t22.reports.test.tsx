// @vitest-environment jsdom
// C10.T-22 — tab "Reports": version list + read-only "View" drawer (04-UI-UX §3.4; AC-09.5 UI side, AC-10.5, AC-10.6, AC-11.5; REQ-SEC-088).
// Real server actions + MSW (M16 getCultureReportVersion). Seam: CultureScreen — see t22.harness.tsx. LD-140: kit only.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { AST_ROW, ORIGIN, PERM_READ, PERM_WORK, VERSION, amending, api, finalCulture, growth, hit, problem, resetHits, router, rowAction, state, summaryDto, useReports, versionDto } from './t22.harness';

vi.mock('next/navigation', async () => (await import('./t22.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t22.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.refresh.mockReset(); state.permissions = PERM_WORK; useReports(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (c: Record<string, unknown> = finalCulture(), permissions = PERM_WORK) => {
  const { CultureScreen } = await import('../components/culture/CultureScreen');
  const r = render(<ToastProvider><CultureScreen culture={c as never} patient={{ name: 'Synthetic Patient One' }} specimen={null} permissions={permissions} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^reports/i }));
  return r;
};
const table = () => screen.findByRole('grid', { name: /report versions|reports/i });
const rowOf = (re: RegExp) => screen.getAllByRole('row').find((r) => re.test(r.textContent ?? ''))!;
const view = async (rowRe: RegExp) => { await rowAction(rowRe, /^view$/i); return screen.findByRole('dialog', { name: /(preliminary|final) report/i }); };

describe('the list (04-UI-UX §3.4)', () => {
  it('columns: Version, Phase, Kind, Outcome, Flag, Critical, Signed by, Signed at, Lab status at submit', async () => {
    await mount();
    const t = await table();
    const heads = within(t).getAllByRole('columnheader').map((h) => h.textContent?.trim().toLowerCase());
    for (const c of ['version', 'phase', 'kind', 'outcome', 'flag', 'critical', 'signed by', 'signed at', 'lab status at submit']) expect(heads.join('|'), c).toContain(c);
  });
  it('one row per version: phase and kind words, outcome display, signer, lab status', async () => {
    await mount();
    await table();
    const p1 = rowOf(/Synthetic Signer 1/);
    expect(p1.textContent).toMatch(/preliminary/i);
    expect(p1.textContent).toMatch(/initial/i);
    const f2 = rowOf(/Synthetic Signer 2/);
    expect(f2.textContent).toMatch(/final/i);
    expect(f2.textContent).toMatch(/update/i);
    expect(f2.textContent).toMatch(/growth — see isolates/i);
    expect(f2.textContent).toMatch(/resulted/i);
  });
  it('an amendment version shows kind "Amendment"', async () => {
    await mount(amending({ report_versions: [summaryDto(1), summaryDto(2, { report_phase: 'final', version_kind: 'amendment', amendment_reason_code: 'module_phase_progression' })] }));
    await table();
    expect(rowOf(/Synthetic Signer 2/).textContent).toMatch(/amendment/i);
  });
  it('Critical shows icon + word "Critical" for a critical version and nothing alarming for the others', async () => {
    await mount(finalCulture({ report_versions: [summaryDto(1, { is_critical: true }), summaryDto(2)] }));
    await table();
    expect(rowOf(/Synthetic Signer 1/).textContent).toMatch(/critical/i);
    expect(rowOf(/Synthetic Signer 2/).textContent).not.toMatch(/critical/i);
  });
  it('no versions: an empty state, no table rows', async () => {
    await mount(growth({ report_versions: [] }));
    expect(document.body.textContent).toMatch(/no report/i);
    expect(screen.queryByRole('row', { name: /synthetic signer/i })).toBeNull();
  });
  it('is read-only: a version has "View" and nothing that edits or deletes it (AC-09.5 in the UI)', async () => {
    await mount();
    await table();
    const row = rowOf(/Synthetic Signer 1/);
    const direct = within(row).queryAllByRole('button');
    if (direct.length && !direct.some((b) => /^view$/i.test(b.textContent ?? ''))) await userEvent.click(direct[direct.length - 1]!);
    const names = [...within(row).queryAllByRole('button'), ...screen.queryAllByRole('menuitem')].map((e) => e.textContent?.trim().toLowerCase());
    expect(names.join('|')).toMatch(/view/);
    expect(names.join('|')).not.toMatch(/edit|delete|remove|change|void/);
  });
  it('a read-only user (micro.culture.read) can open the tab and View, but sees no compose or reopen buttons', async () => {
    await mount(finalCulture(), PERM_READ);
    await table();
    expect(screen.queryByRole('button', { name: /reopen for amendment|preliminary report|final report/i })).toBeNull();
    await view(/Synthetic Signer 1/);
    expect(hit('GET', VERSION)).toHaveLength(1);
  });
});

describe('the View drawer (AC-11.5: previous versions stay readable; AC-10.5 snapshot content)', () => {
  it('GET /report-versions/{version_no} for the clicked row; Drawer named "Preliminary report" / "Final report" with NO submit button', async () => {
    await mount();
    await table();
    const d = await view(/Synthetic Signer 1/);
    expect(hit('GET', VERSION).at(-1)!.path).toMatch(/\/report-versions\/1$/);
    expect(d.getAttribute('aria-label') ?? d.textContent).toMatch(/preliminary report/i);
    expect(within(d).queryByRole('button', { name: /send for verification/i })).toBeNull();
    expect(within(d).queryByRole('textbox')).toBeNull();
    cleanup();
    await mount();
    await table();
    const d2 = await view(/Synthetic Signer 2/);
    expect(hit('GET', VERSION).at(-1)!.path).toMatch(/\/report-versions\/2$/);
    expect(d2.textContent).toMatch(/final report/i);
  });
  it('shows the summary text, the isolates table and the AST table with method units, standard and version', async () => {
    await mount();
    await table();
    const d = await view(/Synthetic Signer 1/);
    expect(d.textContent).toContain('Synthetic summary for version 1');
    expect(d.textContent).toContain('second line');
    expect(d.textContent).toContain('Synthetic organism');
    expect(d.textContent).toContain('≥10^5 CFU/mL');
    const cef = within(d).getAllByRole('row').find((r) => /Synthetic cefA/.test(r.textContent ?? ''))!;
    expect(cef.textContent).toMatch(/<=0\.25/);
    expect(cef.textContent).toMatch(/mg\/L/);
    expect(cef.textContent).toMatch(/CLSI/);
    expect(cef.textContent).toMatch(/M100-Ed36/);
    const gen = within(d).getAllByRole('row').find((r) => /Synthetic genB/.test(r.textContent ?? ''))!;
    expect(gen.textContent).toMatch(/\bmm\b/);
  });
  it('shows comments and the early-final reason when the version has them; an amendment shows its reason text', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id/report-versions/:n`, () => HttpResponse.json(versionDto(2, { report_phase: 'final', version_kind: 'amendment', amendment_reason_code: 'syn_transcription_error', amendment_reason_text: 'Synthetic wrong isolate number', comments_text: 'Synthetic comment', early_final_reason: 'Synthetic early reason' }))));
    await mount();
    await table();
    const d = await view(/Synthetic Signer 2/);
    for (const t of ['Synthetic comment', 'Synthetic early reason', 'Synthetic wrong isolate number']) expect(d.textContent, t).toContain(t);
  });
  it('after the culture is reopened, version 1 and 2 are still viewable (amending)', async () => {
    await mount(amending());
    await table();
    await view(/Synthetic Signer 1/);
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /(preliminary|final) report/i })).toBeNull());
    await view(/Synthetic Signer 2/);
    expect(hit('GET', VERSION)).toHaveLength(2);
  });
  it('server text is rendered as text, never HTML (REQ-SEC-088)', async () => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id/report-versions/:n`, () => HttpResponse.json(versionDto(1, {
      culture_summary_text: '<img src=x onerror=alert(1)>Synthetic', comments_text: '<script>alert(2)</script>',
      isolates: [{ seq: 1, organism_code: 'x', organism_display: '<b>Synthetic bold</b>', growth_text: '<i>g</i>' }], ast: [AST_ROW(1, 'a', '<u>Synthetic abx</u>')],
    }))));
    await mount();
    await table();
    const d = await view(/Synthetic Signer 1/);
    expect(d.querySelector('img, script, b, i, u')).toBeNull();
    expect(d.textContent).toContain('<img src=x onerror=alert(1)>Synthetic');
    expect(d.textContent).toContain('<b>Synthetic bold</b>');
  });
  it.each([[404, 'common.not_found'], [403, 'auth.forbidden'], [500, 'common.internal']])('API %i: the drawer explains it in plain words, no raw code, no stack', async (status, c) => {
    api.use(http.get(`${ORIGIN}/v1/micro/cultures/:id/report-versions/:n`, () => problem(c, status)));
    await mount();
    await table();
    await rowAction(/Synthetic Signer 1/, /^view$/i);
    const d = await screen.findByRole('dialog');
    await waitFor(() => expect(d.textContent).toMatch(/something went wrong|permission|not found|try again/i));
    expect(document.body.textContent).not.toContain(c);
  });
  it('the list and the drawer are accessible (axe)', async () => {
    await mount();
    await table();
    const run = async (el: HTMLElement) => (await axe.run(el, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(await run(document.body)).toEqual([]);
    const d = await view(/Synthetic Signer 1/);
    expect(await run(d)).toEqual([]);
  });
});
