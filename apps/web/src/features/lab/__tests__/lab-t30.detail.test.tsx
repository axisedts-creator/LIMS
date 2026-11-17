// @vitest-environment jsdom
// C5.T-30 — Specimen detail screen `/lab/specimens/{specimen_id}` (04-UI-UX §3.14, 03-APP-FLOW §3.14, 02-TRD §5.1 #3/#9–#13, 02-TRD §4 S5/S11–S14, 08 A13 D-15).
// done_when: "actions shown per state and permission". Component level; the BFF actions are mocked. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + copy only; raise a dispute to rename):
//   components/specimens/SpecimenDetail.tsx  export SpecimenDetail({ specimen, rejectionReasons, recollectionDefault, permissions })
//        specimen: SpecimenDetailDto (lab.yaml, as served by GET /v1/lab/specimens/{id})   rejectionReasons: {code, display}[]   recollectionDefault: boolean   permissions: string[]
//   Mutations go through SERVER ACTIONS in server/actions.ts (JWT stays on the server, REQ-SEC-068), each (id, version, body?, key) → ActionResult:
//        storeSpecimenAction(id, version, { location }, key)            #12  discardSpecimenAction(id, version, { discard_reason }, key)   #13
//        requestRecollectionAction(id, version, key)                    #10  createAliquotsAction(id, version, { aliquots: [{ specimen_type_code?, test_ids }] }, key)  #11
//        rejectSpecimenAction(id, version, { reason_code, comment?, recollection_required }, key)   #9 (already exists, T-11)
//   Action buttons (accessible names, exact): "Store" "Discard" "Reject" "Recollect" "Aliquot"; label printing is a link or button named /print label/i.
//   Which button when (02-TRD §4 transition table; permissions 02-TRD §5.1: Store/Discard/Aliquot = lab.specimen.receive, Reject/Recollect = lab.specimen.reject, Print = lab.specimen.label_print):
//        Store S13 received…reported · Discard S14 stored/reported/rejected/recollection_ordered · Reject S11 ordered…verified · Recollect S12 rejected · Aliquot S5 received · discarded = none.
//   A permission the actor lacks → the button is NOT rendered (a UI hint only; the API enforces).
//   Dialogs: Store "Location" (maxLength 120, required) confirm "Store"; Discard "Discard reason" (maxLength 200, required) confirm "Discard"; Reject title "Reject specimen {barcode}" RadioGroup "Reason" + "Comment" + "Request recollection" (default = recollectionDefault)
//        confirm "Reject"; Aliquot "Number of aliquots" (1–10) + per aliquot a "Tests" checkbox list (labels = test_code, ≥1 each) confirm "Create aliquots". Recollect is a direct action (no dialog). After a success the screen calls router.refresh().
// NOT tested (spec silent): the "by" actor on timeline rows (SpecimenDetailDto.transitions has only from/to/at — see notes), label wording of the tests table columns, results-summary wording, behaviour for is_active=false.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const nav = vi.hoisted(() => ({ refresh: vi.fn(), push: vi.fn() }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: nav.push, replace: vi.fn(), refresh: nav.refresh, back: vi.fn() }),
  usePathname: () => '/lab/specimens/x',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));
const bff = vi.hoisted(() => ({
  storeSpecimenAction: vi.fn(), discardSpecimenAction: vi.fn(), requestRecollectionAction: vi.fn(), createAliquotsAction: vi.fn(), rejectSpecimenAction: vi.fn(),
}));
vi.mock('../server/actions', () => bff);

const uuid = (k: number, n: number) => `01a1a98a-ac40-7000-8000-${String(k).padStart(4, '0')}${String(n).padStart(8, '0')}`;
const ID = uuid(5, 30);
const ORDER = uuid(4, 30);
const ALL = ['lab.specimen.read', 'lab.specimen.receive', 'lab.specimen.reject', 'lab.specimen.label_print', 'lab.result.read'];
const REASONS = [{ code: 'haemolysed', display: 'Haemolysed' }, { code: 'insufficient_volume', display: 'Insufficient volume' }];
const detail = (o: Record<string, unknown> = {}) => ({
  id: ID, version: 4, barcode: 'SYN0000030', order_id: ORDER, registration_no: 'REG260030', specimen_type_code: 'serum', container_code: 'sst', status: 'received',
  priority: 'routine', centre_id: uuid(2, 1), processing_centre_id: uuid(2, 2), is_active: true, collection_barcode_unverified: false, label_print_count: 2,
  received_at: '2026-11-11T05:10:00.000Z',
  tests: [{ test_id: uuid(3, 1), test_code: 'TSTA' }, { test_id: uuid(3, 2), test_code: 'TSTB' }],
  transitions: [{ to_status: 'ordered', at: '2026-11-11T03:00:00.000Z' }, { from_status: 'ordered', to_status: 'collected', at: '2026-11-11T04:00:00.000Z' }, { from_status: 'collected', to_status: 'received', at: '2026-11-11T05:10:00.000Z' }],
  results_summary: { total: 2, resulted: 0, verified: 0, approved: 0 },
  ...o,
});

