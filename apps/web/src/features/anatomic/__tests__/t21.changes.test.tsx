// @vitest-environment jsdom
// C11.T-21 — after sign-out: version viewer + Versions table, Revise/Amend change dialog, change draft, addendum drawer
// (04-UI-UX §4.2.7 "After sign-out", Change dialog, Addendum editor; 03-APP-FLOW §4.2 + E10; AC-10.1…10.8 (UI side); TRD R4-R10; 08 A17 D-62; REQ-SEC-062/067/088).
// ASSUMED (t21.harness.tsx header): signed case = status signed_out + current_version_no>0; the Report tab then shows the version viewer (GET versions/{current}) instead of the editor, a "Versions" DataTable
//   (GET versions), buttons [Revise] | [Amend] (label from the C5 status of the primary items: any 'approved' -> Amend), [Add addendum]; an open change draft shows the editor again with [Discard change];
//   the change dialog is the kit ConfirmDialog requireReason (Select "Reason", TextField "Details", confirm button named Revise/Amend); the addendum editor is a Drawer (role=dialog) with
//   Kind Select, Text, completed-stain Checkboxes, add-on link Select, [Save], [Sign addendum]; addenda rows come from CaseDetail.addenda.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { ToastProvider } from '@lims/ui/components/Toast';
import { IDEM_RE, ID, ORIGIN, PERM_SIGN, PERM_WORK, addendum, addonItem, api, approvedItems, draft, hit, problem, reportCase, resetHits, router, signedCase, t21Defaults, versionFull, versionSummary } from './t21.harness';

