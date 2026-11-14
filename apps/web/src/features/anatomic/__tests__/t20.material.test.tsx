// @vitest-environment jsdom
// C11.T-20 — Case workspace "Blocks & slides" and "Stains" tabs (04-UI-UX §2 error mapping, §3 Alt+L, §4.2.3, §4.2.4, §8; AC-13.3 entry points; AC-06.1/06.5 UI side; REQ-SEC-081/088/100).
// LD-140 (2026-11-13): kit components only, one primary button per page, every status shows tone + icon + word.
// ASSUMED (t20.harness.tsx header): the tabs are reached through the T-19 CaseWorkspace seam by their tab names; dialogs have role=dialog and fields are found by visible label;
//   Select = kit Select (button + role=option); DataTable selection = one checkbox per row (kit); mutations are server actions to the real API paths with Idempotency-Key (required by the contract)
//   and If-Match "<version>" where the contract has it; after a successful write the page calls router.refresh().
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ID, ORIGIN, PERM_READ, PERM_WORK, api, block, hit, problem, resetHits, router, slide, stainOrder, t20Defaults, workedCase } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); api.use(...t20Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (d: Record<string, unknown> = workedCase(), permissions = PERM_WORK) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  return render(<ToastProvider><CaseWorkspace detail={d as never} permissions={permissions} templates={[]} /></ToastProvider>);
};
const tab = (name: RegExp) => userEvent.click(screen.getByRole('tab', { name }));
const dialog = () => screen.getByRole('dialog');
const row = (re: RegExp) => screen.getAllByRole('row').find((r) => re.test(r.textContent ?? ''))!;
const tick = (re: RegExp) => userEvent.click(within(row(re)).getByRole('checkbox'));
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const choose = async (scope: HTMLElement, label: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: label }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};
const posts = (re: RegExp) => hit('POST', re);
const text = () => document.body.textContent ?? '';