const show = async (o: Record<string, unknown> = {}, permissions: string[] = ALL, extra: Record<string, unknown> = {}) => {
  const { SpecimenDetail } = await import('../components/specimens/SpecimenDetail');
  const ui: ReactNode = <ToastProvider><SpecimenDetail specimen={detail(o) as never} rejectionReasons={REASONS} recollectionDefault={false} permissions={permissions} {...extra} /></ToastProvider>;
  return render(ui);
};
const ACTIONS = ['Store', 'Discard', 'Reject', 'Recollect', 'Aliquot'] as const;
const shown = () => ACTIONS.filter((a) => screen.queryByRole('button', { name: a }) !== null);
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const dialog = () => screen.getByRole('dialog');
const ok = (data: unknown = {}) => ({ ok: true, data });

beforeEach(() => {
  for (const f of Object.values(bff)) f.mockReset().mockResolvedValue(ok());
  nav.refresh.mockReset(); nav.push.mockReset();
});
afterEach(() => cleanup());

describe('T-30 header, timeline, tests (04-UI-UX §3.14)', () => {
  it('shows barcode, type, container, status text, registration no and label prints', async () => {
    await show();
    const text = document.body.textContent ?? '';
    for (const s of ['SYN0000030', 'serum', 'sst', 'Received', 'REG260030']) expect(text, s).toContain(s);
    expect(text).toMatch(/label prints?\D*2|2\D*label prints?/i);
  });

  // review C5.T-30 item 1: 04-UI-UX §3.14 description list shows "centre, processing centre" (processing centre only when present).
  it('shows the centre and the processing centre', async () => {
    await show();
    const text = document.body.textContent ?? '';
    expect(text).toMatch(/processing centre/i);
    expect(text).toContain(uuid(2, 1));
    expect(text).toContain(uuid(2, 2));
    expect(text.replace(/processing centre/gi, '')).toMatch(/centre/i);
  });

  it('omits the processing centre when the specimen has none', async () => {
    await show({ processing_centre_id: undefined });
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/processing centre/i);
    expect(text).toContain(uuid(2, 1));
  });

  it('links to the parent specimen and to the specimen it replaces', async () => {
    const parent = uuid(5, 29), replaced = uuid(5, 28);
    await show({ parent_specimen_id: parent, replaces_specimen_id: replaced });
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`/lab/specimens/${parent}`);
    expect(hrefs).toContain(`/lab/specimens/${replaced}`);
  });

  it('no parent / replaces link when the specimen has neither', async () => {
    await show();
    expect(screen.queryAllByRole('link').map((a) => a.getAttribute('href')).filter((h) => /\/lab\/specimens\//.test(h ?? ''))).toEqual([]);
  });

  it('timeline: one row per transition, oldest first (sorted even if the API order differs), with the status text and a time', async () => {
    const t = detail().transitions;
    await show({ transitions: [t[2], t[0], t[1]] });
    const items = within(screen.getByRole('list', { name: /timeline|transitions|history/i })).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    ['Ordered', 'Collected', 'Received'].forEach((label, i) => {
      expect(items[i]!.textContent, label).toContain(label);
      expect(items[i]!.querySelector('time')?.getAttribute('datetime'), `time ${i}`).toBe(t[i]!.at);
    });
  });

  it('tests table lists every test_code of the specimen', async () => {
    await show();
    const table = screen.getByRole('table');
    expect(within(table).getByText('TSTA')).toBeTruthy();
    expect(within(table).getByText('TSTB')).toBeTruthy();
  });

  it('results summary is shown only to a holder of lab.result.read', async () => {
    await show({ results_summary: { total: 7, resulted: 3, verified: 2, approved: 1 } }, ALL);
    expect(document.body.textContent).toMatch(/7/);
    cleanup();
    await show({ results_summary: { total: 7, resulted: 3, verified: 2, approved: 1 } }, ALL.filter((p) => p !== 'lab.result.read'));
    expect(screen.queryByText(/results? summary/i)).toBeNull();
  });

  it('rejection comment is rendered when present (the API only sends it to lab.specimen.reject holders) with the reason code', async () => {
    await show({ status: 'rejected', rejection_reason_code: 'haemolysed', rejection_comment: 'Visibly haemolysed, synthetic.', rejected_at: '2026-11-11T06:00:00.000Z' });
    expect(document.body.textContent).toContain('Visibly haemolysed, synthetic.');
    expect(document.body.textContent).toMatch(/haemolysed/i);
  });

  it('no axe violations (all actions visible)', async () => {
    const { container } = await show({ status: 'received' });
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });
});