vi.mock('next/navigation', async () => (await import('./t21.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t21.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
beforeEach(() => { resetHits(); router.push.mockReset(); router.refresh.mockReset(); api.use(...t21Defaults); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const mount = async (d: Record<string, unknown>, permissions = PERM_SIGN) => {
  const { CaseWorkspace } = await import('../components/CaseWorkspace');
  render(<ToastProvider><CaseWorkspace detail={d as never} permissions={permissions} templates={[]} /></ToastProvider>);
  await userEvent.click(screen.getByRole('tab', { name: /^report$/i }));
};
const text = () => document.body.textContent ?? '';
const btn = (re: RegExp, scope: HTMLElement = document.body) => within(scope).getByRole('button', { name: re }) as HTMLButtonElement;
const posts = (re: RegExp) => hit('POST', re);
const versions = (...n: number[]) => api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/versions`, () => HttpResponse.json({ data: n.map((v) => versionSummary(v)) })));
const viewer = async (d: Record<string, unknown> = signedCase(), permissions = PERM_SIGN) => { versions(1); await mount(d, permissions); await screen.findByText('Synthetic signed impression.'); };
const choose = async (scope: HTMLElement, lab: RegExp, option: RegExp) => {
  await userEvent.click(within(scope).getByRole('button', { name: lab }));
  await userEvent.click(await screen.findByRole('option', { name: option }));
};

describe('version viewer + Versions table (§4.2.7)', () => {
  it('the editor is replaced by the snapshot of the current version (GET versions/{current_version_no}); no editable report fields remain', async () => {
    await viewer();
    expect(hit('GET', new RegExp(`/cases/${ID(1)}/versions/1$`))).toHaveLength(1);
    for (const s of ['Synthetic signed gross.', 'Synthetic signed microscopy.', 'Synthetic signed impression.', 'Synthetic site', 'Tumour site', 'Synthetic diagnosis one']) expect(text(), s).toContain(s);
    expect(screen.queryByLabelText(/^gross/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /save draft/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^sign out$/i })).toBeNull();
  });

  it('"Versions" DataTable: Version, Kind, Signed, By, Reason, Lab status at submit; newest first; kind and status as words', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/anatomic/cases/:id/versions`, () => HttpResponse.json({ data: [versionSummary(2, { version_kind: 'amendment', change_reason_code: 'transcription_error', submissions: [{ case_item_id: ID(10), order_item_id: ID(11), item_version_no: 2, lab_status_at_submit: 'approved' }] }), versionSummary(1)] })),
      http.get(`${ORIGIN}/v1/anatomic/cases/:id/versions/:n`, () => HttpResponse.json(versionFull(2))),
    );
    await mount(signedCase({ current_version_no: 2 }));
    const grid = await screen.findByRole('grid', { name: /versions/i }).catch(() => screen.getByRole('grid'));
    for (const h of ['Version', 'Kind', 'Signed', 'By', 'Reason', 'Lab status at submit']) expect(within(grid).getByRole('columnheader', { name: new RegExp(`^${h}`, 'i') }), h).toBeTruthy();
    const rows = within(grid).getAllByRole('row').slice(1);
    expect(rows[0]!.textContent).toMatch(/2/);
    expect(rows[0]!.textContent).toMatch(/amendment/i);
    expect(rows[0]!.textContent).toMatch(/approved/i);
    expect(rows[1]!.textContent).toMatch(/original/i);
    expect(rows[1]!.textContent).toMatch(/pending/i);
  });

  it('choosing another version row loads that snapshot (GET versions/1) and shows its text', async () => {
    api.use(
      http.get(`${ORIGIN}/v1/anatomic/cases/:id/versions`, () => HttpResponse.json({ data: [versionSummary(2), versionSummary(1)] })),
      http.get(`${ORIGIN}/v1/anatomic/cases/:id/versions/:n`, ({ params }) => HttpResponse.json(versionFull(Number(params['n']), { impression_text: `Synthetic impression of v${params['n']}.` }))),
    );
    await mount(signedCase({ current_version_no: 2 }));
    await screen.findByText('Synthetic impression of v2.');
    const row = within(screen.getByRole('grid')).getAllByRole('row').find((r) => /original/i.test(r.textContent ?? ''))!;
    await userEvent.click(within(row).queryByRole('button') ?? row);
    await screen.findByText('Synthetic impression of v1.');
  });

  it('snapshot text is rendered as text, never HTML (REQ-SEC-088); images show only captions', async () => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/versions/:n`, () => HttpResponse.json(versionFull(1, { impression_text: '<img src=x onerror=alert(1)>', images: [{ bucket: 'anatomic-images', object_path: 'tenant/secret/path.png', sha256: 'a'.repeat(64), caption: '<script>alert(2)</script>' }] }))));
    versions(1);
    await mount(signedCase());
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
    expect(text()).not.toContain('tenant/secret/path.png'); // storage paths never reach the page
  });

  it('a case without a current version yet (current_version_no 0) never calls versions/0', async () => {
    await mount(reportCase());
    await waitFor(() => expect(screen.queryByLabelText(/^gross/i)).toBeTruthy());
    expect(hit('GET', /\/versions\/0$/)).toHaveLength(0);
  });
});

describe('Revise / Amend label (AC-10.1, AC-10.2)', () => {
  it.each([['pending', 'Revise'], ['resulted', 'Revise'], ['verified', 'Revise'], ['approved', 'Amend']])('C5 status "%s" -> [%s]', async (status, name) => {
    await viewer(signedCase({ items: approvedItems(status) }));
    expect(btn(new RegExp(`^${name}$`, 'i'))).toBeTruthy();
    expect(screen.queryByRole('button', { name: new RegExp(`^${name === 'Revise' ? 'Amend' : 'Revise'}$`, 'i') })).toBeNull();
  });

  it('any approved primary item makes it an Amend; add-on items do not count', async () => {
    const items = [...approvedItems('pending'), { ...approvedItems('approved')[0], case_item_id: ID(30), order_item_id: ID(31), test_name: 'Synthetic second' }];
    await viewer(signedCase({ items }));
    expect(btn(/^amend$/i)).toBeTruthy();
    cleanup();
    await viewer(signedCase({ items: [...approvedItems('pending'), { ...addonItem, lab_status: 'approved' }] }));
    expect(btn(/^revise$/i)).toBeTruthy();
  });

  it('no lab.result.read (lab_status absent) -> [Revise] (the server re-decides at sign-out, E10)', async () => {
    await viewer(signedCase({ items: [{ ...approvedItems('pending')[0], lab_status: undefined }] }));
    expect(btn(/^revise$/i)).toBeTruthy();
  });

  it('[Revise]/[Amend] need anatomic.case.signout; [Add addendum] needs createAnatomicAddendum in allowed_actions', async () => {
    await viewer(signedCase({ allowed_actions: [] }), PERM_WORK);
    expect(screen.queryByRole('button', { name: /^(revise|amend)$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^add addendum$/i })).toBeNull();
  });
});

describe('change dialog (R4, 08 A17 D-62)', () => {
  const start = async (status = 'pending') => { await viewer(signedCase({ items: approvedItems(status) })); await userEvent.click(btn(/^(revise|amend)$/i)); return screen.findByRole('dialog'); };

  it('Revise: title "Revise report"; reasons come from C5 amendment_reasons: ACTIVE only, system codes (module_phase_progression, module_preliminary_update, supplementary_report) excluded', async () => {
    const d = await start('pending');
    expect(d.textContent).toMatch(/revise report/i);
    expect(hit('GET', /\/v1\/lab\/coded-sets\/amendment_reasons$/).length).toBeGreaterThan(0);
    await userEvent.click(within(d).getByRole('button', { name: /reason/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(opts).toEqual(['Transcription error', 'New clinical information']);
  });

  it('Amend: title "Amend approved report" and the body "This result is approved. Your change creates an amended report; the previous version stays on record."', async () => {
    const d = await start('approved');
    expect(d.textContent).toMatch(/amend approved report/i);
    expect(d.textContent).toContain('This result is approved. Your change creates an amended report; the previous version stays on record.');
  });

  it('reason is required: confirming without one sends nothing; Details is optional with maxLength 500', async () => {
    const d = await start();
    expect(within(d).getByLabelText(/^details/i).getAttribute('maxlength')).toBe('500');
    await userEvent.click(within(d).getAllByRole('button').find((b) => /^(revise|amend)$/i.test(b.textContent ?? ''))!);
    expect(posts(/\/changes$/)).toHaveLength(0);
  });

  it('confirm -> POST /cases/{id}/changes {reason_code, reason_text?} with If-Match = the CASE version and an Idempotency-Key (AC-10.1)', async () => {
    const d = await start();
    await choose(d, /reason/i, /^transcription error$/i);
    await userEvent.type(within(d).getByLabelText(/^details/i), 'Synthetic detail');
    await userEvent.click(within(d).getAllByRole('button').find((b) => /^(revise|amend)$/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(posts(/\/changes$/)).toHaveLength(1));
    const p = posts(/\/changes$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/cases/${ID(1)}/changes`);
    expect(p.headers.get('if-match')).toBe('"7"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(p.json).toEqual({ reason_code: 'transcription_error', reason_text: 'Synthetic detail' });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('no Details typed -> reason_text is omitted from the body', async () => {
    const d = await start('approved');
    await choose(d, /reason/i, /^new clinical information$/i);
    await userEvent.click(within(d).getAllByRole('button').find((b) => /^(revise|amend)$/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(posts(/\/changes$/)).toHaveLength(1));
    expect(posts(/\/changes$/)[0]!.json).toEqual({ reason_code: 'new_information' });
  });

  it('AC-10.7: 409 anatomic.case_invalid_transition (another open change draft) -> "That step isn\'t possible for a case in status signed_out."', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/changes`, () => problem('anatomic.case_invalid_transition', 409, { detail: 'internal-trace-xyz' })));
    const d = await start();
    await choose(d, /reason/i, /^transcription error$/i);
    await userEvent.click(within(d).getAllByRole('button').find((b) => /^(revise|amend)$/i.test(b.textContent ?? ''))!);
    expect(await screen.findByText("That step isn't possible for a case in status signed_out.")).toBeTruthy();
    expect(text()).not.toContain('internal-trace-xyz');
  });

  it('403 auth.mfa_required -> the two-factor dialog (privileged action, aal2)', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/changes`, () => problem('auth.mfa_required', 403)));
    const d = await start();
    await choose(d, /reason/i, /^transcription error$/i);
    await userEvent.click(within(d).getAllByRole('button').find((b) => /^(revise|amend)$/i.test(b.textContent ?? ''))!);
    expect(await screen.findByText(/two-factor verification/i)).toBeTruthy();
  });

  it('the reasons list failing to load blocks the dialog with a plain message (no crash, no raw code)', async () => {
    api.use(http.get(`${ORIGIN}/v1/lab/coded-sets/amendment_reasons`, () => problem('auth.forbidden', 403)));
    const d = await start();
    await userEvent.click(within(d).getAllByRole('button').find((b) => /^(revise|amend)$/i.test(b.textContent ?? ''))!);
    expect(posts(/\/changes$/)).toHaveLength(0);
    expect(text()).not.toContain('auth.forbidden');
  });
});

