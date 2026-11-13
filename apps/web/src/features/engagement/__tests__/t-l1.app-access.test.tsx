// @vitest-environment jsdom
// C16.T-L1 — W8 "Patient app access" (03-APP-FLOW W8 flow + §508 empty state; 02-TRD §4.3.1 step 5; 01-PRD US-EN-03.1/03.6/06.6; 07-SECURITY §3 L1 row "code shown once, slip without name"; LD-140).
// Synthetic data only. Fixtures follow contracts/openapi/engagement.yaml (AppLink, codes of listPatientAppLinks, issueLinkCode 201).
//
// ASSUMED CONTRACT (spec gives the screen flow, not component props — a dispute may refine it). NAMED exports in features/engagement/components/AppAccess.tsx, client components, props injected,
// no fetch inside (only `actions`, the BFF server actions):
//   AppAccess({ patient: {id, display_name}, links: AppLink[], codes: {link_code_id,status,expires_at,issued_at}[], recordPhoneMasked: string | null, consent: {version, text}, labName, actions })     W8
//     actions.issue(body): Promise<{link_code_id, code, expires_at, bound_phone_masked}>   body = issueLinkCode request { patient_id, relationship, consented_by, identity_check_method, bind_phone, phone_e164? }
//     actions.revokeLink(link, { reason_code }): Promise<void>     actions.revokeCode(code): Promise<void>     actions.refresh(): Promise<void>
//   CodeSlip({ code, expiresAt, boundPhoneMasked, labName })   the printed slip; root element carries data-testid="code-slip" (also when rendered inside AppAccess). It has NO patient name (TRD §4.3.1 step 5).
// Form controls are found by their accessible label; a control may be a native <select> or a radio group (helper `choose`).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { ToastProvider } from '@lims/ui/components/Toast';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }), usePathname: () => '/engagement/app-access/x', useSearchParams: () => new URLSearchParams() }));
vi.mock('server-only', () => ({}));
afterEach(cleanup);

const id = (n: number) => `01950c16-0000-7000-8000-${String(n).padStart(12, '0')}`;
const PATIENT = { id: id(1), display_name: 'Sunita Synthetic Patient' };
const LAB = 'Demo Lab Kathmandu'; // no word in common with PATIENT.display_name (ruling point 1)
const CODE = 'K7M2Q-9XH4T';
const EXPIRES = '2026-11-13T04:15:00.000Z'; // 10:00 Asia/Kathmandu (UTC+05:45)
const CONSENT = { version: 'v3', text: 'Synthetic consent: the lab may share this patient\'s reports with the linked app account.' };
const link = (n: number, o: Record<string, unknown> = {}) => ({ profile_id: id(100 + n), link_id: id(100 + n), patient_id: PATIENT.id, display_name: PATIENT.display_name, relationship: 'self', method: 'link_code', status: 'active',
  account_phone_masked: '+977•••••42', history_from: '2026-11-01T04:15:00.000Z', ...o });
const LINKS = () => [
  link(1), link(2, { relationship: 'child', status: 'suspended', suspend_reason: 'phone_mismatch', account_phone_masked: '+977•••••77' }),
  link(3, { relationship: 'other', status: 'revoked', revoked_at: '2026-11-02T04:15:00.000Z', revoked_reason_code: 'staff_error', account_phone_masked: '+977•••••88' }),
];
const CODES = () => [
  { link_code_id: id(201), status: 'issued', expires_at: '2026-11-14T04:15:00.000Z', issued_at: '2026-11-11T04:15:00.000Z' },
  { link_code_id: id(202), status: 'redeemed', expires_at: '2026-11-13T04:15:00.000Z', issued_at: '2026-11-10T04:15:00.000Z' },
  { link_code_id: id(203), status: 'revoked', expires_at: '2026-11-12T04:15:00.000Z', issued_at: '2026-11-09T04:15:00.000Z' },
];
const actions = (over: Record<string, unknown> = {}) => ({
  issue: vi.fn(async (_b: any) => ({ link_code_id: id(299), code: CODE, expires_at: EXPIRES, bound_phone_masked: '+977•••••42' })),
  revokeLink: vi.fn(async (_l: unknown, _b: unknown) => {}),
  revokeCode: vi.fn(async (_c: unknown) => {}),
  refresh: vi.fn(async () => {}),
  ...over,
});
// Template-literal path on purpose: a missing component fails only its own tests (a static literal fails the whole suite at transform time).
const load = async (name: string) => ((await import(/* @vite-ignore */ `../components/${'AppAccess'}`)) as Record<string, (p: any) => any>)[name]!;
async function show(a = actions(), props: Record<string, unknown> = {}) {
  const C = await load('AppAccess');
  const view = render(<ToastProvider><C patient={PATIENT} links={LINKS()} codes={CODES()} recordPhoneMasked="+977•••••42" consent={CONSENT} labName={LAB} actions={a} {...props} /></ToastProvider>);
  return { ...view, actions: a };
}
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const dialog = () => screen.getByRole('dialog');

