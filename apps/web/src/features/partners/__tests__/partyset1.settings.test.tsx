// @vitest-environment jsdom
// T0D-PARTYSET-1 — Commercial settings tab on the partner detail (done_when 2, 6; LD-321, LD-310, LD-353 template 4 SETTINGS).
// Through the PAGE default export app/(staff)/partners/[partner_id]/page.tsx (server page -> BFF -> MSW -> client parts).
// PINNED UI NAMES (tester choice; writer may dispute through the ruling path):
//   - a tab "Commercial settings" (shown with partners.party_setting.read) next to Overview / Users / ...; the tab body has six groups (role=group, name):
//       Reports: switch "Auto release reports", text "Lab number scheme" | Messaging: switch "WhatsApp"
//       Billing cycle and invoice periods: select "Billing cycle" (Daily, Weekly, Fortnightly, Monthly, Quarterly), switch "Insurance", text "Invoice payment (days)", "Warning period (days)", "Blocking period (days)", switch "Block overdue automatically"
//       Interest and priority: text "Interest per day (%)", select "Priority" (P1..P5) | Commission and TDS: text "Commission (%)", "TDS (%)" | Print: switch "Print exception", select "Header and footer" (With, Without, Both).
//   - percent is shown from basis points with two decimals (1250 -> 12.50) and typed as percent (at most two decimals, 0 to 100); days are whole numbers 0 to 365.
//   - button "Save settings": PUT /v1/partners/admin/party-settings/partner/<id> with ONLY the changed fields (integer bp / days), If-Match "<version>" except on the first save of a default row (no If-Match);
//     clearing the lab number scheme sends `unset: ['lab_number_scheme_code']`. No Idempotency-Key (the operation has none).
//   - server messages (422 errors[].message by path) show under the field; 409 shows a banner with a Refresh button; a failing read shows a banner in the tab only.
//   - without partners.party_setting.manage every control is disabled and the reason t('partners.partyset.reason.manage') (names the code) is visible and linked by aria-describedby on Save settings.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { t } from '@/core/i18n/messages';
import { API, ID, PARTNER, PERM, ROUTE, SETTING_DEFAULT, SETTING_SAVED, TM, api, isDisabled, norm, openPage, pickOption, prob, quiet, reasonOf, selectTrigger } from './partyset1.harness';

beforeAll(() => api.listen({ onUnhandledFrame: 'error' }));
beforeEach(() => { API.reset(); TM.refresh.mockReset(); TM.push.mockClear(); TM.replace.mockClear(); });
afterEach(() => { cleanup(); api.resetHandlers(); });
afterAll(() => api.close());

const READ = [PERM.partnerRead, PERM.partnerManage, PERM.settingRead];
const MANAGE = [...READ, PERM.settingManage];
const SETTINGS_PATH = `/v1/partners/admin/party-settings/partner/${PARTNER}`;
const REASON = 'partners.partyset.reason.manage';

const openTab = async (perms = MANAGE) => {
  const user = userEvent.setup();
  const r = await openPage(ROUTE.partner, { perms, params: { partner_id: PARTNER } });
  await user.click(await screen.findByRole('tab', { name: /commercial settings/i }));
  return { user, ...r };
};
const group = (name: RegExp) => screen.getByRole('group', { name });
const box = (label: RegExp) => screen.getByLabelText(label) as HTMLInputElement;
const typeInto = async (user: ReturnType<typeof userEvent.setup>, el: HTMLElement, v: string) => { await user.clear(el); if (v) await user.type(el, v); };
const save = () => screen.getByRole('button', { name: /^save settings$/i });
const puts = () => API.find('PUT', /party-settings/);