describe('Blocks & slides tab (§4.2.3)', () => {
  it('Alt+B / the tab shows two tables: Blocks (Label, Part, Slides, Location, Note) and Slides (Label, Source, Stain, Status, Location, Assessment-only-for-cytology)', async () => {
    await mount();
    await tab(/^blocks & slides$/i);
    const [blocks, slides] = screen.getAllByRole('grid');
    for (const h of ['Label', 'Part', 'Slides', 'Location', 'Note']) expect(within(blocks!).getByRole('columnheader', { name: new RegExp(`^${h}`) }), h).toBeTruthy();
    for (const h of ['Label', 'Source', 'Stain', 'Status', 'Location']) expect(within(slides!).getByRole('columnheader', { name: new RegExp(`^${h}`) }), h).toBeTruthy();
    expect(within(slides!).queryByRole('columnheader', { name: /^assessment/i })).toBeNull(); // histology: no assessment column
  });

  it('block rows: label, "Part A", slide count, location status + text; slide rows: source (block label), stain, status words "Ready" / "Pending stain" with tone + icon', async () => {
    await mount(workedCase({ blocks: [block(1, { slide_count: 2, location_status: 'stored', location_text: 'Synthetic cabinet 7', note: 'Synthetic note' })] }));
    await tab(/^blocks & slides$/i);
    const b = row(/SP26-000042-A1\b(?!-S)/).textContent!;
    expect(b).toMatch(/Part A/);
    expect(b).toMatch(/Stored/);
    expect(b).toContain('Synthetic cabinet 7');
    expect(b).toContain('Synthetic note');
    const s = row(/-S2/);
    expect(s.textContent).toContain('Pending stain');
    expect(s.textContent).toContain('SP26-000042-A1'); // source block label
    expect(s.querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]')).toBeTruthy();
    expect(row(/-S1/).textContent).toContain('Ready');
  });

  it('empty: "No blocks yet. Add blocks after grossing." and "No slides yet."', async () => {
    await mount(workedCase({ blocks: [], slides: [] }));
    await tab(/^blocks & slides$/i);
    expect(text()).toContain('No blocks yet. Add blocks after grossing.');
    expect(text()).toContain('No slides yet.');
  });

  it('server text (notes, locations) renders as text, never HTML (REQ-SEC-088)', async () => {
    await mount(workedCase({ blocks: [block(1, { note: '<img src=x onerror=alert(1)>', location_text: '<script>alert(2)</script>', location_status: 'stored' })] }));
    await tab(/^blocks & slides$/i);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(text()).toContain('<script>alert(2)</script>');
  });

  describe('[Add blocks]', () => {
    const open = async () => { await mount(); await tab(/^blocks & slides$/i); await userEvent.click(btn(/^add blocks$/i)); return dialog(); };

    it('Dialog: Part (required Select), Count (1-50, default 1), Note (<=200)', async () => {
      const d = await open();
      expect(within(d).getByRole('button', { name: /^part/i })).toBeTruthy();
      expect((within(d).getByLabelText(/count/i) as HTMLInputElement).value).toBe('1');
      expect(within(d).getByLabelText(/note/i).getAttribute('maxlength')).toBe('200');
      expect(d.textContent).toMatch(/\(required\)|required/i);
    });

    it('POST /cases/{id}/blocks {part_id, count, note} with an Idempotency-Key; refreshes the page', async () => {
      const d = await open();
      await choose(d, /^part/i, /^A\b|part a/i);
      await userEvent.clear(within(d).getByLabelText(/count/i));
      await userEvent.type(within(d).getByLabelText(/count/i), '3');
      await userEvent.type(within(d).getByLabelText(/note/i), 'Synthetic note');
      await userEvent.click(btn(/^(add|save|create)/i, d));
      await waitFor(() => expect(posts(/\/cases\/[^/]+\/blocks$/)).toHaveLength(1));
      const p = posts(/\/cases\/[^/]+\/blocks$/)[0]!;
      expect(p.path).toBe(`/v1/anatomic/cases/${ID(1)}/blocks`);
      expect(p.json).toEqual({ part_id: ID(101), count: 3, note: 'Synthetic note' });
      expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
      await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    });

    it('no part chosen -> no request; count 0 / 51 -> no request (client-side hints; the API re-checks)', async () => {
      const d = await open();
      await userEvent.click(btn(/^(add|save|create)/i, d));
      expect(posts(/\/blocks$/)).toHaveLength(0);
      await choose(d, /^part/i, /^A\b|part a/i);
      for (const bad of ['0', '51']) {
        await userEvent.clear(within(d).getByLabelText(/count/i));
        await userEvent.type(within(d).getByLabelText(/count/i), bad);
        await userEvent.click(btn(/^(add|save|create)/i, d));
        expect(posts(/\/blocks$/)).toHaveLength(0);
      }
    });

    it('anatomic.signout_locked / case_invalid_transition are shown with the §8 copy', async () => {
      api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/blocks`, () => problem('anatomic.case_invalid_transition', 409)));
      const d = await open();
      await choose(d, /^part/i, /^A\b|part a/i);
      await userEvent.click(btn(/^(add|save|create)/i, d));
      expect(await screen.findByText(/That step isn.t possible for a case in status in_processing\./)).toBeTruthy();
    });

    it('a user without anatomic.case.work has no [Add blocks] (read-only values only)', async () => {
      await mount(workedCase(), PERM_READ);
      await tab(/^blocks & slides$/i);
      expect(screen.queryByRole('button', { name: /^add blocks$/i })).toBeNull();
      expect(screen.queryByRole('checkbox')).toBeNull();
      expect(text()).toContain('SP26-000042-A1');
    });
  });

  describe('[Add slides] (one block selected)', () => {
    it('disabled with 0 or 2 blocks selected, enabled with exactly 1', async () => {
      await mount();
      await tab(/^blocks & slides$/i);
      const add = () => btn(/^add slides$/i);
      expect(add().disabled).toBe(true);
      await tick(/SP26-000042-A1\b(?!-S)/);
      expect(add().disabled).toBe(false);
      await tick(/SP26-000042-A2\b/);
      expect(add().disabled).toBe(true);
    });

    it('Dialog Stain + Count (default 1): POST /cases/{id}/slides {block_id, stain_code, count}, no part_id (exactly one of block_id / part_id)', async () => {
      await mount();
      await tab(/^blocks & slides$/i);
      await tick(/SP26-000042-A2\b/);
      await userEvent.click(btn(/^add slides$/i));
      const d = dialog();
      expect((within(d).getByLabelText(/count/i) as HTMLInputElement).value).toBe('1');
      await choose(d, /^stain/i, /Synthetic HE/);
      await userEvent.clear(within(d).getByLabelText(/count/i));
      await userEvent.type(within(d).getByLabelText(/count/i), '4');
      await userEvent.click(btn(/^(add|save|create)/i, d));
      await waitFor(() => expect(posts(/\/cases\/[^/]+\/slides$/)).toHaveLength(1));
      const p = posts(/\/slides$/)[0]!;
      expect(p.json).toEqual({ block_id: ID(202), stain_code: 'HE', count: 4 });
      expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    });

    it('409 anatomic.block_not_available -> "This block is sent out or discarded."', async () => {
      api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/slides`, () => problem('anatomic.block_not_available', 409)));
      await mount();
      await tab(/^blocks & slides$/i);
      await tick(/SP26-000042-A2\b/);
      await userEvent.click(btn(/^add slides$/i));
      await choose(dialog(), /^stain/i, /Synthetic HE/);
      await userEvent.click(btn(/^(add|save|create)/i, dialog()));
      expect(await screen.findByText('This block is sent out or discarded.')).toBeTruthy();
    });
  });

  describe('slides: [Mark ready] (bulk), [Record movement], [Print labels]', () => {
    it('[Mark ready] posts the selected slide ids and toasts "{n} slides marked ready, {m} skipped"', async () => {
      api.use(http.post(`${ORIGIN}/v1/anatomic/slides/bulk-mark-ready`, async ({ request }) => {
        const b = (await request.clone().json()) as { ids: string[] };
        return HttpResponse.json({ results: [{ id: b.ids[0], outcome: 'updated' }, { id: b.ids[1], outcome: 'invalid_state' }] });
      }));
      await mount();
      await tab(/^blocks & slides$/i);
      await tick(/-S1/);
      await tick(/-S2/);
      await userEvent.click(btn(/^mark ready$/i));
      await waitFor(() => expect(posts(/bulk-mark-ready$/)).toHaveLength(1));
      const p = posts(/bulk-mark-ready$/)[0]!;
      expect(p.json).toEqual({ ids: [ID(301), ID(302)] });
      expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
      expect(await screen.findByText(/1 slides? marked ready, 1 skipped/i)).toBeTruthy();
      await userEvent.click(screen.getByRole('button', { name: /skipped|details|view/i })); // skipped reasons in a Drawer
      expect(await screen.findByRole('dialog')).toBeTruthy();
      expect(within(screen.getByRole('dialog')).getByText(/-S2/, { exact: false })).toBeTruthy();
    });

    it('[Mark ready] is disabled with no slide selected', async () => {
      await mount();
      await tab(/^blocks & slides$/i);
      expect(btn(/^mark ready$/i).disabled).toBe(true);
    });

    it('[Record movement] on selected blocks opens the §4.4 dialog listing them and posts object_kind block', async () => {
      await mount();
      await tab(/^blocks & slides$/i);
      await tick(/SP26-000042-A1\b(?!-S)/);
      await tick(/SP26-000042-A3\b/);
      const moves = screen.getAllByRole('button', { name: /^record movement$/i });
      await userEvent.click(moves[0]!);
      const d = dialog();
      expect(d.textContent).toContain('SP26-000042-A1');
      expect(d.textContent).toContain('SP26-000042-A3');
      await userEvent.click(within(d).getByRole('radio', { name: /^retrieve$/i }));
      await userEvent.click(btn(/^(record|save|submit|confirm)/i, d));
      await waitFor(() => expect(posts(/\/movements$/)).toHaveLength(1));
      expect(posts(/\/movements$/)[0]!.json).toEqual({ object_kind: 'block', object_ids: [ID(201), ID(203)], movement: 'retrieved' });
    });

    it('[Print labels] with blocks selected goes to the labels page with kind=blocks and the selected ids; with none selected, no ids (all)', async () => {
      await mount();
      await tab(/^blocks & slides$/i);
      const print = () => screen.getAllByRole('button', { name: /^print labels$/i })[0]!;
      await userEvent.click(print());
      let u = new URL(router.push.mock.calls.at(-1)![0] as string, 'http://x');
      expect(u.pathname).toBe(`/anatomic/cases/${ID(1)}/labels`);
      expect(u.searchParams.get('kind')).toBe('blocks');
      expect(u.searchParams.has('ids')).toBe(false);
      await tick(/SP26-000042-A2\b/);
      await userEvent.click(print());
      u = new URL(router.push.mock.calls.at(-1)![0] as string, 'http://x');
      expect(u.searchParams.get('ids')).toBe(ID(202));
    });

    it('Alt+L opens the labels page (blocks); Alt+S/Alt+U/Alt+L are Alt+<letter> only', async () => {
      const { shortcuts } = await import('@/core/shortcuts/registry');
      await mount();
      const s = shortcuts.list('staff.anatomic.case').find((x) => x.key === 'Alt+L');
      expect(s, 'Alt+L registered').toBeTruthy();
      act(() => s!.run());
      expect(router.push).toHaveBeenCalledWith(`/anatomic/cases/${ID(1)}/labels?kind=blocks`);
    });

    it('selection is capped at the bulk limit of 200 (REQ-SEC-100): the kit max is passed through (no more than 200 ids can be sent)', async () => {
      const many = Array.from({ length: 205 }, (_, i) => block(i + 1, { id: ID(1000 + i), label: `SP26-000042-B${i + 1}` }));
      await mount(workedCase({ blocks: many, slides: [] }));
      await tab(/^blocks & slides$/i);
      const [all] = screen.getAllByRole('checkbox');
      await userEvent.click(all!); // select all
      await userEvent.click(screen.getAllByRole('button', { name: /^record movement$/i })[0]!);
      await userEvent.click(within(dialog()).getByRole('radio', { name: /^retrieve$/i }));
      await userEvent.click(btn(/^(record|save|submit|confirm)/i, dialog()));
      await waitFor(() => expect(posts(/\/movements$/).length).toBeGreaterThan(0));
      for (const p of posts(/\/movements$/)) expect((p.json as { object_ids: string[] }).object_ids.length).toBeLessThanOrEqual(200);
    });
  });

  describe('cytology (slides without blocks; assessment)', () => {
    const cyto = () => workedCase({
      case_kind: 'cytology', blocks: [],
      slides: [slide(1, { block_id: undefined, part_id: ID(101), adequacy_code: 'SATISF', finding_text: 'Synthetic finding', include_in_report: true })],
    });

    it('[Add slides from part] (Part, Stain, Count) posts part_id (not block_id)', async () => {
      await mount(cyto());
      await tab(/^blocks & slides$/i);
      await userEvent.click(btn(/^add slides from part$/i));
      const d = dialog();
      await choose(d, /^part/i, /^A\b|part a/i);
      await choose(d, /^stain/i, /Synthetic HE/);
      await userEvent.click(btn(/^(add|save|create)/i, d));
      await waitFor(() => expect(posts(/\/slides$/)).toHaveLength(1));
      expect(posts(/\/slides$/)[0]!.json).toEqual({ part_id: ID(101), stain_code: 'HE', count: 1 });
    });

    it('Assessment column shows adequacy + an "In report" badge; the row opens a Drawer "Assessment — {slide label}"', async () => {
      await mount(cyto());
      await tab(/^blocks & slides$/i);
      const r = row(/SP26-000042-A1-S1/);
      expect(r.textContent).toMatch(/Satisfactory|SATISF/);
      expect(r.textContent).toContain('In report');
      expect(r.textContent).toContain('Part A'); // source of a block-less slide
      await userEvent.click(within(r).getByRole('button', { name: /assess|assessment|edit/i }));
      const d = await screen.findByRole('dialog');
      expect(d.textContent).toContain('Assessment — SP26-000042-A1-S1');
      expect((within(d).getByLabelText(/finding/i) as HTMLTextAreaElement).value).toBe('Synthetic finding');
      expect(within(d).getByLabelText(/finding/i).getAttribute('maxlength')).toBe('2000');
      expect((within(d).getByRole('checkbox', { name: /include in report/i }) as HTMLInputElement).checked).toBe(true);
    });

    it('Save: PUT /slides/{id}/assessment with If-Match "<version>" and {adequacy_code, finding_text, include_in_report}', async () => {
      await mount(cyto());
      await tab(/^blocks & slides$/i);
      await userEvent.click(within(row(/SP26-000042-A1-S1/)).getByRole('button', { name: /assess|assessment|edit/i }));
      const d = await screen.findByRole('dialog');
      await userEvent.clear(within(d).getByLabelText(/finding/i));
      await userEvent.type(within(d).getByLabelText(/finding/i), 'Synthetic new finding');
      await userEvent.click(within(d).getByRole('checkbox', { name: /include in report/i }));
      await userEvent.click(btn(/^save$/i, d));
      await waitFor(() => expect(hit('PUT', /\/slides\/[^/]+\/assessment$/)).toHaveLength(1));
      const p = hit('PUT', /assessment$/)[0]!;
      expect(p.path).toBe(`/v1/anatomic/slides/${ID(301)}/assessment`);
      expect(p.headers.get('if-match')).toBe('"1"');
      expect(p.json).toEqual({ adequacy_code: 'SATISF', finding_text: 'Synthetic new finding', include_in_report: false });
    });

    it('409 common.version_conflict -> the "changed by someone else" banner with [Reload]', async () => {
      api.use(http.put(`${ORIGIN}/v1/anatomic/slides/:id/assessment`, () => problem('common.version_conflict', 409)));
      await mount(cyto());
      await tab(/^blocks & slides$/i);
      await userEvent.click(within(row(/SP26-000042-A1-S1/)).getByRole('button', { name: /assess|assessment|edit/i }));
      await userEvent.click(btn(/^save$/i, await screen.findByRole('dialog')));
      expect(await screen.findByText('This case was changed by someone else. Reload to see the latest version.')).toBeTruthy();
    });
  });

  it('axe: Blocks & slides tab and the Add blocks dialog have no violations', async () => {
    await mount();
    await tab(/^blocks & slides$/i);
    const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(await run()).toEqual([]);
    await userEvent.click(btn(/^add blocks$/i));
    expect(await run()).toEqual([]);
  });

  it('one primary button on the page with this tab open (LD-140)', async () => {
    await mount();
    await tab(/^blocks & slides$/i);
    expect(screen.getAllByRole('grid')).toHaveLength(2); // the tab really rendered (not the T-19 placeholder)
    expect(document.querySelectorAll('.lims-btn-primary').length).toBeLessThanOrEqual(1);
  });
});