/** Pick `option` for the control labelled `label`: native <select> or a radio group. */
async function choose(root: HTMLElement, label: RegExp, option: RegExp) {
  const u = userEvent.setup();
  const sel = within(root).queryByLabelText(label);
  if (sel && sel.tagName === 'SELECT') {
    const o = Array.from((sel as HTMLSelectElement).options).find((x) => option.test(x.textContent ?? ''));
    if (!o) throw new Error(`no option ${option} in ${label}`);
    await u.selectOptions(sel, o);
    return;
  }
  const group = within(root).queryByRole('radiogroup', { name: label });
  if (group) { await u.click(within(group).getByRole('radio', { name: option })); return; }
  if (sel) { await u.click(sel); await u.click(await screen.findByRole('option', { name: option })); return; }  // combobox-style Select
  throw new Error(`no control labelled ${label}`);
}
/** Required confirmation checkbox (04-UI-UX.md:247), default off. */
async function tick(d: HTMLElement) {
  await userEvent.setup().click(within(d).getByRole('checkbox', { name: /identity and they agreed/i }));
}
async function openIssue() {
  const u = userEvent.setup();
  await u.click(screen.getByRole('button', { name: /issue app code/i }));
  return dialog();
}

describe('W8 list (links + codes, L3)', () => {
  it('empty state: "This patient has no app access" with the Issue action still available', async () => {
    await show(actions(), { links: [], codes: [] });
    expect(norm(document.body.textContent)).toMatch(/This patient has no app access/);
    expect(screen.getByRole('button', { name: /issue app code/i })).toBeTruthy();
  });

  it('every status shows its word (Active / Paused / Revoked; code Issued / Redeemed / Revoked) and the masked account phone; never a full phone', async () => {
    await show();
    const t = norm(document.body.textContent);
    for (const w of [/active/i, /paused/i, /revoked/i, /issued/i, /redeemed/i]) expect(t).toMatch(w);
    expect(t).toContain('+977•••••42');
    expect(t).not.toMatch(/\+977\d{7,}/);
  });

  it('suspension and revocation reasons are shown in words, not raw codes', async () => {
    await show();
    const t = norm(document.body.textContent);
    expect(t).not.toMatch(/phone_mismatch|staff_error/);
    expect(t).toMatch(/phone/i);
  });

  it('the page names the patient but a plaintext code is never listed (only status, issued and expiry per code)', async () => {
    await show();
    expect(norm(document.body.textContent)).toContain(PATIENT.display_name);
    expect(document.body.textContent).not.toContain(CODE);
  });

  it('has no axe violations (list + empty state)', async () => {
    const { container } = await show();
    const res = await axe.run(container);
    expect(res.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  });
});

describe('issue dialog (US-EN-03.1, 03.6; W8 flow)', () => {
  it('[Issue app code] opens a dialog: relationship defaults to self, masked record phone offered, consent text and version shown read-only', async () => {
    await show();
    const d = await openIssue();
    const rel = within(d).getByLabelText(/relationship/i) as HTMLSelectElement | HTMLInputElement;
    expect(norm(rel.tagName === 'SELECT' ? (rel as HTMLSelectElement).selectedOptions[0]?.textContent : (rel as HTMLInputElement).value || rel.textContent)).toMatch(/self/i);
    expect(norm(d.textContent)).toContain('+977•••••42');
    expect(norm(d.textContent)).toContain(CONSENT.text);
    expect(norm(d.textContent)).toContain(CONSENT.version);
    const text = within(d).getByText(CONSENT.text);
    expect(text.closest('textarea, input')).toBeNull(); // read-only text, not an editable field
  });

  it('Issue sends { patient_id, relationship, consented_by, identity_check_method, bind_phone: record } and no phone_e164', async () => {
    const { actions: a } = await show();
    const d = await openIssue();
    await choose(d, /consent(ed)? by|who consents/i, /patient/i);
    await choose(d, /identity check/i, /^photo id$/i);
    await choose(d, /phone/i, /record|on record|patient'?s phone/i);
    await tick(d);
    await userEvent.setup().click(within(d).getByRole('button', { name: /^issue$/i }));
    await waitFor(() => expect(a.issue).toHaveBeenCalledTimes(1));
    expect(a.issue.mock.calls[0]![0]).toEqual({ patient_id: PATIENT.id, relationship: 'self', consented_by: 'patient', identity_check_method: 'photo_id', bind_phone: 'record' });
  });

  it('guardian for a minor (US-EN-03.6): relationship child, consented by guardian, identity guardian photo ID, other phone -> phone_e164 is sent', async () => {
    const { actions: a } = await show();
    const d = await openIssue();
    await choose(d, /relationship/i, /child/i);
    await choose(d, /consent(ed)? by|who consents/i, /guardian/i);
    await choose(d, /identity check/i, /guardian photo id/i);
    await choose(d, /phone/i, /another|other/i);
    const phone = within(d).getByLabelText(/(guardian|other|bound).*phone|phone number/i);
    await userEvent.setup().type(phone, '+9779851000013');
    await tick(d);
    await userEvent.setup().click(within(d).getByRole('button', { name: /^issue$/i }));
    await waitFor(() => expect(a.issue).toHaveBeenCalledTimes(1));
    expect(a.issue.mock.calls[0]![0]).toEqual({ patient_id: PATIENT.id, relationship: 'child', consented_by: 'guardian', identity_check_method: 'guardian_photo_id', bind_phone: 'other', phone_e164: '+9779851000013' });
  });

  it('binding another phone without a valid E.164 number blocks Issue (no action call) and shows an error', async () => {
    const { actions: a } = await show();
    const d = await openIssue();
    await choose(d, /consent(ed)? by|who consents/i, /patient/i);
    await choose(d, /identity check/i, /^photo id$/i);
    await choose(d, /phone/i, /another|other/i);
    await userEvent.setup().type(within(d).getByLabelText(/(guardian|other|bound).*phone|phone number/i), '98412');
    await userEvent.setup().click(within(d).getByRole('button', { name: /^issue$/i }));
    expect(a.issue).not.toHaveBeenCalled();
    expect(within(dialog()).getAllByRole('alert').length + within(dialog()).queryAllByText(/\+|E\.164|valid/i).length).toBeGreaterThan(0);
  });

  it('a record without a phone disables "phone on record" (only another phone can be bound)', async () => {
    await show(actions(), { recordPhoneMasked: null });
    const d = await openIssue();
    const t = norm(d.textContent);
    expect(t).not.toContain('+977•••••42');
    const opt = within(d).queryByRole('radio', { name: /record/i }) as HTMLInputElement | null;
    if (opt) expect(opt.disabled).toBe(true);
  });

  it('API refusal (engagement.link_limit_reached) is shown as an alert, no code appears, the dialog stays open', async () => {
    const a = actions({ issue: vi.fn(async () => { throw Object.assign(new Error('limit'), { code: 'engagement.link_limit_reached', status: 409 }); }) });
    await show(a);
    const d = await openIssue();
    await choose(d, /consent(ed)? by|who consents/i, /patient/i);
    await choose(d, /identity check/i, /^photo id$/i);
    await choose(d, /phone/i, /record|on record|patient'?s phone/i);
    await tick(d);
    await userEvent.setup().click(within(d).getByRole('button', { name: /^issue$/i }));
    await waitFor(() => expect(within(dialog()).getAllByRole('alert').length).toBeGreaterThan(0));
    expect(document.body.textContent).not.toContain(CODE);
  });
});

describe('confirmation checkbox (04-UI-UX.md:247)', () => {
  it('Issue with the identity/agreement checkbox unticked makes no a.issue call', async () => {
    const { actions: a } = await show();
    const d = await openIssue();
    await choose(d, /consent(ed)? by|who consents/i, /patient/i);
    await choose(d, /identity check/i, /^photo id$/i);
    await choose(d, /phone/i, /record|on record|patient'?s phone/i);
    expect((within(d).getByRole('checkbox', { name: /identity and they agreed/i }) as HTMLInputElement).checked).toBe(false);
    await userEvent.setup().click(within(d).getByRole('button', { name: /^issue$/i }));
    expect(a.issue).not.toHaveBeenCalled();
  });
});

describe('code shown once (done_when: code shown once)', () => {
  async function issueOnce(a = actions()) {
    const r = await show(a);
    const d = await openIssue();
    await choose(d, /consent(ed)? by|who consents/i, /patient/i);
    await choose(d, /identity check/i, /^photo id$/i);
    await choose(d, /phone/i, /record|on record|patient'?s phone/i);
    await tick(d);
    await userEvent.setup().click(within(d).getByRole('button', { name: /^issue$/i }));
    await waitFor(() => expect(document.body.textContent).toContain(CODE));
    return { ...r, d };
  }

  it('after Issue the code is shown in large type with "works once, only on the phone ending in ••42, until <expiry in Asia/Kathmandu>" and a [Print slip] button', async () => {
    await issueOnce();
    const t = norm(document.body.textContent);
    expect(t).toMatch(/works once/i);
    expect(t).toMatch(/only on the phone ending in\s*[•*.]*\s*42/i);
    expect(t).toMatch(/\b10:00\b/);
    expect(t).not.toMatch(/\b04:15\b/);
    expect(screen.getByRole('button', { name: /print slip/i })).toBeTruthy();
  });

  it('[Print slip] prints through the PrintFrame iframe, never the main window (its header names the patient)', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    await issueOnce();
    // PrintFrame removes its iframe once it has printed, so record the insertion instead of querying afterwards.
    let sawIframe = false;
    const mo = new MutationObserver((ms) => { for (const m of ms) m.addedNodes.forEach((n) => { if (n.nodeName === 'IFRAME') sawIframe = true; }); });
    mo.observe(document.body, { childList: true, subtree: true });
    await userEvent.setup().click(screen.getByRole('button', { name: /print slip/i }));
    await waitFor(() => expect(sawIframe).toBe(true));
    mo.disconnect();
    expect(print).not.toHaveBeenCalled();
  });

  it('closing the dialog removes the code from the DOM for good: re-opening, refresh and re-render never show it again; the page list refreshes', async () => {
    const { actions: a, rerender } = await issueOnce();
    const close = screen.queryByRole('button', { name: /^(done|close)$/i }) ?? within(dialog()).getAllByRole('button').find((b) => /done|close/i.test(b.textContent ?? b.getAttribute('aria-label') ?? ''))!;
    await userEvent.setup().click(close as HTMLElement);
    await waitFor(() => expect(document.body.textContent).not.toContain(CODE));
    await waitFor(() => expect(a.refresh).toHaveBeenCalled());
    const C = await load('AppAccess');
    rerender(<ToastProvider><C patient={PATIENT} links={LINKS()} codes={CODES()} recordPhoneMasked="+977•••••42" consent={CONSENT} labName={LAB} actions={a} /></ToastProvider>);
    expect(document.body.textContent).not.toContain(CODE);
    await openIssue();
    expect(document.body.textContent).not.toContain(CODE);
  });

  it('the code is never written to the URL, browser storage, console or a title/aria attribute', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {}); const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    await issueOnce();
    expect(window.location.href).not.toContain(CODE);
    expect(JSON.stringify({ ...window.localStorage })).not.toContain(CODE);
    expect(JSON.stringify({ ...window.sessionStorage })).not.toContain(CODE);
    expect(JSON.stringify([...log.mock.calls, ...info.mock.calls])).not.toContain(CODE);
    for (const el of Array.from(document.querySelectorAll('[title], [aria-label], [data-code], [value]'))) {
      for (const a of ['title', 'aria-label', 'data-code', 'value']) expect(el.getAttribute(a) ?? '', a).not.toContain(CODE);
    }
  });

  it('the printed slip has no patient name (component test): code, expiry, lab name, bound-phone tail only', async () => {
    await issueOnce();
    const slip = screen.getByTestId('code-slip');
    const t = norm(slip.textContent);
    expect(t).toContain(CODE);
    expect(t).toContain(LAB);
    expect(t).toMatch(/42/);
    expect(t).toMatch(/\b10:00\b/);
    for (const part of PATIENT.display_name.split(' ')) expect(t, part).not.toContain(part);
    expect(t).not.toMatch(/\+977\d{5,}/);
    expect(document.body.textContent).toContain(PATIENT.display_name); // the page itself still names the patient
  });
});

describe('CodeSlip (standalone)', () => {
  it('renders code, expiry (Asia/Kathmandu), lab name and masked phone tail; no name, no patient id, no full phone', async () => {
    const C = await load('CodeSlip');
    render(<C code={CODE} expiresAt={EXPIRES} boundPhoneMasked="+977•••••42" labName={LAB} />);
    const slip = screen.getByTestId('code-slip');
    const t = norm(slip.textContent);
    expect(t).toContain(CODE); expect(t).toContain(LAB); expect(t).toMatch(/\b10:00\b/); expect(t).toMatch(/42/);
    expect(slip.innerHTML).not.toContain(PATIENT.id);
    expect(t).not.toMatch(/\+977\d{5,}/);
  });
});

describe('revocation (US-EN-06.6, L2, L4)', () => {
  it('only active/suspended links offer [Revoke]; it asks for a reason and calls revokeLink(link, {reason_code})', async () => {
    const { actions: a } = await show();
    const buttons = screen.getAllByRole('button', { name: /revoke/i }).filter((b) => !/code/i.test(b.getAttribute('aria-label') ?? ''));
    expect(buttons.length).toBeGreaterThan(0);
    await userEvent.setup().click(buttons[0]!);
    const d = dialog();
    await choose(d, /reason/i, /patient request/i);
    await userEvent.setup().click(within(d).getByRole('button', { name: /revoke/i }));
    await waitFor(() => expect(a.revokeLink).toHaveBeenCalledTimes(1));
    expect((a.revokeLink.mock.calls[0]![0] as any).link_id).toBeDefined();
    expect(a.revokeLink.mock.calls[0]![1]).toEqual({ reason_code: 'patient_request' });
  });

  it('only an issued code offers revoke; calling it passes the code row', async () => {
    const { actions: a } = await show();
    const codeButtons = screen.getAllByRole('button', { name: /revoke code|revoke.*code/i });
    expect(codeButtons).toHaveLength(1);
    await userEvent.setup().click(codeButtons[0]!);
    const confirm = screen.queryByRole('dialog') ? within(dialog()).getByRole('button', { name: /revoke/i }) : null;
    if (confirm) await userEvent.setup().click(confirm);
    await waitFor(() => expect(a.revokeCode).toHaveBeenCalledTimes(1));
    expect((a.revokeCode.mock.calls[0]![0] as any).link_code_id).toBe(id(201));
  });
});