describe('Commercial settings tab: structure (done_when 2)', () => {
  it('the tab is there with partners.party_setting.read and absent without it', async () => {
    await openPage(ROUTE.partner, { perms: [PERM.partnerRead], params: { partner_id: PARTNER } });
    await screen.findByRole('tab', { name: /overview/i });
    expect(screen.queryByRole('tab', { name: /commercial settings/i })).toBeNull();
    expect(API.find('GET', /party-settings/)).toHaveLength(0);
  });
  it('reads the settings of THIS partner: GET party-settings/partner/<id>', async () => {
    await openTab(READ);
    await waitFor(() => expect(API.find('GET', /party-settings/).length).toBeGreaterThan(0));
    expect(API.find('GET', /party-settings/)[0]!.path).toBe(SETTINGS_PATH);
  });
  it('has the six compact groups, each with its fields', async () => {
    await openTab();
    const spec: [RegExp, RegExp[]][] = [
      [/^reports$/i, [/^auto release reports/i, /^lab number scheme/i]],
      [/^messaging$/i, [/^whatsapp/i]],
      [/^billing cycle and invoice periods$/i, [/^billing cycle/i, /^insurance/i, /^invoice payment/i, /^warning period/i, /^blocking period/i, /^block overdue automatically/i]],
      [/^interest and priority$/i, [/^interest per day/i, /^priority/i]],
      [/^commission and tds$/i, [/^commission/i, /^tds/i]],
      [/^print$/i, [/^print exception/i, /^header and footer/i]],
    ];
    for (const [g, fields] of spec) for (const f of fields) expect(within(group(g)).getByLabelText(f), `${String(g)} > ${String(f)}`).toBeTruthy();
  });
  it('shows the saved values: percent from basis points (1250 -> 12.50, 100 -> 1.00, 5 -> 0.05), days, codes, switches, selects', async () => {
    API.setting = SETTING_SAVED;
    await openTab();
    expect(box(/^commission/i).value).toBe('12.50');
    expect(box(/^tds/i).value).toBe('1.00');
    expect(box(/^interest per day/i).value).toBe('0.05');
    expect(box(/^invoice payment/i).value).toBe('30');
    expect(box(/^warning period/i).value).toBe('45');
    expect(box(/^blocking period/i).value).toBe('90');
    expect(box(/^lab number scheme/i).value).toBe('KTM_A');
    expect(screen.getByRole('switch', { name: /^auto release reports/i })).toHaveProperty('checked', true);
    expect(screen.getByRole('switch', { name: /^whatsapp/i })).toHaveProperty('checked', true);
    expect(screen.getByRole('switch', { name: /^insurance/i })).toHaveProperty('checked', false);
    expect(screen.getByRole('switch', { name: /^block overdue automatically/i })).toHaveProperty('checked', true);
    expect(norm(selectTrigger(group(/^billing cycle/i), /^billing cycle/i).textContent)).toMatch(/quarterly/i);
    expect(norm(selectTrigger(group(/^interest and priority$/i), /^priority/i).textContent)).toMatch(/P2/);
    expect(norm(selectTrigger(group(/^print$/i), /^header and footer/i).textContent)).toMatch(/without/i);
  });
  it('an unsaved party shows the defaults with a plain note (t partners.partyset.defaults); a saved one has no such note', async () => {
    expect(t('partners.partyset.defaults')).not.toBe('partners.partyset.defaults');
    const { unmount } = await openTab();
    expect(box(/^commission/i).value).toBe('0.00');
    expect(box(/^invoice payment/i).value).toBe('30');
    expect(document.body.textContent).toContain(t('partners.partyset.defaults'));
    unmount(); cleanup();
    API.setting = SETTING_SAVED;
    await openTab();
    expect(document.body.textContent).not.toContain(t('partners.partyset.defaults'));
  });
  it('interest per day is explained as a statement line only (LD-321: never posted automatically)', async () => {
    await openTab();
    expect(norm(group(/^interest and priority$/i).textContent)).toMatch(/statement/i);
  });
});