describe('T-30 actions by state (02-TRD §4 S5, S11–S14; 08 A13 D-15) — holder of every permission', () => {
  const CASES: [string, readonly string[]][] = [
    ['ordered', ['Reject']], ['collected', ['Reject']], ['in_transit', ['Reject']],
    ['received', ['Store', 'Reject', 'Aliquot']],
    ['aliquoted', ['Store', 'Reject']], ['in_process', ['Store', 'Reject']], ['resulted', ['Store', 'Reject']], ['verified', ['Store', 'Reject']],
    ['approved', ['Store']],
    ['reported', ['Store', 'Discard']],
    ['rejected', ['Discard', 'Recollect']],
    ['recollection_ordered', ['Discard']],
    ['stored', ['Discard']],
    ['discarded', []],
  ];
  it.each(CASES)('%s → %j', async (status, expected) => {
    await show({ status });
    expect(shown()).toEqual(ACTIONS.filter((a) => expected.includes(a)));
  });
});

describe('T-30 actions by permission', () => {
  it('read-only actor (lab.specimen.read only): no action button at all, page content still shown', async () => {
    await show({ status: 'received' }, ['lab.specimen.read']);
    expect(shown()).toEqual([]);
    expect(screen.queryByRole('link', { name: /print label/i }) ?? screen.queryByRole('button', { name: /print label/i })).toBeNull();
    expect(document.body.textContent).toContain('SYN0000030');
  });

  it('lab.specimen.receive only, received: Store + Aliquot, not Reject', async () => {
    await show({ status: 'received' }, ['lab.specimen.read', 'lab.specimen.receive']);
    expect(shown()).toEqual(['Store', 'Aliquot']);
  });

  it('lab.specimen.reject only, received: Reject only', async () => {
    await show({ status: 'received' }, ['lab.specimen.read', 'lab.specimen.reject']);
    expect(shown()).toEqual(['Reject']);
  });

  it('lab.specimen.reject only, rejected: Recollect but not Discard (Discard is lab.specimen.receive)', async () => {
    await show({ status: 'rejected' }, ['lab.specimen.read', 'lab.specimen.reject']);
    expect(shown()).toEqual(['Recollect']);
  });

  it('lab.specimen.receive only, rejected: Discard but not Recollect; recollection_ordered tube → Discard (D-15)', async () => {
    await show({ status: 'rejected' }, ['lab.specimen.read', 'lab.specimen.receive']);
    expect(shown()).toEqual(['Discard']);
    cleanup();
    await show({ status: 'recollection_ordered' }, ['lab.specimen.read', 'lab.specimen.receive']);
    expect(shown()).toEqual(['Discard']);
  });

  it('Print label needs lab.specimen.label_print and points at the order label page', async () => {
    await show({ status: 'received' }, ['lab.specimen.read', 'lab.specimen.label_print']);
    const el = (screen.queryByRole('link', { name: /print label/i }) ?? screen.getByRole('button', { name: /print label/i })) as HTMLElement;
    if (el.tagName === 'A') expect(el.getAttribute('href')).toBe(`/lab/orders/${ORDER}/labels`);
    else { fireEvent.click(el); expect(nav.push).toHaveBeenCalledWith(`/lab/orders/${ORDER}/labels`); }
    cleanup();
    await show({ status: 'received' }, ['lab.specimen.read', 'lab.specimen.receive']);
    expect(screen.queryByRole('link', { name: /print label/i }) ?? screen.queryByRole('button', { name: /print label/i })).toBeNull();
  });
});