describe('open change draft (AC-10.7/10.8 UI)', () => {
  const withChange = (kind: string, over: Record<string, unknown> = {}) => {
    api.use(http.get(`${ORIGIN}/v1/anatomic/cases/:id/report-draft`, () => HttpResponse.json(draft({ kind, change_reason_code: 'transcription_error', gross_text: 'Synthetic signed gross.', impression_text: 'Synthetic signed impression.', version: 1, ...over }))));
    return mount(signedCase({ open_draft: { kind, version: 1, updated_at: '2026-11-13T08:00:00.000Z' }, flags: { profile_missing: false, specimen_rejected: false, open_change: true, pending_stain_orders: 0, parts_missing_site: false } }));
  };

  it('the editor is shown again with the badge "Revision" (or "Amendment — reason: {display}") and the prefilled text', async () => {
    await withChange('revision');
    expect((await screen.findByLabelText(/diagnosis \/ impression/i) as HTMLTextAreaElement).value).toBe('Synthetic signed impression.');
    expect(screen.getAllByText(/^revision$/i).length).toBeGreaterThan(0);
  });

  it('[Discard change] -> POST changes/discard with If-Match = the draft version and an Idempotency-Key; then refresh', async () => {
    await withChange('revision');
    await screen.findByLabelText(/diagnosis \/ impression/i);
    await userEvent.click(btn(/^discard (change|draft|revision)/i));
    const d = screen.queryByRole('dialog');
    if (d) await userEvent.click(within(d).getAllByRole('button').find((b) => !/cancel|stay|keep/i.test(b.textContent ?? ''))!);
    await waitFor(() => expect(posts(/\/changes\/discard$/)).toHaveLength(1));
    const p = posts(/\/changes\/discard$/)[0]!;
    expect(p.headers.get('if-match')).toBe('"1"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('AC-10.8: signing a revision draft asks for NO reason again (the draft carries it): the dialog has attestation only, and a successful sign shows the new version number', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/sign-out`, () => HttpResponse.json({ case: signedCase({ current_version_no: 2 }), report_version: versionSummary(2, { version_kind: 'amendment' }) })));
    await withChange('revision');
    await screen.findByLabelText(/diagnosis \/ impression/i);
    await userEvent.click(btn(/^sign out$/i));
    const d = await screen.findByRole('dialog');
    expect(d.textContent).toContain('Version 2 will be created');
    expect(within(d).queryByRole('button', { name: /reason/i })).toBeNull();
    await userEvent.click(within(d).getByRole('checkbox', { name: /i have reviewed/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^sign out$/i }));
    await waitFor(() => expect(posts(/\/sign-out$/)).toHaveLength(1));
    expect(posts(/\/sign-out$/)[0]!.json).toEqual({ attest: true });
    expect(await screen.findByText('Signed out as version 2. Sent to lab verification.')).toBeTruthy();
  });

  it('AC-10.3: lab.result_locked from an amendment sign-out -> "The lab result is approved and locked. Use Amend." and nothing is refreshed', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/sign-out`, () => problem('lab.result_locked', 409, { request_id: 'REQ-LOCK-1' })));
    await withChange('amendment');
    await screen.findByLabelText(/diagnosis \/ impression/i);
    await userEvent.click(btn(/^sign out$/i));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('checkbox', { name: /i have reviewed/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^sign out$/i }));
    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((a) => a.textContent).join(' ')).toContain('The lab result is approved and locked. Use Amend.');
    expect(router.refresh).not.toHaveBeenCalled();
  });
});

describe('addenda (AC-10.4, 10.5, 10.6; R8-R10)', () => {
  const withAddon = (over: Record<string, unknown> = {}) => signedCase({ items: [...approvedItems('pending'), addonItem], ...over });
  const openDrawer = async (d: Record<string, unknown> = withAddon()) => { await viewer(d); await userEvent.click(btn(/^add addendum$/i)); return screen.findByRole('dialog'); };

  it('[Add addendum] opens a Drawer: Kind (IHC / Special stain / Molecular / Other), Text (required, <=8000), completed stain orders as Checkboxes, add-on link Select; [Save] and [Sign addendum]', async () => {
    const d = await openDrawer();
    await userEvent.click(within(d).getByRole('button', { name: /kind/i }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['IHC', 'Special stain', 'Molecular', 'Other']);
    await userEvent.keyboard('{Escape}');
    expect(within(d).getByLabelText(/^text/i).getAttribute('maxlength')).toBe('8000');
    expect(within(d).getByRole('checkbox', { name: /periodic acid-schiff/i })).toBeTruthy();
    expect(within(d).queryByRole('checkbox', { name: /cytokeratin 7/i })).toBeNull(); // not completed
    expect(within(d).getByRole('button', { name: /link to billed add-on item/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^save$/i })).toBeTruthy();
    expect(within(d).getByRole('button', { name: /^sign addendum$/i })).toBeTruthy();
    expect(posts(/\/addenda$/)).toHaveLength(0);
  });

  it('AC-10.4: [Save] -> POST /cases/{id}/addenda {kind:"ihc", text, stain_order_ids} with an Idempotency-Key, no add-on link; refreshes', async () => {
    const d = await openDrawer();
    await choose(d, /kind/i, /^ihc$/i);
    await userEvent.type(within(d).getByLabelText(/^text/i), 'Synthetic addendum text');
    await userEvent.click(within(d).getByRole('checkbox', { name: /periodic acid-schiff/i }));
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(posts(/\/addenda$/)).toHaveLength(1));
    const p = posts(/\/addenda$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/cases/${ID(1)}/addenda`);
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(p.json).toEqual({ kind: 'ihc', text: 'Synthetic addendum text', stain_order_ids: [ID(401)] });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('AC-10.5: linking a billed add-on item sends addon_case_item_id; the Select lists add-on items WITHOUT a result only', async () => {
    const d = await openDrawer(withAddon({ items: [...approvedItems('pending'), addonItem, { ...addonItem, case_item_id: ID(40), order_item_id: ID(41), test_name: 'Synthetic done add-on', lab_status: 'resulted' }] }));
    await userEvent.click(within(d).getByRole('button', { name: /link to billed add-on item/i }));
    const opts = (await screen.findAllByRole('option')).map((o) => o.textContent ?? '');
    expect(opts.some((o) => /synthetic add-on ihc panel/i.test(o))).toBe(true);
    expect(opts.some((o) => /synthetic done add-on/i.test(o))).toBe(false);
    await userEvent.click(screen.getByRole('option', { name: /synthetic add-on ihc panel/i }));
    await choose(d, /kind/i, /^ihc$/i);
    await userEvent.type(within(d).getByLabelText(/^text/i), 'Synthetic addon text');
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(posts(/\/addenda$/)).toHaveLength(1));
    expect(posts(/\/addenda$/)[0]!.json.addon_case_item_id).toBe(ID(20));
  });

  it('empty text -> no request, an error in words (Text is required)', async () => {
    const d = await openDrawer();
    await choose(d, /kind/i, /^other$/i);
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    expect(posts(/\/addenda$/)).toHaveLength(0);
    expect(d.textContent).toMatch(/required/i);
  });

  it('AC-10.6: 409 anatomic.case_invalid_transition on create -> §8 message with the status', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/cases/:id/addenda`, () => problem('anatomic.case_invalid_transition', 409)));
    const d = await openDrawer();
    await choose(d, /kind/i, /^other$/i);
    await userEvent.type(within(d).getByLabelText(/^text/i), 'Synthetic');
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    expect(await screen.findByText("That step isn't possible for a case in status signed_out.")).toBeTruthy();
  });

  it('a draft addendum from the case is listed (kind, status words "Draft"); editing it -> PUT /addenda/{id} with If-Match = its version', async () => {
    await viewer(withAddon({ addenda: [addendum(1, { kind: 'special_stain', version: 3 })] }));
    expect(text()).toContain('Synthetic addendum text 1');
    expect(text()).toMatch(/draft/i);
    await userEvent.click(screen.getByRole('button', { name: /^edit.*addendum|^edit$/i }));
    const d = await screen.findByRole('dialog');
    const t = within(d).getByLabelText(/^text/i) as HTMLTextAreaElement;
    expect(t.value).toBe('Synthetic addendum text 1');
    await userEvent.clear(t);
    await userEvent.type(t, 'Synthetic edited');
    await userEvent.click(within(d).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(hit('PUT', /\/addenda\/[^/]+$/)).toHaveLength(1));
    const p = hit('PUT', /\/addenda\/[^/]+$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/addenda/${ID(1101)}`);
    expect(p.headers.get('if-match')).toBe('"3"');
    expect(p.json).toMatchObject({ kind: 'special_stain', text: 'Synthetic edited' });
  });

  it('[Sign addendum] -> POST /addenda/{id}/sign with If-Match = the addendum version, Idempotency-Key, {attest:true}; toast names the new report version', async () => {
    await viewer(withAddon({ addenda: [addendum(1, { version: 3 })] }));
    await userEvent.click(screen.getByRole('button', { name: /^edit.*addendum|^edit$/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('button', { name: /^sign addendum$/i }));
    const c = await screen.findAllByRole('dialog');
    const att = c.map((x) => within(x).queryByRole('checkbox', { name: /i have reviewed/i })).find(Boolean);
    if (att) { await userEvent.click(att); await userEvent.click(within(att.closest('[role="dialog"]') as HTMLElement).getByRole('button', { name: /^(sign|sign addendum|sign out)$/i })); }
    await waitFor(() => expect(posts(/\/addenda\/[^/]+\/sign$/)).toHaveLength(1));
    const p = posts(/\/addenda\/[^/]+\/sign$/)[0]!;
    expect(p.path).toBe(`/v1/anatomic/addenda/${ID(1101)}/sign`);
    expect(p.headers.get('if-match')).toBe('"3"');
    expect(p.headers.get('idempotency-key')).toMatch(IDEM_RE);
    expect(p.json).toEqual({ attest: true });
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });

  it('403 auth.mfa_required on signing an addendum -> two-factor dialog; nothing changes', async () => {
    api.use(http.post(`${ORIGIN}/v1/anatomic/addenda/:id/sign`, () => problem('auth.mfa_required', 403)));
    await viewer(withAddon({ addenda: [addendum(1)] }));
    await userEvent.click(screen.getByRole('button', { name: /^edit.*addendum|^edit$/i }));
    const d = await screen.findByRole('dialog');
    await userEvent.click(within(d).getByRole('button', { name: /^sign addendum$/i }));
    for (const x of screen.getAllByRole('dialog')) { const a = within(x).queryByRole('checkbox', { name: /i have reviewed/i }); if (a) { await userEvent.click(a); await userEvent.click(within(x).getByRole('button', { name: /^(sign|sign addendum|sign out)$/i })); } }
    expect(await screen.findByText(/two-factor verification/i)).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it('a SIGNED addendum is read-only: text, "Signed" word, report version, signer; no [Edit] / [Sign addendum]', async () => {
    await viewer(withAddon({ addenda: [addendum(1, { status: 'signed', signed_at: '2026-11-13T10:00:00.000Z', signed_by_display_name: 'Synthetic Pathologist', report_version_no: 2 })] }));
    expect(text()).toContain('Synthetic addendum text 1');
    expect(text()).toMatch(/signed/i);
    expect(screen.queryByRole('button', { name: /^edit.*addendum|^edit$/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /^sign addendum$/i })).toBeNull();
  });

  it('addendum text renders as text (REQ-SEC-088)', async () => {
    await viewer(withAddon({ addenda: [addendum(1, { text: '<img src=x onerror=alert(1)>' })] }));
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(text()).toContain('<img src=x onerror=alert(1)>');
  });

  it('no [Sign addendum] for a user without anatomic.case.signout (privileged, R10), but a case.work user can still edit and [Save] a draft addendum (R9)', async () => {
    await viewer(withAddon({ addenda: [addendum(1)] }), PERM_WORK);
    await userEvent.click(screen.getByRole('button', { name: /^edit.*addendum|^edit$/i }));
    const d = await screen.findByRole('dialog');
    expect(within(d).queryByRole('button', { name: /^sign addendum$/i })).toBeNull();
    expect(within(d).getByRole('button', { name: /^save$/i })).toBeTruthy();
  });
});

describe('a11y', () => {
  it('axe: no serious/critical violations on the signed-out Report tab', async () => {
    await viewer();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
    expect(r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => v.id)).toEqual([]);
  });
});