describe('Commercial settings tab: save (done_when 2, 6)', () => {
  it('the first save of a default row sends only the changed fields, converted to integers, with NO If-Match', async () => {
    const { user } = await openTab();
    await typeInto(user, box(/^commission/i), '12.5');
    await typeInto(user, box(/^invoice blocking|^blocking period/i), '75');
    await user.click(screen.getByRole('switch', { name: /^whatsapp/i }));
    await user.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const c = puts()[0]!;
    expect(c.path).toBe(SETTINGS_PATH);
    expect(c.json).toEqual({ commission_bp: 1250, invoice_blocking_days: 75, whatsapp_enabled: true });
    expect(c.headers.get('if-match')).toBeNull();
  });
  it('a later save sends If-Match "<version>" and only what changed (selects included)', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    await typeInto(user, box(/^interest per day/i), '0.25');
    await pickOption(user, group(/^billing cycle/i), /^billing cycle/i, /^weekly$/i);
    await pickOption(user, group(/^interest and priority$/i), /^priority/i, /^P1$/);
    await pickOption(user, group(/^print$/i), /^header and footer/i, /^both$/i);
    await user.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    const c = puts()[0]!;
    expect(c.headers.get('if-match')).toMatch(/^"?4"?$/);
    expect(c.json).toEqual({ interest_bp_per_day: 25, billing_cycle: 'weekly', priority: 'P1', header_footer_mode: 'both' });
  });
  it('percent edge values convert exactly, no float rounding: 0.07 -> 7, 100 -> 10000, 33.33 -> 3333, 0 -> 0', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    await typeInto(user, box(/^commission/i), '33.33');
    await typeInto(user, box(/^tds/i), '100');
    await typeInto(user, box(/^interest per day/i), '0.07');
    await user.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json).toEqual({ commission_bp: 3333, tds_bp: 10000, interest_bp_per_day: 7 });
    cleanup();
    API.calls.length = 0;
    const second = await openTab();
    await typeInto(second.user, box(/^tds/i), '0');
    await second.user.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json).toEqual({ tds_bp: 0 });
  });
  it('clearing the lab number scheme sends unset: [lab_number_scheme_code]', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    await typeInto(user, box(/^lab number scheme/i), '');
    await user.click(save());
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.json).toEqual({ unset: ['lab_number_scheme_code'] });
  });
  it('Save settings with nothing changed makes no call', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    await user.click(save());
    await quiet();
    expect(puts()).toHaveLength(0);
  });
  it('after a successful save the page refreshes and a success message from the catalogue shows', async () => {
    const { user } = await openTab();
    await typeInto(user, box(/^tds/i), '1');
    await user.click(save());
    await waitFor(() => expect(TM.refresh.mock.calls.length).toBeGreaterThan(0));
    expect(t('partners.partyset.saved')).not.toBe('partners.partyset.saved');
    await screen.findByText(t('partners.partyset.saved'));
  });
  it('a double press sends ONE request (busy guard)', async () => {
    API.writeDelayMs = 150;
    const { user } = await openTab();
    await typeInto(user, box(/^tds/i), '2');
    const b = save();
    await user.click(b); await user.click(b);
    await quiet(400);
    expect(puts()).toHaveLength(1);
  });
});

describe('Commercial settings tab: validation with the server messages (done_when 2)', () => {
  it.each([
    ['invoice payment days over 365', /^invoice payment/i, '366'],
    ['warning period negative', /^warning period/i, '-1'],
    ['blocking period with a decimal', /^blocking period/i, '1.5'],
    ['blocking period not a number', /^blocking period/i, 'abc'],
    ['commission above 100 percent', /^commission/i, '100.01'],
    ['tds with three decimals (a basis point is 0.01 percent)', /^tds/i, '1.005'],
    ['interest per day negative', /^interest per day/i, '-0.1'],
    ['commission empty', /^commission/i, ''],
  ])('%s: an inline error next to the field, no request', async (_n, label, value) => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    const el = box(label);
    await typeInto(user, el, value);
    await user.click(save());
    await quiet();
    expect(puts()).toHaveLength(0);
    await waitFor(() => expect(el.getAttribute('aria-invalid')).toBe('true'));
    expect(reasonOf(el) || el.closest('div')?.textContent).toBeTruthy();
  });
  it('the lab number scheme code is validated as a short plain code: 21 characters is refused before any request', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    await typeInto(user, box(/^lab number scheme/i), 'A'.repeat(21));
    await user.click(save());
    await quiet();
    expect(puts()).toHaveLength(0);
  });
  it('a 422 puts the server message of each error path under its field (errors[].message), and the form keeps what the user typed', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    API.fail = prob(422, 'common.validation_failed', [{ path: 'invoice_blocking_days', code: 'range', message: 'Blocking period must not be shorter than the warning period.' }, { path: 'commission_bp', code: 'range', message: 'Commission is above the allowed limit.' }]);
    await typeInto(user, box(/^blocking period/i), '10');
    await typeInto(user, box(/^commission/i), '50');
    await user.click(save());
    await screen.findByText('Blocking period must not be shorter than the warning period.');
    await screen.findByText('Commission is above the allowed limit.');
    expect(box(/^blocking period/i).value).toBe('10');
    expect(box(/^commission/i).value).toMatch(/^50(\.00)?$/);
    expect(box(/^blocking period/i).getAttribute('aria-invalid')).toBe('true');
  });
  it('a 409 version_conflict shows a banner with a Refresh button that reloads the page data', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab();
    API.fail = prob(409, 'common.version_conflict');
    await typeInto(user, box(/^tds/i), '3');
    await user.click(save());
    const refresh = await screen.findByRole('button', { name: /refresh/i });
    TM.refresh.mockClear();
    await user.click(refresh);
    expect(TM.refresh.mock.calls.length).toBeGreaterThan(0);
  });
  it('a 403 on save shows the catalogue message for no permission (no raw JSON)', async () => {
    const { user } = await openTab();
    API.fail = prob(403, 'auth.forbidden');
    await typeInto(user, box(/^tds/i), '3');
    await user.click(save());
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toMatch(/auth\.forbidden|urn:lims|\{"/);
  });
});