describe('T-30 Store (#12)', () => {
  it('Location is required and capped at 120; confirm sends (id, version, { location }, key) and refreshes', async () => {
    await show({ status: 'received' });
    click('Store');
    const input = within(dialog()).getByLabelText(/location/i) as HTMLInputElement;
    expect(input.getAttribute('maxlength')).toBe('120');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Store' }));
    expect(bff.storeSpecimenAction).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Freezer F2 / Shelf 3' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Store' }));
    await waitFor(() => expect(bff.storeSpecimenAction).toHaveBeenCalledTimes(1));
    const [id, version, body, key] = bff.storeSpecimenAction.mock.calls[0]!;
    expect([id, version, body]).toEqual([ID, 4, { location: 'Freezer F2 / Shelf 3' }]);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('a whitespace-only location is refused client-side (no call)', async () => {
    await show({ status: 'received' });
    click('Store');
    fireEvent.change(within(dialog()).getByLabelText(/location/i), { target: { value: '    ' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Store' }));
    expect(bff.storeSpecimenAction).not.toHaveBeenCalled();
  });

  it('API refusal (lab.specimen_invalid_transition 409): message shown, no refresh, dialog stays so the user sees why', async () => {
    bff.storeSpecimenAction.mockResolvedValue({ ok: false, status: 409, code: 'lab.specimen_invalid_transition', title: 'Specimen cannot be stored from its current status' });
    await show({ status: 'received' });
    click('Store');
    fireEvent.change(within(dialog()).getByLabelText(/location/i), { target: { value: 'Rack 1' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Store' }));
    await waitFor(() => expect(document.body.textContent).toContain('Specimen cannot be stored from its current status'));
    expect(nav.refresh).not.toHaveBeenCalled();
  });
});

describe('T-30 Discard (#13)', () => {
  it('Discard reason is required and capped at 200; confirm sends { discard_reason }', async () => {
    await show({ status: 'stored' });
    click('Discard');
    const input = within(dialog()).getByLabelText(/discard reason|reason/i) as HTMLInputElement;
    expect(input.getAttribute('maxlength')).toBe('200');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    expect(bff.discardSpecimenAction).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: 'Retention period over (synthetic)' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(bff.discardSpecimenAction).toHaveBeenCalledTimes(1));
    const [id, version, body] = bff.discardSpecimenAction.mock.calls[0]!;
    expect([id, version, body]).toEqual([ID, 4, { discard_reason: 'Retention period over (synthetic)' }]);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('works for a recollection_ordered tube (D-15)', async () => {
    await show({ status: 'recollection_ordered' });
    click('Discard');
    fireEvent.change(within(dialog()).getByLabelText(/discard reason|reason/i), { target: { value: 'Tube not needed' } });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(bff.discardSpecimenAction).toHaveBeenCalledTimes(1));
  });

  it('cancel closes the dialog and sends nothing', async () => {
    await show({ status: 'stored' });
    click('Discard');
    fireEvent.click(within(dialog()).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(bff.discardSpecimenAction).not.toHaveBeenCalled();
  });
});

describe('T-30 Reject (#9) and Recollect (#10)', () => {
  it('Reject dialog is titled "Reject specimen {barcode}", needs a reason, sends reason/comment/recollection_required with If-Match version + key', async () => {
    await show({ status: 'received' });
    click('Reject');
    expect(within(dialog()).getByText('Reject specimen SYN0000030')).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Reject' }));
    expect(bff.rejectSpecimenAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Haemolysed' }));
    fireEvent.change(within(dialog()).getByLabelText(/comment/i), { target: { value: 'Synthetic comment' } });
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: /request recollection/i }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(bff.rejectSpecimenAction).toHaveBeenCalledTimes(1));
    const [id, version, body, key] = bff.rejectSpecimenAction.mock.calls[0]!;
    expect([id, version, body]).toEqual([ID, 4, { reason_code: 'haemolysed', comment: 'Synthetic comment', recollection_required: true }]);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('"Request recollection" starts from recollectionDefault (LabSettings.recollection_default)', async () => {
    await show({ status: 'received' }, ALL, { recollectionDefault: true });
    click('Reject');
    expect((within(dialog()).getByRole('checkbox', { name: /request recollection/i }) as HTMLInputElement).checked).toBe(true);
    cleanup();
    await show({ status: 'received' }, ALL, { recollectionDefault: false });
    click('Reject');
    expect((within(dialog()).getByRole('checkbox', { name: /request recollection/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('Reject with a success carrying a new barcode announces it ("New barcode … created for recollection")', async () => {
    bff.rejectSpecimenAction.mockResolvedValue(ok({ specimen: detail({ status: 'rejected' }), recollection_specimen: detail({ id: uuid(5, 31), barcode: 'SYN0000031', status: 'ordered' }) }));
    await show({ status: 'received' });
    click('Reject');
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Haemolysed' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Reject' }));
    await waitFor(() => expect(document.body.textContent).toContain('Specimen rejected. New barcode SYN0000031 created for recollection.'));
  });

  it('Recollect is a direct action: (id, version, key), then refresh — no dialog', async () => {
    await show({ status: 'rejected' });
    click('Recollect');
    await waitFor(() => expect(bff.requestRecollectionAction).toHaveBeenCalledTimes(1));
    const [id, version, key] = bff.requestRecollectionAction.mock.calls[0]!;
    expect([id, version]).toEqual([ID, 4]);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('Recollect refused (409 lab.specimen_invalid_transition): the title is shown and the screen is not refreshed', async () => {
    bff.requestRecollectionAction.mockResolvedValue({ ok: false, status: 409, code: 'lab.specimen_invalid_transition', title: 'Recollection already requested' });
    await show({ status: 'rejected' });
    click('Recollect');
    await waitFor(() => expect(document.body.textContent).toContain('Recollection already requested'));
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it('double-click on Recollect sends one request (E6: the button is disabled while busy)', async () => {
    let release!: (v: unknown) => void;
    bff.requestRecollectionAction.mockReturnValue(new Promise((r) => { release = r; }));
    await show({ status: 'rejected' });
    const b = screen.getByRole('button', { name: 'Recollect' });
    fireEvent.click(b); fireEvent.click(b);
    expect(bff.requestRecollectionAction).toHaveBeenCalledTimes(1);
    release(ok());
  });
});

describe('T-30 Aliquot (#11)', () => {
  it('one aliquot by default; needs ≥1 test per aliquot; sends { aliquots: [{ test_ids }] }', async () => {
    await show({ status: 'received' });
    click('Aliquot');
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create aliquots' }));
    expect(bff.createAliquotsAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'TSTA' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create aliquots' }));
    await waitFor(() => expect(bff.createAliquotsAction).toHaveBeenCalledTimes(1));
    const [id, version, body, key] = bff.createAliquotsAction.mock.calls[0]!;
    expect([id, version]).toEqual([ID, 4]);
    expect(body.aliquots).toHaveLength(1);
    expect(body.aliquots[0].test_ids).toEqual([uuid(3, 1)]);
    expect(key).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    await waitFor(() => expect(nav.refresh).toHaveBeenCalled());
  });

  it('"Number of aliquots" = 2 shows a test list per aliquot and sends two entries', async () => {
    await show({ status: 'received' });
    click('Aliquot');
    fireEvent.change(within(dialog()).getByRole('spinbutton', { name: /number of aliquots/i }), { target: { value: '2' } });
    const as = within(dialog()).getAllByRole('checkbox', { name: 'TSTA' });
    const bs = within(dialog()).getAllByRole('checkbox', { name: 'TSTB' });
    expect(as).toHaveLength(2);
    fireEvent.click(as[0]!); fireEvent.click(bs[1]!);
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create aliquots' }));
    await waitFor(() => expect(bff.createAliquotsAction).toHaveBeenCalledTimes(1));
    const body = bff.createAliquotsAction.mock.calls[0]![2];
    expect(body.aliquots.map((a: { test_ids: string[] }) => a.test_ids)).toEqual([[uuid(3, 1)], [uuid(3, 2)]]);
  });

  it('never sends fewer than 1 or more than 10 aliquots (0 and 11 are refused or clamped)', async () => {
    for (const n of ['0', '11']) {
      bff.createAliquotsAction.mockClear();
      await show({ status: 'received' });
      click('Aliquot');
      fireEvent.change(within(dialog()).getByRole('spinbutton', { name: /number of aliquots/i }), { target: { value: n } });
      for (const c of within(dialog()).queryAllByRole('checkbox', { name: 'TSTA' })) fireEvent.click(c);
      fireEvent.click(within(dialog()).getByRole('button', { name: 'Create aliquots' }));
      await new Promise((r) => setTimeout(r, 20));
      for (const call of bff.createAliquotsAction.mock.calls) {
        expect(call[2].aliquots.length, `n=${n}`).toBeGreaterThanOrEqual(1);
        expect(call[2].aliquots.length, `n=${n}`).toBeLessThanOrEqual(10);
      }
      cleanup();
    }
  });

  it('success offers "Print labels" for the new aliquots (UI-UX §3.3 Aliquot dialog)', async () => {
    bff.createAliquotsAction.mockResolvedValue(ok({ parent: detail({ status: 'aliquoted' }), aliquots: [detail({ id: uuid(5, 32), barcode: 'SYN0000032', status: 'received' })] }));
    await show({ status: 'received' });
    click('Aliquot');
    fireEvent.click(within(dialog()).getByRole('checkbox', { name: 'TSTA' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Create aliquots' }));
    await waitFor(() => expect(document.body.textContent).toMatch(/Created 1 aliquots?/));
    expect(screen.queryByRole('link', { name: /print labels?/i }) ?? screen.queryByRole('button', { name: /print labels?/i })).not.toBeNull();
  });
});
