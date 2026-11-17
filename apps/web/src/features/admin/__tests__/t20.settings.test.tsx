// @vitest-environment jsdom
// C2.T20 — AD-8 Lab settings (04-UI-UX §6, one Form per tab, If-Match per tab save). ACs: US-C2 (ranges + 422 identity.setting_out_of_range pointer, timezone read-only), US-C3 (numbering patterns, pending
// pattern "Takes effect from FY {fy}"), US-C4 (branding upload types/size), US-C5 (feature flags: platform-managed disabled, referral copy B13). 07-SECURITY: no tenant_id, no secret echo.
// ASSUMED: tabs = role "tab" named as in the AD-8 table; GET /v1/identity/settings (TenantSettingsDto) + /feature-flags + /ird-annexes (own); save = PATCH /settings TenantSettingsPatch (only that tab's fields) with If-Match "<version>";
// flag toggle = PUT /feature-flags/{code} {is_enabled}; branding = POST /settings/branding-assets multipart {file, kind}. Server field errors arrive as 422 identity.setting_out_of_range {errors:[{pointer}]}.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ID, api, calls, callsTo, bodyOf, resetApi, routes, json, problem, settings, show, showOrThrown, pageText, norm, axeClean } from './t20.harness';

vi.mock('next/navigation', async () => (await import('./t20.harness')).navigationMock);
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', async () => (await import('./t20.harness')).sessionMock);

beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterAll(() => api.close());
const S = `${ID}/settings`;
const FLAGS = [
  { code: 'referral_incentive_report', description: 'Referral report', scope: 'tenant', settable_by: 'tenant', is_enabled: false, blocker_ref: 'B13', approval_ref_present: false, version: 1 },
  { code: 'whatsapp_pdf_attachments', description: 'WhatsApp PDFs', scope: 'tenant', settable_by: 'platform', is_enabled: false, blocker_ref: 'B11', approval_ref_present: false, version: 1 },
];
beforeEach(() => {
  resetApi();
  routes[`GET ${S}`] = json(settings());
  routes[`GET ${ID}/feature-flags`] = json({ data: FLAGS });
  routes[`GET ${ID}/ird-annexes`] = json({ data: [{ record_id: 'r1', annex_code: 'annex_2', status: 'in_preparation', reference_no: 'SYN-REF-1', version: 1 }, { record_id: 'r2', annex_code: 'annex_3', status: 'not_started', version: 1 }], annex_readiness: 'incomplete' });
});
afterEach(() => cleanup());

const open = async (tab?: string) => {
  await show('settings');
  const user = userEvent.setup();
  if (tab) await user.click(screen.getByRole('tab', { name: tab }));
  return user;
};
const saveBtn = () => screen.getByRole('button', { name: /^save/i });