describe('Commercial settings tab: permission states and failures (done_when 7)', () => {
  it('with read only every control is disabled and Save settings is disabled with the visible reason (names partners.party_setting.manage)', async () => {
    API.setting = SETTING_SAVED;
    await openTab(READ);
    expect(t(REASON)).not.toBe(REASON);
    expect(t(REASON)).toContain('partners.party_setting.manage');
    const s = save();
    expect(isDisabled(s)).toBe(true);
    expect(reasonOf(s)).toContain(t(REASON));
    expect(document.body.textContent).toContain(t(REASON));
    for (const sw of screen.getAllByRole('switch')) expect(isDisabled(sw) || (sw as HTMLInputElement).disabled, 'switch disabled').toBe(true);
    for (const label of [/^commission/i, /^tds/i, /^interest per day/i, /^invoice payment/i, /^warning period/i, /^blocking period/i, /^lab number scheme/i]) expect(isDisabled(box(label)) || box(label).readOnly, String(label)).toBe(true);
    expect(isDisabled(selectTrigger(group(/^billing cycle/i), /^billing cycle/i))).toBe(true);
  });
  it('a failing settings read shows a banner in this tab only; the Overview tab still works', async () => {
    const user = userEvent.setup();
    API.readFail = 500; // only the PARTYSET reads are gated by the harness; the partner read itself still answers
    await openPage(ROUTE.partner, { perms: MANAGE, params: { partner_id: PARTNER } });
    await user.click(await screen.findByRole('tab', { name: /commercial settings/i }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: /^save settings$/i })).toBeNull();
    await user.click(screen.getByRole('tab', { name: /overview/i }));
    expect(document.body.textContent).toContain('Synthetic Partner Lab');
  });
  it('no PUT is ever sent without partners.party_setting.manage, even by keyboard (Enter on a field)', async () => {
    API.setting = SETTING_SAVED;
    const { user } = await openTab(READ);
    box(/^commission/i).focus();
    await user.keyboard('{Enter}');
    await quiet();
    expect(puts()).toHaveLength(0);
  });
});

describe('Commercial settings tab: quality (done_when 6)', () => {
  it('has no axe violations and every control is reachable by Tab in reading order (no tabindex above 0)', async () => {
    API.setting = SETTING_SAVED;
    await openTab();
    const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
    expect([...document.querySelectorAll('[tabindex]')].filter((e) => Number(e.getAttribute('tabindex')) > 0)).toEqual([]);
  });
  it('text comes from the message catalogue: no exclamation marks, no development notes, sentence case group names', async () => {
    await openTab();
    const text = norm(document.body.textContent);
    expect(text).not.toMatch(/!/);
    expect(text).not.toMatch(/\b(TODO|FIXME|lorem|T0D-|CR-C\d)/i);
    for (const g of screen.getAllByRole('group')) expect(norm(g.getAttribute('aria-label') ?? g.querySelector('legend')?.textContent ?? ''), 'no ALL CAPS group name').not.toMatch(/^[A-Z ]{4,}$/);
  });
  it('the credit party detail also has the tab (party_kind credit_party), through the same component', async () => {
    const user = userEvent.setup();
    API.setting = { ...SETTING_SAVED, party_kind: 'credit_party', party_id: ID(31) };
    await openPage('billing/credit-parties/[credit_party_id]', { perms: ['billing.credit_party.read', PERM.settingRead, PERM.settingManage], params: { credit_party_id: ID(31) } });
    await user.click(await screen.findByRole('tab', { name: /commercial settings/i }));
    await waitFor(() => expect(API.calls.some((c) => c.method === 'GET' && c.path === `/v1/partners/admin/party-settings/credit_party/${ID(31)}`)).toBe(true));
    expect(box(/^commission/i).value).toBe('12.50');
  });
});