describe('Stains tab (§4.2.4)', () => {
  const stainsCase = (over: Record<string, unknown> = {}) => workedCase({
    stain_orders: [
      stainOrder(1, { stain_display: 'Periodic acid-Schiff', stain_kind: 'special', status: 'requested', note: 'Synthetic note' }),
      stainOrder(2, { stain_code: 'CK7', stain_display: 'Cytokeratin 7', stain_kind: 'ihc', status: 'in_progress', block_id: ID(202), block_label: 'SP26-000042-A2', reagent_lot: 'LOT-SYN-1', addon_order_item_id: ID(12) }),
      stainOrder(3, { stain_display: 'Congo red', part_id: ID(101), block_id: undefined, block_label: undefined, status: 'completed', completed_at: '2026-11-11T07:00:00.000Z' }),
    ],
    items: [
      { case_item_id: ID(10), order_item_id: ID(11), test_id: ID(12), test_name: 'Synthetic biopsy', role: 'primary', is_active: true, lab_status: 'pending' },
      { case_item_id: ID(13), order_item_id: ID(14), test_id: ID(15), test_name: 'Synthetic IHC add-on', role: 'addon', is_active: true },
      { case_item_id: ID(16), order_item_id: ID(12), test_id: ID(17), test_name: 'Synthetic linked add-on', role: 'addon', is_active: true },
    ],
    ...over,
  });
  const open = async (d = stainsCase()) => { await mount(d); await tab(/^stains$/i); };

  it('columns Stain, On, Status, Requested, Lot, Add-on + a row-actions menu', async () => {
    await open();
    const g = screen.getByRole('grid');
    for (const h of ['Stain', 'On', 'Status', 'Requested', 'Lot', 'Add-on']) expect(within(g).getByRole('columnheader', { name: new RegExp(`^${h}`) }), h).toBeTruthy();
    expect(within(g).getAllByRole('button', { name: /row actions/i }).length).toBe(3);
  });

  it('rows: stain display + kind badge (Special / IHC), On = block label or "Part A", status word with tone + icon, lot, add-on test name or "—"', async () => {
    await open();
    const pas = row(/Periodic acid-Schiff/).textContent!;
    expect(pas).toContain('Special');
    expect(pas).toContain('SP26-000042-A1');
    expect(pas).toMatch(/Requested/);
    expect(pas).toContain('—');
    const ck = row(/Cytokeratin 7/).textContent!;
    expect(ck).toContain('IHC');
    expect(ck).toContain('LOT-SYN-1');
    expect(ck).toContain('Synthetic linked add-on');
    expect(ck).toMatch(/In progress/);
    expect(row(/Congo red/).textContent).toContain('Part A');
    expect(row(/Congo red/).textContent).toMatch(/Completed/);
    expect(row(/Periodic/).querySelector('[data-tone] svg, [data-tone] [aria-hidden=true]')).toBeTruthy();
  });

  it('empty: "No special stains or IHC ordered."', async () => {
    await open(stainsCase({ stain_orders: [] }));
    expect(text()).toContain('No special stains or IHC ordered.');
  });

  describe('row actions', () => {
    const act1 = async (rowRe: RegExp, item: RegExp) => {
      await userEvent.click(within(row(rowRe)).getByRole('button', { name: /row actions/i }));
      await userEvent.click(await screen.findByRole('menuitem', { name: item }));
    };

    it('Start: POST /stain-orders/{id}/start with If-Match "<version>" and an Idempotency-Key', async () => {
      await open();
      await act1(/Periodic/, /^start$/i);
      await waitFor(() => expect(posts(/\/start$/)).toHaveLength(1));
      const p = posts(/\/start$/)[0]!;
      expect(p.path).toBe(`/v1/anatomic/stain-orders/${ID(401)}/start`);
      expect(p.headers.get('if-match')).toBe('"1"');
      expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
      await waitFor(() => expect(router.refresh).toHaveBeenCalled());
    });

    it('only valid actions are offered: completed/cancelled orders have none; requested has Start+Cancel; in progress has Complete+Cancel', async () => {
      await open();
      const items = async (rowRe: RegExp) => {
        const b = within(row(rowRe)).queryByRole('button', { name: /row actions/i });
        if (!b || (b as HTMLButtonElement).disabled) return [];
        await userEvent.click(b);
        const names = (await screen.findAllByRole('menuitem')).map((m) => m.textContent!.trim());
        await userEvent.keyboard('{Escape}');
        return names;
      };
      expect(await items(/Periodic/)).toEqual(expect.arrayContaining(['Start', 'Cancel']));
      expect(await items(/Cytokeratin/)).toEqual(expect.arrayContaining(['Complete', 'Cancel']));
      expect(await items(/Congo red/)).not.toEqual(expect.arrayContaining(['Start']));
    });

    it('Complete dialog: Slides made (default 1, 1-20), Reagent lot (<=64), Performed at (not in the future) -> POST /complete {slide_count, reagent_lot, performed_at?}', async () => {
      await open();
      await act1(/Cytokeratin/, /^complete$/i);
      const d = dialog();
      expect((within(d).getByLabelText(/slides made/i) as HTMLInputElement).value).toBe('1');
      expect(within(d).getByLabelText(/reagent lot/i).getAttribute('maxlength')).toBe('64');
      await userEvent.clear(within(d).getByLabelText(/slides made/i));
      await userEvent.type(within(d).getByLabelText(/slides made/i), '2');
      await userEvent.type(within(d).getByLabelText(/reagent lot/i), 'LOT-SYN-2');
      await userEvent.click(btn(/^(complete|save|confirm)/i, d));
      await waitFor(() => expect(posts(/\/complete$/)).toHaveLength(1));
      const p = posts(/\/complete$/)[0]!;
      expect(p.path).toBe(`/v1/anatomic/stain-orders/${ID(402)}/complete`);
      expect(p.headers.get('if-match')).toBe('"1"');
      expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
      expect(p.json).toMatchObject({ slide_count: 2, reagent_lot: 'LOT-SYN-2' });
      if ((p.json as { performed_at?: string }).performed_at) expect(Date.parse((p.json as { performed_at: string }).performed_at)).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('Complete with slides made 0 or 21 sends nothing', async () => {
      await open();
      await act1(/Cytokeratin/, /^complete$/i);
      const d = dialog();
      for (const bad of ['0', '21']) {
        await userEvent.clear(within(d).getByLabelText(/slides made/i));
        await userEvent.type(within(d).getByLabelText(/slides made/i), bad);
        await userEvent.click(btn(/^(complete|save|confirm)/i, d));
        expect(posts(/\/complete$/)).toHaveLength(0);
      }
    });

    it('Complete: 409 anatomic.block_not_available (block sent out) -> "This block is sent out or discarded."', async () => {
      api.use(http.post(`${ORIGIN}/v1/anatomic/stain-orders/:id/complete`, () => problem('anatomic.block_not_available', 409)));
      await open();
      await act1(/Cytokeratin/, /^complete$/i);
      await userEvent.click(btn(/^(complete|save|confirm)/i, dialog()));
      expect(await screen.findByText('This block is sent out or discarded.')).toBeTruthy();
    });

    it('Cancel: ConfirmDialog needs a free-text reason (<=500); empty sends nothing; then POST /cancel {reason_text}', async () => {
      await open();
      await act1(/Periodic/, /^cancel$/i);
      const d = await screen.findByRole('dialog'); // kit ConfirmDialog = kit Dialog (role dialog); ruling T-20
      await userEvent.click(btn(/^(cancel stain|confirm|yes|cancel order)/i, d));
      expect(posts(/\/cancel$/)).toHaveLength(0);
      expect(within(d).getByLabelText(/reason/i).getAttribute('maxlength')).toBe('500');
      await userEvent.type(within(d).getByLabelText(/reason/i), 'Synthetic wrong block');
      await userEvent.click(btn(/^(cancel stain|confirm|yes|cancel order)/i, d));
      await waitFor(() => expect(posts(/\/stain-orders\/[^/]+\/cancel$/)).toHaveLength(1));
      const p = posts(/\/cancel$/).find((x) => x.path.includes('stain-orders'))!;
      expect(p.json).toEqual({ reason_text: 'Synthetic wrong block' });
      expect(p.headers.get('if-match')).toBe('"1"');
      expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    });

    it('Link add-on item: offers only unlinked, active add-on items of the order; POST /link-addon {order_item_id}', async () => {
      await open();
      await act1(/Periodic/, /link add-on/i);
      const d = dialog();
      await userEvent.click(within(d).getByRole('button', { name: /add-on|item/i }));
      const opts = (await screen.findAllByRole('option')).map((o) => o.textContent);
      expect(opts.some((o) => /Synthetic IHC add-on/.test(o!))).toBe(true);
      expect(opts.some((o) => /Synthetic linked add-on/.test(o!))).toBe(false); // already linked to another order
      expect(opts.some((o) => /Synthetic biopsy/.test(o!))).toBe(false); // primary item
      await userEvent.click(screen.getByRole('option', { name: /Synthetic IHC add-on/ }));
      await userEvent.click(btn(/^(link|save|confirm)/i, d));
      await waitFor(() => expect(posts(/\/link-addon$/)).toHaveLength(1));
      expect(posts(/\/link-addon$/)[0]!.json).toEqual({ order_item_id: ID(14) });
    });
  });

  describe('[Order stain] dialog', () => {
    const openOrder = async () => { await open(); await userEvent.click(btn(/^order stain$/i)); return dialog(); };

    it('Stain offers special + IHC only (routine stains are not offered)', async () => {
      const d = await openOrder();
      await userEvent.click(within(d).getByRole('button', { name: /^stain/i }));
      const opts = (await screen.findAllByRole('option')).map((o) => o.textContent!);
      expect(opts.join('|')).toMatch(/PAS/);
      expect(opts.join('|')).toMatch(/CK7/);
      expect(opts.join('|')).not.toMatch(/Synthetic HE|\bHE\b/);
    });

    it('Block options: in lab / stored / sent out only; sent-out is labelled "Sent out — complete after return"; discarded blocks are not offered', async () => {
      await open(stainsCase({ blocks: [block(1), block(2, { location_status: 'sent_out' }), block(3, { location_status: 'discarded' }), block(4, { location_status: 'stored' })] }));
      await userEvent.click(btn(/^order stain$/i));
      await userEvent.click(within(dialog()).getByRole('button', { name: /^block/i }));
      const opts = (await screen.findAllByRole('option')).map((o) => o.textContent!);
      expect(opts.some((o) => o.includes('SP26-000042-A1'))).toBe(true);
      expect(opts.some((o) => o.includes('SP26-000042-A2') && o.includes('Sent out — complete after return'))).toBe(true);
      expect(opts.some((o) => o.includes('SP26-000042-A3'))).toBe(false);
      expect(opts.some((o) => o.includes('SP26-000042-A4'))).toBe(true);
    });

    it('IHC without a block: nothing sent, "IHC must be ordered on a block."', async () => {
      const d = await openOrder();
      await choose(d, /^stain/i, /CK7/);
      await userEvent.click(btn(/^(order|save|create)/i, d));
      expect(posts(/\/stain-orders$/)).toHaveLength(0);
      expect(within(dialog()).getByText('IHC must be ordered on a block.')).toBeTruthy();
    });

    it('special stain on a block: POST /cases/{id}/stain-orders {stain_code, block_id, note} + Idempotency-Key', async () => {
      const d = await openOrder();
      await choose(d, /^stain/i, /PAS/);
      await choose(d, /^block/i, /SP26-000042-A1/);
      await userEvent.type(within(d).getByLabelText(/note/i), 'Synthetic note');
      await userEvent.click(btn(/^(order|save|create)/i, d));
      await waitFor(() => expect(posts(/\/stain-orders$/)).toHaveLength(1));
      const p = posts(/\/stain-orders$/)[0]!;
      expect(p.path).toBe(`/v1/anatomic/cases/${ID(1)}/stain-orders`);
      expect(p.json).toEqual({ stain_code: 'PAS', block_id: ID(201), note: 'Synthetic note' });
      expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    });

    it('special stain on a part (no block) is allowed: {stain_code, part_id}', async () => {
      const d = await openOrder();
      await choose(d, /^stain/i, /PAS/);
      await choose(d, /^part/i, /^A\b|part a/i);
      await userEvent.click(btn(/^(order|save|create)/i, d));
      await waitFor(() => expect(posts(/\/stain-orders$/)).toHaveLength(1));
      expect(posts(/\/stain-orders$/)[0]!.json).toEqual({ stain_code: 'PAS', part_id: ID(101) });
    });

    it('note is capped at 500 characters', async () => {
      const d = await openOrder();
      expect(within(d).getByLabelText(/note/i).getAttribute('maxlength')).toBe('500');
    });

    it('API 400 anatomic.ihc_requires_block / 409 anatomic.order_item_inactive use the §8 copy', async () => {
      api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/stain-orders`, () => problem('anatomic.order_item_inactive', 409)));
      const d = await openOrder();
      await choose(d, /^stain/i, /PAS/);
      await choose(d, /^block/i, /SP26-000042-A1/);
      await userEvent.click(btn(/^(order|save|create)/i, d));
      expect(await screen.findByText('A test on this case was removed from the order.')).toBeTruthy();
    });
  });

  it('a user without anatomic.case.work sees the table but no [Order stain] and no row actions', async () => {
    await mount(stainsCase(), PERM_READ);
    await tab(/^stains$/i);
    expect(screen.queryByRole('button', { name: /^order stain$/i })).toBeNull();
    expect(screen.queryAllByRole('button', { name: /row actions/i })).toHaveLength(0);
    expect(text()).toContain('Periodic acid-Schiff');
  });

  it('Alt+T opens this tab (T-19 shortcut) and axe is clean', async () => {
    await open();
    const run = async () => (await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } })).violations.map((x) => `${x.id}: ${x.help}`);
    expect(await run()).toEqual([]);
    await userEvent.click(btn(/^order stain$/i));
    expect(await run()).toEqual([]);
  });
});
