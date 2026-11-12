// @vitest-environment jsdom
// T-R2 — Staff web W9 Reminders (04-UI-UX §3 W9; ACs US-EN-23.1–23.4; 07-SECURITY REQ-SEC-007/-070 "no PHI in texts" => UI never shows/sends test names).
// done_when "04-UI-UX W9"; tests "component + axe". The R4 follow-up panel is NOT tested (T-P4 does not exist yet; US-EN-24.3 is outside this task's ACs).
// ASSUMED module/prop contract (spec fixes only the folder + kit components; dispute via writer if wrong). All files under apps/web/src/app/(staff)/engagement/reminders/:
//   RemindersView.tsx  export RemindersView({ reminders, permissions, reasons, searchPatients })
//       reminders: ReminderRow[] = Reminder (TRD §5 `Reminder`: id, patient_id, kind, reason_code?, source, due_at, status, sent_at?, failure_code?, version) + `patient_display: string`
//       permissions: readonly string[] ('engagement.reminder.read' | 'engagement.reminder.manage'); reasons: {code, display, isActive}[] (cs_reminder_reasons, fed to CodedSelect)
//       searchPatients(query, signal) => Promise<{id, display}[]>  (C4 lookup, feeds the patient Combobox)
//   page.tsx           default async server component ({ searchParams: Promise<Record<string,string>> }); lists via R1 GET /v1/engagement/reminders?due_from&due_to(&status&kind)
//   actions.ts         'use server' actions used by RemindersView; they call serverFetch -> MSW observes /v1/engagement/reminders (R2 create: Idempotency-Key; R3 cancel: If-Match "<version>").
//   Row action: a visible button named "Cancel reminder" inside the row (scheduled rows only). Filters: group "Due date range" (two textboxes DD/MM/YYYY), selects "Status" and "Kind"; changes go to router.replace(?due_from&due_to&status&kind).
//   Create dialog: button "New reminder" -> dialog titled "New reminder": Patient combobox, Reason select, Due date and time (DateTimePicker textbox 'DD/MM/YYYY hh:mm A', Asia/Kathmandu), submit button "Create reminder".
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh, back: vi.fn() }),
  usePathname: () => '/engagement/reminders',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw new Error('NEXT_NOT_FOUND'); },
}));
vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: ['engagement.reminder.read', 'engagement.reminder.manage'], displayName: 'Synthetic Front Desk', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/engagement/reminders',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const U = (n: number) => `01a1a98a-ac40-7000-8000-${String(n).padStart(12, '0')}`;
const PAT = U(1), R_SCHED = U(11), R_SENT = U(12), R_NOCONSENT = U(13), R_NOPHONE = U(14), R_SMSOFF = U(15), R_OPTOUT = U(16), R_CANCELLED = U(17);
const READ = ['engagement.reminder.read'];
const MANAGE = ['engagement.reminder.read', 'engagement.reminder.manage'];
const reasons = [
  { code: 'follow_up_test', display: 'Follow-up test', isActive: true },
  { code: 'collect_report', display: 'Collect report', isActive: true },
  { code: 'retired_reason', display: 'Retired reason', isActive: false },
];
const row = (id: string, o: Record<string, unknown> = {}) => ({
  id, patient_id: PAT, patient_display: 'Synthetic Patient One', kind: 'custom', reason_code: 'follow_up_test', source: 'staff',
  due_at: '2026-11-20T04:00:00.000Z', status: 'scheduled', version: 3, ...o,
});
const rows = [
  row(R_SCHED),
  row(R_SENT, { status: 'sent', sent_at: '2026-11-19T04:01:00.000Z', patient_display: 'Synthetic Patient Sent' }),
  row(R_NOCONSENT, { status: 'suppressed', failure_code: 'suppressed_no_consent', patient_display: 'Synthetic Patient Consent' }),
  row(R_NOPHONE, { status: 'suppressed', failure_code: 'suppressed_no_contact', patient_display: 'Synthetic Patient Phone' }),
  row(R_SMSOFF, { status: 'suppressed', failure_code: 'suppressed_channel_disabled', patient_display: 'Synthetic Patient Off' }),
  row(R_OPTOUT, { status: 'suppressed', failure_code: 'opted_out', patient_display: 'Synthetic Patient Optout' }),
  row(R_CANCELLED, { status: 'cancelled', patient_display: 'Synthetic Patient Cancelled' }),
];

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
let cancelStatus = 200;
const api = setupServer(
  http.get(`${ORIGIN}/v1/engagement/reminders`, async ({ request }) => { await rec(request); return HttpResponse.json({ data: rows, page: { limit: 50 } }); }),
  http.get(`${ORIGIN}/v1/engagement/coded-sets/reminder_reasons`, async ({ request }) => {
    await rec(request); // T3a listEngagementCodedSet; tenant override of the display text
    return HttpResponse.json({ data: [{ code: 'follow_up_test', display: 'Tenant follow-up label', sort_order: 1 }, { code: 'collect_report', display: 'Collect report', sort_order: 2 }] });
  }),
  http.post(`${ORIGIN}/v1/engagement/reminders`, async ({ request }) => { await rec(request); return HttpResponse.json(row(U(20), { patient_display: undefined }), { status: 201 }); }),
  http.post(`${ORIGIN}/v1/engagement/reminders/:id/cancel`, async ({ request }) => {
    await rec(request);
    if (cancelStatus === 412) return HttpResponse.json({ type: 'urn:lims:error:common.version_conflict', title: 'Version conflict', status: 409, code: 'common.version_conflict' }, { status: 409 });
    return cancelStatus === 200
      ? HttpResponse.json(row(R_SCHED, { status: 'cancelled', version: 4 }))
      : HttpResponse.json({ type: 'urn:lims:error:engagement.reminder_invalid_transition', title: 'Reminder cannot change', status: 409, code: 'engagement.reminder_invalid_transition' }, { status: 409 });
  }),
);
const setItem = vi.spyOn(Storage.prototype, 'setItem');
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  expect(setItem).not.toHaveBeenCalled(); // 04-UI-UX §1: nothing about reminders/patients in browser storage
  cleanup(); api.resetHandlers(); calls.length = 0; replace.mockReset(); refresh.mockReset(); setItem.mockClear(); cancelStatus = 200; localStorage.clear(); sessionStorage.clear();
});
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const searchPatients = vi.fn(async () => [{ id: PAT, display: 'Synthetic Patient One (P-0001)' }]);
const load = async () => ((await import(/* @vite-ignore */ `../${'RemindersView'}`)) as { RemindersView: any }).RemindersView;
const view = async (p: { reminders?: unknown[]; permissions?: readonly string[] } = {}) => {
  const RemindersView = await load();
  return wrap(<RemindersView reminders={p.reminders ?? rows} permissions={p.permissions ?? MANAGE} reasons={reasons} searchPatients={searchPatients} />);
};
const rowOf = (name: RegExp) => screen.getByRole('row', { name });
const kathmandu = (d: Date) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kathmandu', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute} ${String(p.dayPeriod).toUpperCase()}`;
};
const hours = (h: number) => new Date(Date.now() + h * 3_600_000);