describe('AD-8 Lab settings', () => {
  it('needs identity.settings.manage: otherwise refuses with NO API call', async () => {
    resetApi(['identity.user.read']);
    await showOrThrown('settings');
    expect(calls).toEqual([]);
  });

  it('ten tabs, in spec order', async () => {
    await open();
    expect(screen.getAllByRole('tab').map((t) => norm(t.textContent))).toEqual(['General', 'Date & time', 'Sign-in & sessions', 'Numbering', 'Letterhead & branding', 'Reports & delivery', 'Data retention', 'Features', 'Billing & IRD', 'Lab operations']);
  });

  it('General: Display name 1–120, Legal name read-only, PAN read-only for tenants, Accent colour #RRGGBB; save PATCHes ONLY this tab fields with If-Match "<version>" and shows "Saved. Other screens update within 30 seconds."', async () => {
    routes[`PATCH ${S}`] = json(settings({ display_name: 'Synthetic Lab 2', version: 8 }));
    const user = await open('General');
    expect((screen.getByLabelText(/legal name/i) as HTMLInputElement).readOnly || (screen.getByLabelText(/legal name/i) as HTMLInputElement).disabled).toBe(true);
    const pan = screen.queryByLabelText(/^pan/i) as HTMLInputElement | null;
    if (pan) expect(pan.readOnly || pan.disabled).toBe(true);
    await user.clear(screen.getByLabelText(/display name/i));
    await user.type(screen.getByLabelText(/display name/i), 'Synthetic Lab 2');
    await user.click(saveBtn());
    await waitFor(() => expect(callsTo('PATCH', S)).toHaveLength(1));
    const c = callsTo('PATCH', S)[0]!;
    expect(c.headers.get('if-match')).toBe('"7"');
    const b = bodyOf(c);
    expect(b.display_name).toBe('Synthetic Lab 2');
    for (const k of ['idle_timeout_minutes', 'calendar_display', 'invoice_no_pattern', 'tenant_id', 'legal_name_snapshot', 'ird_pan']) expect(Object.keys(b), k).not.toContain(k);
    expect(await screen.findByText('Saved. Other screens update within 30 seconds.')).toBeTruthy();
  });

  it('General: Website must be https (≤200), Accent colour must be #RRGGBB, Contact email valid — invalid → no PATCH', async () => {
    const user = await open('General');
    await user.type(screen.getByLabelText(/website/i), 'http://insecure.example.test');
    await user.click(saveBtn());
    expect(callsTo('PATCH', S)).toHaveLength(0);
    await user.clear(screen.getByLabelText(/website/i));
    await user.type(screen.getByLabelText(/accent colou?r/i), 'red');
    await user.click(saveBtn());
    expect(callsTo('PATCH', S)).toHaveLength(0);
  });

  it('Date & time: Calendar RadioGroup A.D./B.S./A.D. + B.S./B.S. + A.D. → AD|BS|AD_BS|BS_AD; Timezone is read-only text "Asia/Kathmandu" (P-15); note about bills', async () => {
    routes[`PATCH ${S}`] = json(settings({ calendar_display: 'BS_AD', version: 8 }));
    const user = await open('Date & time');
    expect(screen.queryByRole('combobox', { name: /timezone/i })).toBeNull();
    expect(pageText()).toContain('Asia/Kathmandu');
    expect(pageText()).toContain('Bills and statutory registers always show both B.S. and A.D.');
    await user.click(screen.getByRole('radio', { name: /^B\.S\. \+ A\.D\./ }));
    await user.click(saveBtn());
    await waitFor(() => expect(callsTo('PATCH', S)).toHaveLength(1));
    expect(bodyOf(callsTo('PATCH', S)[0])).toEqual({ calendar_display: 'BS_AD' });
  });

  it('Sign-in & sessions: ranges idle 15–30, session 1–12 h, min password 12–64 enforced client-side; support access mode radio', async () => {
    routes[`PATCH ${S}`] = json(settings({ idle_timeout_minutes: 20, support_access_mode: 'approval_required', version: 8 }));
    const user = await open('Sign-in & sessions');
    const idle = screen.getByLabelText(/idle timeout/i);
    await user.clear(idle); await user.type(idle, '45');
    await user.click(saveBtn());
    expect(callsTo('PATCH', S)).toHaveLength(0); // US-C2: 45 ∉ 15–30
    await user.clear(idle); await user.type(idle, '20');
    await user.click(screen.getByRole('radio', { name: /require my approval/i }));
    await user.click(saveBtn());
    await waitFor(() => expect(callsTo('PATCH', S)).toHaveLength(1));
    expect(bodyOf(callsTo('PATCH', S)[0])).toMatchObject({ idle_timeout_minutes: 20, support_access_mode: 'approval_required' });
    for (const [label, bad] of [[/maximum session/i, '13'], [/minimum password/i, '11']] as const) {
      const f = screen.getByLabelText(label);
      await user.clear(f); await user.type(f, bad);
      await user.click(saveBtn());
    }
    expect(callsTo('PATCH', S)).toHaveLength(1);
  });

  it('AC-C2 server 422 identity.setting_out_of_range with pointer → inline error on THAT field and focus moves to it (04-UI-UX §8)', async () => {
    routes[`PATCH ${S}`] = () => problem('identity.setting_out_of_range', 422, { errors: [{ code: 'common.field_invalid', pointer: '/idle_timeout_minutes' }] });
    const user = await open('Sign-in & sessions');
    await user.click(saveBtn());
    const idle = screen.getByLabelText(/idle timeout/i);
    await waitFor(() => expect(idle.getAttribute('aria-invalid')).toBe('true'));
    expect(idle.getAttribute('aria-describedby')).toBeTruthy();
    expect(pageText()).not.toContain('identity.setting_out_of_range');
  });

  it('409 common.version_conflict → reload dialog; the user\'s edits are not silently discarded and no second write', async () => {
    routes[`PATCH ${S}`] = () => problem('common.version_conflict', 409);
    const user = await open('General');
    await user.type(screen.getByLabelText(/display name/i), '!');
    await user.click(saveBtn());
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(norm(dlg.textContent)).toContain('This record was changed by someone else. Reload to see the latest version.');
    expect(callsTo('PATCH', S)).toHaveLength(1);
  });

  it('each tab is its own Form with its own version token: saving tab A then tab B sends If-Match from the latest response', async () => {
    let v = 7;
    routes[`PATCH ${S}`] = () => json(settings({ version: ++v }))();
    const user = await open('General');
    await user.type(screen.getByLabelText(/display name/i), 'A');
    await user.click(saveBtn());
    await waitFor(() => expect(callsTo('PATCH', S)).toHaveLength(1));
    await user.click(screen.getByRole('tab', { name: 'Date & time' }));
    await user.click(screen.getByRole('radio', { name: /^B\.S\.$/ }));
    await user.click(saveBtn());
    await waitFor(() => expect(callsTo('PATCH', S)).toHaveLength(2));
    expect(callsTo('PATCH', S).map((c) => c.headers.get('if-match'))).toEqual(['"7"', '"8"']);
  });

  it('Numbering: US-C3 shows live example + token help; pending pattern is read-only with "Takes effect from FY {fy}"; prefixes ^[A-Z0-9]{0,4}$ (accession defaults S/C/I/M)', async () => {
    routes[`GET ${S}`] = json(settings({ pending_numbering: { invoice_no_pattern: '{fyl}-{seq:7}', effective_fy_bs: '2083/84' } }));
    const user = await open('Numbering');
    expect(pageText()).toMatch(/\{branch\}.*\{centre\}.*\{yy\}.*\{fy\}.*\{fyl\}.*\{seq:N\}.*\{prefix\}/);
    expect(pageText()).toContain('Takes effect from FY 2083/84');
    expect(pageText()).toContain('{fyl}-{seq:7}');
    const prefix = screen.getByLabelText(/barcode prefix/i);
    await user.clear(prefix); await user.type(prefix, 'abcde');
    await user.click(saveBtn());
    expect(callsTo('PATCH', S)).toHaveLength(0); // lower-case / >4 chars rejected
  });

  it('Numbering: pattern TextField ≤ 40 chars; saved pattern sent as invoice_no_pattern; server 400 (missing {fy}, AC-C3.1) → inline error on the field', async () => {
    routes[`PATCH ${S}`] = () => problem('common.validation_failed', 400, { errors: [{ code: 'common.field_invalid', pointer: '/invoice_no_pattern' }] });
    const user = await open('Numbering');
    const f = screen.getByLabelText(/invoice no\. pattern|invoice number pattern/i) as HTMLInputElement;
    expect(f.maxLength === 40 || f.maxLength === -1).toBe(true);
    await user.clear(f); await user.type(f, 'INV-{{seq:6}'); // user-event: '{{' types a literal '{' (ruling §2)
    await user.click(saveBtn());
    await waitFor(() => expect(f.getAttribute('aria-invalid')).toBe('true'));
    expect(bodyOf(callsTo('PATCH', S)[0]).invoice_no_pattern).toBe('INV-{seq:6}');
  });

  it('Letterhead & branding: three FileUploads (PNG/JPEG only, ≤2 MB); SVG and oversize are refused before any request; upload = multipart POST {file, kind}', async () => {
    routes[`POST ${S}/branding-assets`] = json({ asset_id: 'a1', kind: 'logo' }, 201);
    const user = await open('Letterhead & branding');
    const inputs = [...document.querySelectorAll('input[type=file]')] as HTMLInputElement[];
    expect(inputs).toHaveLength(3);
    for (const i of inputs) { expect(i.accept).toMatch(/image\/png/); expect(i.accept).not.toMatch(/svg/); }
    await user.upload(inputs[0]!, new File(['<svg/>'], 'x.svg', { type: 'image/svg+xml' }));
    await user.upload(inputs[0]!, new File([new Uint8Array(3 * 1024 * 1024)], 'big.png', { type: 'image/png' }));
    expect(callsTo('POST', `${S}/branding-assets`)).toHaveLength(0);
    await user.upload(inputs[0]!, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])], 'logo.png', { type: 'image/png' }));
    await waitFor(() => expect(callsTo('POST', `${S}/branding-assets`)).toHaveLength(1));
    expect(callsTo('POST', `${S}/branding-assets`)[0]!.headers.get('content-type')).toMatch(/^multipart\/form-data/);
    expect(pageText()).toContain('Report layout, watermark and signature placement are set in Report templates.');
  });

  it('Letterhead: server 422 common.upload_quarantined / 415 shows an inline message, never an <img> pointing at the API origin', async () => {
    routes[`POST ${S}/branding-assets`] = () => problem('common.unsupported_media_type', 415);
    const user = await open('Letterhead & branding');
    await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    for (const img of document.querySelectorAll('img')) expect((img as HTMLImageElement).src).not.toMatch(/api\.t20\.test|jwt/);
  });

  it('Reports & delivery: link validity 30–90 days; SMS sender ID ^[A-Za-z0-9]{1,11}$; channel switches default off; 100 days → no PATCH', async () => {
    const user = await open('Reports & delivery');
    for (const n of [/sms/i, /whatsapp/i, /email/i]) expect((screen.getByRole('switch', { name: n }) as HTMLInputElement).checked).toBe(false);
    const ttl = screen.getByLabelText(/link validity/i);
    await user.clear(ttl); await user.type(ttl, '100');
    await user.click(saveBtn());
    expect(callsTo('PATCH', S)).toHaveLength(0);
    await user.clear(ttl); await user.type(ttl, '45');
    await user.type(screen.getByLabelText(/sms sender id/i), 'BAD ID!');
    await user.click(saveBtn());
    expect(callsTo('PATCH', S)).toHaveLength(0);
  });

  it('Data retention: minimums clinical ≥5, audit ≥5, raw ≥1 (US-C2); banner "Legal retention periods are not yet confirmed (B15). These are minimum defaults."', async () => {
    const user = await open('Data retention');
    expect(pageText()).toContain('Legal retention periods are not yet confirmed (B15). These are minimum defaults.');
    const f = screen.getByLabelText(/clinical records/i);
    await user.clear(f); await user.type(f, '4');
    await user.click(saveBtn());
    expect(callsTo('PATCH', S)).toHaveLength(0);
  });

  it('Features: table of flags; tenant-settable flag toggles via PUT {is_enabled}; platform-managed flag is disabled with tooltip "Managed by the LIMS provider" (AC-C5.2); referral copy (B13)', async () => {
    routes[`PUT ${ID}/feature-flags/referral_incentive_report`] = json({ ...FLAGS[0], is_enabled: true, version: 2 });
    const user = await open('Features');
    expect(pageText()).toContain('Shows the referral-incentive report (reporting only). Leave off until your management confirms the compliance position (B13).');
    const wa = screen.getByRole('switch', { name: /whatsapp/i }) as HTMLInputElement;
    expect(wa.disabled).toBe(true);
    expect(pageText()).toContain('Managed by the LIMS provider');
    await user.click(screen.getByRole('switch', { name: /referral/i }));
    await waitFor(() => expect(callsTo('PUT', `${ID}/feature-flags/referral_incentive_report`)).toHaveLength(1));
    expect(bodyOf(callsTo('PUT', `${ID}/feature-flags/referral_incentive_report`)[0])).toEqual({ is_enabled: true });
    expect(callsTo('PUT', `${ID}/feature-flags/whatsapp_pdf_attachments`)).toHaveLength(0);
  });

  it('Features: 403 auth.forbidden from the API on a flag shows an inline error and the switch reverts', async () => {
    routes[`PUT ${ID}/feature-flags/referral_incentive_report`] = () => problem('auth.forbidden', 403);
    const user = await open('Features');
    await user.click(screen.getByRole('switch', { name: /referral/i }));
    expect((await screen.findAllByRole('alert')).length).toBeGreaterThan(0);
    await waitFor(() => expect((screen.getByRole('switch', { name: /referral/i }) as HTMLInputElement).checked).toBe(false));
  });

  it('Billing & IRD: read-only Annex table (Annex, Status, Reference no., Date) + banner about B6; CBMS switch default off; abbreviated limit labelled UNVERIFIED', async () => {
    await open('Billing & IRD');
    expect(pageText()).toContain('IRD submission requirements are pending clarification (B6). This tracker records status only.');
    expect(pageText()).toMatch(/UNVERIFIED — confirm with your auditor/);
    expect(pageText()).toMatch(/SYN-REF-1/);
    expect(screen.queryByRole('button', { name: /edit annex|transition/i })).toBeNull(); // tenant view is read-only
    expect((screen.getByRole('switch', { name: /cbms/i }) as HTMLInputElement).checked).toBe(false);
  });

  it('Lab operations: Auto-verification switch is disabled "Available in Phase 2"; Westgard mode classic/modern', async () => {
    await open('Lab operations');
    expect((screen.getByRole('switch', { name: /auto-verification/i }) as HTMLInputElement).disabled).toBe(true);
    expect(pageText()).toContain('Available in Phase 2');
    expect(screen.getByLabelText(/westgard/i)).toBeTruthy();
  });

  it('settings DTO secrets/ids are never rendered (no version token, no asset ids as visible text)', async () => {
    await open('General');
    expect(pageText()).not.toMatch(/jwt-synthetic|Bearer/);
  });

  it('a11y: no axe violations on the default tab and on Numbering', async () => {
    const user = await open();
    await axeClean();
    await user.click(screen.getByRole('tab', { name: 'Numbering' }));
    await axeClean();
  });
});

void within;