describe('W9 list (US-EN-23)', () => {
  it('columns Due · Patient · Kind · Reason · Status · Sent at · Result; reason shows the coded display name, not the code', async () => {
    await view();
    for (const h of ['Due', 'Patient', 'Kind', 'Reason', 'Status', 'Sent at', 'Result']) expect(screen.getByRole('columnheader', { name: new RegExp(`^${h}`) })).toBeTruthy();
    const r = rowOf(/Synthetic Patient One/);
    expect(within(r).getByText('Follow-up test')).toBeTruthy();
    expect(r.textContent).not.toMatch(/follow_up_test/);
    expect(within(r).getByText(/custom|manual/i)).toBeTruthy();
  });

  it('AC-23.1 status is text for every state (not colour only): Scheduled / Sent / Suppressed / Cancelled; sent row shows a Sent-at time, scheduled row none', async () => {
    await view();
    expect(within(rowOf(/Synthetic Patient One/)).getByText(/^scheduled$/i)).toBeTruthy();
    const sent = rowOf(/Synthetic Patient Sent/);
    expect(within(sent).getByText(/^sent$/i)).toBeTruthy();
    expect(sent.textContent).toMatch(/2026|19\/11|Nov/); // sent_at rendered
    expect(within(rowOf(/Synthetic Patient Consent/)).getByText(/^suppressed$/i)).toBeTruthy();
    expect(within(rowOf(/Synthetic Patient Cancelled/)).getByText(/^cancelled$/i)).toBeTruthy();
  });

  it('AC-23.1/23.3 Result column maps suppression codes to plain text and never shows the raw code', async () => {
    await view();
    expect(within(rowOf(/Synthetic Patient Consent/)).getByText('No SMS consent')).toBeTruthy();
    expect(within(rowOf(/Synthetic Patient Phone/)).getByText('No phone number')).toBeTruthy();
    expect(within(rowOf(/Synthetic Patient Off/)).getByText('SMS turned off')).toBeTruthy();
    expect(within(rowOf(/Synthetic Patient Optout/)).getByText('Patient opted out')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/suppressed_|opted_out/);
  });

  it('AC-23.4 only a scheduled reminder can be cancelled: sent, suppressed and cancelled rows have no Cancel action', async () => {
    await view();
    expect(within(rowOf(/Synthetic Patient One/)).getByRole('button', { name: /^cancel reminder/i })).toBeTruthy();
    for (const n of [/Synthetic Patient Sent/, /Synthetic Patient Consent/, /Synthetic Patient Optout/, /Synthetic Patient Cancelled/]) expect(within(rowOf(n)).queryByRole('button', { name: /cancel reminder/i })).toBeNull();
  });

  it('read-only users (no engagement.reminder.manage) get the list but no [New reminder] and no Cancel', async () => {
    await view({ permissions: READ });
    expect(screen.queryByRole('button', { name: /new reminder/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /cancel reminder/i })).toBeNull();
    expect(screen.getAllByRole('row').length).toBeGreaterThan(rows.length);
  });

  it('empty list shows an empty state, not a blank table', async () => {
    await view({ reminders: [] });
    expect(screen.getByText(/no reminders/i)).toBeTruthy();
  });

  it('the message content is not editable and no test name/result is requested: create form has patient, reason, due only', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /new reminder/i }));
    const dlg = await screen.findByRole('dialog', { name: /new reminder/i });
    expect(within(dlg).queryByRole('textbox', { name: /message|text|test|note/i })).toBeNull();
    expect(within(dlg).getByRole('combobox', { name: /patient/i })).toBeTruthy();
    expect(within(dlg).getByRole('textbox', { name: /due/i })).toBeTruthy();
  });
});

describe('Cancel (R3, AC-23.4)', () => {
  it('ConfirmDialog -> POST /reminders/:id/cancel with If-Match = version, then refreshes the list', async () => {
    await view();
    await userEvent.click(within(rowOf(/Synthetic Patient One/)).getByRole('button', { name: /^cancel reminder/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    expect(calls.length).toBe(0); // nothing sent before confirming
    await userEvent.click(within(dlg).getByRole('button', { name: /cancel reminder|confirm|yes/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url.pathname).toBe(`/v1/engagement/reminders/${R_SCHED}/cancel`);
    expect(calls[0]!.headers.get('if-match')).toBe('"3"');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('dismissing the dialog sends nothing', async () => {
    await view();
    await userEvent.click(within(rowOf(/Synthetic Patient One/)).getByRole('button', { name: /^cancel reminder/i }));
    const dlg = await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await userEvent.click(within(dlg).getByRole('button', { name: /^(keep|back|close|no|dismiss|cancel)$/i }));
    expect(calls.length).toBe(0);
  });

  it('409 engagement.reminder_invalid_transition (already sent/cancelled) is shown as a message with the coded title, no crash, list refreshed', async () => {
    cancelStatus = 409;
    await view();
    await userEvent.click(within(rowOf(/Synthetic Patient One/)).getByRole('button', { name: /^cancel reminder/i }));
    await userEvent.click(within(await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))).getByRole('button', { name: /cancel reminder|confirm|yes/i }));
    expect(await screen.findByText(/reminder cannot change|already (sent|cancelled)/i)).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('409 common.version_conflict shows the spec Banner "Someone else changed this. Reload to see the latest." with a [Reload] button (04-UI-UX §1)', async () => {
    cancelStatus = 412; // sentinel: handler answers 409 common.version_conflict
    await view();
    await userEvent.click(within(rowOf(/Synthetic Patient One/)).getByRole('button', { name: /^cancel reminder/i }));
    await userEvent.click(within(await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'))).getByRole('button', { name: /cancel reminder|confirm|yes/i }));
    expect(await screen.findByText('Someone else changed this. Reload to see the latest.')).toBeTruthy();
    refresh.mockClear();
    await userEvent.click(screen.getByRole('button', { name: /^reload$/i }));
    expect(refresh).toHaveBeenCalled();
  });
});

describe('New reminder (R2, AC-23.1)', () => {
  const fill = async (due: Date, patient = true) => {
    await userEvent.click(screen.getByRole('button', { name: /new reminder/i }));
    const dlg = await screen.findByRole('dialog', { name: /new reminder/i });
    if (patient) {
      await userEvent.type(within(dlg).getByRole('combobox', { name: /patient/i }), 'syn');
      await userEvent.click(await screen.findByRole('option', { name: /Synthetic Patient One/ }));
    }
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    await userEvent.click(await screen.findByRole('option', { name: 'Follow-up test' }));
    const dt = within(dlg).getByRole('textbox', { name: /due/i });
    await userEvent.clear(dt);
    await userEvent.type(dt, kathmandu(due));
    return dlg;
  };

  it('valid input -> POST /reminders {patient_id, reason_code, due_at ISO UTC} with Idempotency-Key, only those fields', async () => {
    await view();
    const due = hours(48);
    const dlg = await fill(due);
    await userEvent.click(within(dlg).getByRole('button', { name: /^create reminder$/i }));
    await waitFor(() => expect(calls.length).toBe(1));
    const c = calls[0]!;
    expect(c.method).toBe('POST');
    expect(c.url.pathname).toBe('/v1/engagement/reminders');
    expect(c.headers.get('idempotency-key')).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(Object.keys(c.body).sort()).toEqual(['due_at', 'patient_id', 'reason_code']);
    expect(c.body.patient_id).toBe(PAT);
    expect(c.body.reason_code).toBe('follow_up_test');
    expect(Math.abs(Date.parse(c.body.due_at) - due.getTime())).toBeLessThan(120_000); // typed to the minute
    expect(c.body.due_at).toMatch(/Z$/);
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('due earlier than now + 1 h is rejected in the form (no request); ≥ 1 h is accepted', async () => {
    await view();
    const dlg = await fill(hours(0.5));
    await userEvent.click(within(dlg).getByRole('button', { name: /^create reminder$/i }));
    expect(await within(dlg).findByText(/at least 1 hour|1 h|one hour/i)).toBeTruthy();
    expect(calls.length).toBe(0);
  });

  it('missing patient is rejected in the form (no request)', async () => {
    await view();
    const dlg = await fill(hours(48), false);
    await userEvent.click(within(dlg).getByRole('button', { name: /^create reminder$/i }));
    expect(await within(dlg).findByText(/patient.*required|required.*patient|select a patient/i)).toBeTruthy();
    expect(calls.length).toBe(0);
  });

  it('inactive reasons are not offered', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /new reminder/i }));
    const dlg = await screen.findByRole('dialog', { name: /new reminder/i });
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    expect(await screen.findByRole('option', { name: 'Collect report' })).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'Retired reason' })).toBeNull();
  });

  it('double-click on Create sends exactly one request (one Idempotency-Key)', async () => {
    await view();
    const dlg = await fill(hours(48));
    const b = within(dlg).getByRole('button', { name: /^create reminder$/i });
    await userEvent.dblClick(b);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(calls.length).toBe(1);
  });
});

describe('Filters (R1: due range ≤ 92 days)', () => {
  const range = async (from: Date, to: Date) => {
    const g = screen.getByRole('group', { name: /due date range/i });
    const [a, b] = within(g).getAllByRole('textbox');
    const d = (x: Date) => kathmandu(x).slice(0, 10);
    await userEvent.clear(a!); await userEvent.type(a!, d(from));
    await userEvent.clear(b!); await userEvent.type(b!, d(to));
  };

  it('a range of 93+ days shows an error and does not change the URL', async () => {
    await view();
    await range(hours(0), hours(24 * 100));
    expect(await screen.findByText(/92 days/i)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });

  it('a valid range, status and kind go to the URL as due_from/due_to/status/kind', async () => {
    await view();
    await range(hours(0), hours(24 * 30));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    const url = new URL(String(replace.mock.calls.at(-1)![0]), 'http://x');
    expect(url.searchParams.get('due_from')).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect(url.searchParams.get('due_to')).toMatch(/^\d{4}-\d{2}-\d{2}/);
    expect((Date.parse(url.searchParams.get('due_to')!) - Date.parse(url.searchParams.get('due_from')!)) / 86_400_000).toBeLessThanOrEqual(91); // inclusive calendar days: 92 days = 91-day difference
  });

  it('92 calendar days inclusive is accepted; 93 is rejected', async () => {
    await view();
    await range(hours(0), hours(24 * 91));
    await waitFor(() => expect(replace).toHaveBeenCalled());
    expect(screen.queryByText(/92 days/i)).toBeNull();
    replace.mockReset();
    await range(hours(0), hours(24 * 92));
    expect(await screen.findByText(/92 days/i)).toBeTruthy();
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('Server page (R1 wiring)', () => {
  const page = async (sp: Record<string, string> = {}) => {
    const Page = ((await import(/* @vite-ignore */ `../${'page'}`)) as { default: (p: { searchParams: Promise<Record<string, string>> }) => Promise<ReactNode> }).default;
    return Page({ searchParams: Promise.resolve(sp) });
  };

  it('always sends due_from and due_to to R1, default span ≤ 92 days, and renders the rows', async () => {
    wrap(await page());
    const get = calls.find((c) => c.method === 'GET')!;
    expect(get.url.pathname).toBe('/v1/engagement/reminders');
    const [f, t] = [get.url.searchParams.get('due_from'), get.url.searchParams.get('due_to')];
    const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; // R1 accepts only instants, never date-only (else 400 common.validation_failed)
    expect(f).toMatch(ISO); expect(t).toMatch(ISO);
    expect((Date.parse(t!) - Date.parse(f!)) / 86_400_000).toBeLessThanOrEqual(92);
    expect(await screen.findByText('Synthetic Patient One')).toBeTruthy();
  });

  it('URL dates become Asia/Kathmandu day bounds as instants; 92 calendar days inclusive stays ≤ 92 d for the API', async () => {
    wrap(await page({ due_from: '2026-11-01', due_to: '2026-11-30' }));
    const get = calls.find((c) => c.method === 'GET' && c.url.pathname === '/v1/engagement/reminders')!;
    expect(get.url.searchParams.get('due_from')).toBe('2026-10-31T18:15:00.000Z'); // 2026-11-01 00:00 +05:45
    expect(get.url.searchParams.get('due_to')).toBe('2026-11-30T18:14:59.999Z'); // 2026-11-30 23:59:59.999 +05:45
    cleanup(); calls.length = 0;
    wrap(await page({ due_from: '2026-11-01', due_to: '2027-01-31' })); // 92 calendar days inclusive
    const g2 = calls.find((c) => c.method === 'GET' && c.url.pathname === '/v1/engagement/reminders')!;
    expect((Date.parse(g2.url.searchParams.get('due_to')!) - Date.parse(g2.url.searchParams.get('due_from')!)) / 86_400_000).toBeLessThanOrEqual(92);
  });

  it('forwards status; a range > 92 days or a malformed value never reaches the API', async () => {
    wrap(await page({ due_from: '2026-11-01', due_to: '2026-12-01', status: 'sent' }));
    const get = calls.find((c) => c.method === 'GET' && c.url.pathname === '/v1/engagement/reminders')!;
    expect(get.url.searchParams.get('status')).toBe('sent');
    calls.length = 0;
    for (const sp of [{ due_from: '2026-01-01', due_to: '2026-12-31' }, { due_from: "2026-11-01'; DROP", due_to: '2026-11-02' }, { status: 'sent&limit=9999' }]) {
      await page(sp).then((el) => wrap(el)).catch(() => undefined);
      cleanup();
    }
    expect(calls.filter((c) => c.method === 'GET').every((c) => !/DROP|9999/.test(c.url.search))).toBe(true);
    expect(calls.filter((c) => c.url.searchParams.get('due_from')?.startsWith('2026-01-01') || c.url.searchParams.get('due_from')?.startsWith('2025-12-31')).length).toBe(0);
  });

  it('Kind filter has an effect although R1 has no `kind` param: not sent to R1, rows filtered by kind', async () => {
    api.use(http.get(`${ORIGIN}/v1/engagement/reminders`, async ({ request }) => {
      await rec(request);
      return HttpResponse.json({ data: [row(U(31), { kind: 'custom', patient_display: 'Synthetic Patient Custom' }), row(U(32), { kind: 'follow_up', patient_display: 'Synthetic Patient Followup' })], page: { limit: 50 } });
    }));
    wrap(await page({ due_from: '2026-11-01', due_to: '2026-12-01', kind: 'follow_up' }));
    const get = calls.find((c) => c.method === 'GET' && c.url.pathname === '/v1/engagement/reminders')!;
    expect(get.url.searchParams.has('kind')).toBe(false);
    expect(await screen.findByText('Synthetic Patient Followup')).toBeTruthy();
    expect(screen.queryByText('Synthetic Patient Custom')).toBeNull();
  });

  it('reason options come from T3a GET /v1/engagement/coded-sets/reminder_reasons (tenant display), not a hard-coded list', async () => {
    wrap(await page());
    expect(calls.some((c) => c.method === 'GET' && c.url.pathname === '/v1/engagement/coded-sets/reminder_reasons')).toBe(true);
    await userEvent.click(await screen.findByRole('button', { name: /new reminder/i }));
    const dlg = await screen.findByRole('dialog', { name: /new reminder/i });
    await userEvent.click(within(dlg).getByRole('button', { name: /reason/i }));
    expect(await screen.findByRole('option', { name: 'Tenant follow-up label' })).toBeTruthy();
  });
});

describe('Accessibility (axe)', () => {
  it('list view has no axe violations', async () => {
    await view();
    await noAxeViolations();
  });
  it('New reminder dialog has no axe violations', async () => {
    await view();
    await userEvent.click(screen.getByRole('button', { name: /new reminder/i }));
    await screen.findByRole('dialog', { name: /new reminder/i });
    await noAxeViolations();
  });
  it('cancel ConfirmDialog has no axe violations', async () => {
    await view();
    await userEvent.click(within(rowOf(/Synthetic Patient One/)).getByRole('button', { name: /^cancel reminder/i }));
    await screen.findByRole('alertdialog').catch(() => screen.findByRole('dialog'));
    await noAxeViolations();
  });
  it('empty state has no axe violations', async () => {
    await view({ reminders: [] });
    await noAxeViolations();
  });
});
