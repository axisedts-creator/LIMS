// @vitest-environment jsdom
// WEB-T06 — SCR-11 Settings `/instruments/settings` (04-UI-UX §3 SCR-11, 02-TRD §7.4 InstrumentSettings, E40/E41).
// ACs: AC-15.5 (window part: E41 carries update_window_from/_to; "Saved. Agents pick up the new update window within a minute."),
//      done_when: "If-Match conflict banner; no retention field" (raw-archive retention is C2's retention.rawInstrumentYears, 08 A13 D-42).
// Component tests + MSW (server actions run for real against MSW) + axe. Synthetic data only.
// ASSUMED module/prop contract (spec fixes folders + copy only; dispute to rename):
//   components/InstrumentSettingsForm.tsx   export InstrumentSettingsForm({settings, permissions})   (SCR-11; success → router.refresh())
//   app/(staff)/instruments/settings/page.tsx   default async Page() → element with props {settings, permissions}; E40 failure propagates (error.tsx)
//   server fns + action: see web-t06.server.test.ts header. permissions: readonly string[]; manage = instruments.instrument.manage.
//   Field labels = 04-UI-UX SCR-11 verbatim: "Default backlog threshold", "Backlog oldest pending seconds", "Clock warning seconds",
//   "Agent local retention hours", "Update window from", "Update window to"; save button name "Save".
// NOT tested (spec silent): the toast text for a save that does not change the window; a Reload button on the banner.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { ReactNode } from 'react';
import { ToastProvider } from '@lims/ui/components/Toast';

const push = vi.fn();
const replace = vi.fn();
const refresh = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push, replace, refresh, back: vi.fn() }),
  usePathname: () => '/instruments/settings',
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error('NEXT_NOT_FOUND'), { digest: 'NEXT_HTTP_ERROR_FALLBACK;404' }); },
}));
vi.mock('server-only', () => ({}));
const session = vi.hoisted(() => ({ permissions: [] as string[] }));
vi.mock('@/core/session/server', () => ({
  getAccessToken: async () => 'jwt-synthetic',
  getShellSession: async () => ({ actor: { permissions: session.permissions, displayName: 'Synthetic Manager', tenantCode: 'syn', roles: [] } }),
  getRequestPathname: async () => '/instruments/settings',
}));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const SETTINGS_URL = `${ORIGIN}/v1/instruments/settings`;
const READ = ['instruments.instrument.read'];
const MANAGE = ['instruments.instrument.read', 'instruments.instrument.manage'];
session.permissions = MANAGE;

const settings = (o: Record<string, unknown> = {}) => ({ default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 120, agent_uploaded_retention_hours: 24, update_window_from: '01:00', update_window_to: '04:00', version: 1, ...o });
const NO_WINDOW = (() => { const { update_window_from: _f, update_window_to: _t, ...r } = settings(); return r; })();

const calls: { method: string; url: URL; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { calls.push({ method: r.method, url: new URL(r.url), headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string, extra: Record<string, unknown> = {}) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code, ...extra }, { status });
const puts = () => calls.filter((c) => c.method === 'PUT');
const api = setupServer(
  http.get(SETTINGS_URL, async ({ request }) => { await rec(request); return HttpResponse.json(settings()); }),
  http.put(SETTINGS_URL, async ({ request }) => { await rec(request); const b = await request.clone().json(); return HttpResponse.json({ ...b, version: 2 }); }),
);
beforeAll(() => api.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { cleanup(); api.resetHandlers(); calls.length = 0; push.mockReset(); replace.mockReset(); refresh.mockReset(); localStorage.clear(); sessionStorage.clear(); session.permissions = MANAGE; });
afterAll(() => api.close());

const wrap = (ui: ReactNode) => render(<ToastProvider>{ui}</ToastProvider>);
const noAxeViolations = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};
const bodyHas = (s: string | RegExp) => (typeof s === 'string' ? document.body.textContent!.includes(s) : s.test(document.body.textContent!));
const CONFLICT = 'Someone else changed these settings. Reload to see them.';
const WINDOW_TOAST = 'Saved. Agents pick up the new update window within a minute.';
const HELP = "Raw analyser messages are kept for the period set in the lab's retention settings (Administration), at least one year. Legal retention is not yet confirmed.";

const L = {
  backlog: /default backlog threshold/i,
  oldest: /backlog oldest pending seconds/i,
  clock: /clock warning seconds/i,
  local: /agent local retention hours/i,
  from: /update window from/i,
  to: /update window to/i,
};
const field = (re: RegExp) => screen.getByLabelText(re) as HTMLInputElement;
const setField = async (re: RegExp, v: string) => { const el = field(re); await userEvent.clear(el); if (v) await userEvent.type(el, v); };
const save = () => userEvent.click(screen.getByRole('button', { name: /^save$/i }));
const show = async (props: Record<string, unknown> = {}) => {
  const { InstrumentSettingsForm } = await import('../components/InstrumentSettingsForm');
  return wrap(<InstrumentSettingsForm settings={settings() as never} permissions={MANAGE} {...(props as object)} />);
};

describe('SCR-11 InstrumentSettingsForm — fields and help text', () => {
  it('renders the 04-UI-UX fields prefilled from E40, including the optional update window', async () => {
    await show();
    expect(field(L.backlog).value).toBe('500');
    expect(field(L.oldest).value).toBe('900');
    expect(field(L.clock).value).toBe('120');
    expect(field(L.local).value).toBe('24');
    expect(field(L.from).value).toBe('01:00');
    expect(field(L.to).value).toBe('04:00');
  });

  it('numeric fields advertise the TRD ranges (spinbutton min/max)', async () => {
    await show();
    const r = (re: RegExp) => [field(re).getAttribute('aria-valuemin'), field(re).getAttribute('aria-valuemax')];
    expect(r(L.backlog)).toEqual(['10', '100000']);
    expect(r(L.oldest)).toEqual(['60', '86400']);
    expect(r(L.clock)).toEqual(['30', '3600']);
    expect(r(L.local)).toEqual(['1', '72']);
  });

  it('settings without a window render empty window fields', async () => {
    await show({ settings: NO_WINDOW });
    expect(field(L.from).value).toBe('');
    expect(field(L.to).value).toBe('');
  });

  it('NO retention field: only "Agent local retention hours" mentions retention; no raw-archive / years control', async () => {
    await show();
    const controls = [...document.querySelectorAll('input, select, textarea, [role="spinbutton"], [role="combobox"], [role="textbox"]')];
    const labelled = controls.map((c) => (c.getAttribute('aria-label') ?? (c.id ? document.querySelector(`label[for="${c.id}"]`)?.textContent : '') ?? ''));
    expect(controls.length).toBeGreaterThanOrEqual(6);
    for (const t of labelled.filter((l) => /retention/i.test(l ?? ''))) expect(t).toMatch(/agent local retention hours/i);
    expect(screen.queryByLabelText(/raw|archive|years|message retention/i)).toBeNull();
    expect(controls.filter((c) => /retention/i.test(`${c.getAttribute('name') ?? ''}${c.id}`) && !/uploaded|local/i.test(`${c.getAttribute('name') ?? ''}${c.id}`))).toHaveLength(0);
  });

  it('shows the verbatim help text pointing to the lab retention settings (text, not a field)', async () => {
    await show();
    expect(bodyHas(HELP)).toBe(true);
  });
});

describe('SCR-11 permissions', () => {
  it('without instruments.instrument.manage the form is read-only: fields locked, no Save button', async () => {
    await show({ permissions: READ });
    for (const re of Object.values(L)) {
      const el = field(re);
      expect(el.disabled || el.readOnly || el.getAttribute('aria-readonly') === 'true' || el.getAttribute('aria-disabled') === 'true', String(re)).toBe(true);
    }
    expect(screen.queryByRole('button', { name: /^save$/i })).toBeNull();
    expect(bodyHas(HELP)).toBe(true); // still visible
  });

  it('read-only: Enter in a field cannot submit', async () => {
    await show({ permissions: READ });
    await userEvent.type(field(L.backlog), '{Enter}');
    expect(calls).toHaveLength(0);
  });

  it('with manage the Save button is present and nothing is sent until it is pressed', async () => {
    await show();
    expect(screen.getByRole('button', { name: /^save$/i })).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
});

describe('SCR-11 save → E41 with If-Match (AC-15.5)', () => {
  it('ONE PUT /v1/instruments/settings with If-Match "<version>" and exactly the mutable fields as integers', async () => {
    await show({ settings: settings({ version: 7 }) });
    await setField(L.backlog, '600');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    const c = puts()[0]!;
    expect(c.url.pathname).toBe('/v1/instruments/settings');
    expect(c.headers.get('if-match')).toBe('"7"');
    expect(c.body).toEqual({ default_backlog_threshold: 600, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 120, agent_uploaded_retention_hours: 24, update_window_from: '01:00', update_window_to: '04:00' });
    expect(Object.keys(c.body).some((k) => /raw|years/i.test(k))).toBe(false);
    expect(Object.keys(c.body)).not.toContain('version');
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('the browser talks to the BFF only: no direct fetch to the API origin from the component', async () => {
    const seenUrls: string[] = [];
    const orig = globalThis.fetch;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((...a) => { seenUrls.push(String(a[0] instanceof Request ? a[0].url : a[0])); return orig(...a); });
    await show();
    await setField(L.backlog, '700');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(seenUrls.filter((u) => u.startsWith(ORIGIN) && !u.startsWith(`${ORIGIN}/v1/instruments/settings`))).toEqual([]);
    spy.mockRestore();
  });

  it('a second save uses the version returned by the first (no self-inflicted 409)', async () => {
    await show();
    await setField(L.backlog, '600');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.headers.get('if-match')).toBe('"1"');
    await setField(L.backlog, '650');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.headers.get('if-match')).toBe('"2"');
  });

  it('double-click on Save sends ONE PUT while in flight', async () => {
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); await delay(150); return HttpResponse.json({ ...(await request.clone().json()), version: 2 }); }));
    await show();
    await setField(L.backlog, '600');
    const btn = screen.getByRole('button', { name: /^save$/i });
    await userEvent.dblClick(btn);
    await new Promise((r) => setTimeout(r, 400));
    expect(puts()).toHaveLength(1);
  });

  it('changing the update window → toast "Saved. Agents pick up the new update window within a minute."', async () => {
    await show();
    await setField(L.to, '05:00');
    await save();
    await waitFor(() => expect(bodyHas(WINDOW_TOAST)).toBe(true));
    expect(puts()[0]!.body).toMatchObject({ update_window_from: '01:00', update_window_to: '05:00' });
  });

  it('clearing both window fields sends no window keys (neither) and counts as a window change → toast', async () => {
    await show();
    await setField(L.from, '');
    await setField(L.to, '');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).not.toHaveProperty('update_window_from');
    expect(puts()[0]!.body).not.toHaveProperty('update_window_to');
    await waitFor(() => expect(bodyHas(WINDOW_TOAST)).toBe(true));
  });

  it('adding a window to settings that had none → toast', async () => {
    await show({ settings: NO_WINDOW });
    await setField(L.from, '22:30');
    await setField(L.to, '23:59');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toMatchObject({ update_window_from: '22:30', update_window_to: '23:59' });
    await waitFor(() => expect(bodyHas(WINDOW_TOAST)).toBe(true));
  });

  it('saving with the window unchanged does NOT show the update-window toast', async () => {
    await show();
    await setField(L.local, '48');
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(bodyHas(WINDOW_TOAST)).toBe(false);
  });
});

describe('SCR-11 client validation — nothing is sent on invalid input', () => {
  const lo = [[L.backlog, '9'], [L.oldest, '59'], [L.clock, '29'], [L.local, '0']] as const;
  const hi = [[L.backlog, '100001'], [L.oldest, '86401'], [L.clock, '3601'], [L.local, '73']] as const;

  it.each([...lo, ...hi])('out-of-range value %s=%s → no PUT, field flagged invalid', async (re, v) => {
    await show();
    await setField(re, v);
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(puts()).toHaveLength(0);
    expect(field(re).getAttribute('aria-invalid')).toBe('true');
  });

  it('emptied required field → no PUT', async () => {
    await show();
    await setField(L.clock, '');
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(puts()).toHaveLength(0);
    expect(field(L.clock).getAttribute('aria-invalid')).toBe('true');
  });

  it('boundary values are accepted: 10 / 60 / 30 / 1 and 100000 / 86400 / 3600 / 72', async () => {
    await show();
    for (const [re, v] of [[L.backlog, '10'], [L.oldest, '60'], [L.clock, '30'], [L.local, '1']] as const) await setField(re, v);
    await save();
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(puts()[0]!.body).toMatchObject({ default_backlog_threshold: 10, backlog_max_oldest_pending_seconds: 60, clock_offset_warn_seconds: 30, agent_uploaded_retention_hours: 1 });
    for (const [re, v] of [[L.backlog, '100000'], [L.oldest, '86400'], [L.clock, '3600'], [L.local, '72']] as const) await setField(re, v);
    await save();
    await waitFor(() => expect(puts()).toHaveLength(2));
    expect(puts()[1]!.body).toMatchObject({ default_backlog_threshold: 100000, backlog_max_oldest_pending_seconds: 86400, clock_offset_warn_seconds: 3600, agent_uploaded_retention_hours: 72 });
  });

  it('non-numeric typing never reaches the value ("12abc", "1.5", "-5")', async () => {
    await show();
    await setField(L.backlog, '12abc');
    expect(field(L.backlog).value).toBe('12');
    await setField(L.backlog, '1.5');
    expect(field(L.backlog).value).toBe('15');
    await setField(L.backlog, '-5');
    expect(field(L.backlog).value).toBe('5');
  });

  it.each([['24:00'], ['1:00'], ['12:60'], ['0100'], ['ab:cd']])('bad HH:MM %j in "from" → no PUT, field flagged invalid', async (v) => {
    await show();
    await setField(L.from, v);
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(puts()).toHaveLength(0);
    expect(field(L.from).getAttribute('aria-invalid')).toBe('true');
  });

  it('only "from" filled (to emptied) → no PUT (both or neither), the empty "to" flagged', async () => {
    await show();
    await setField(L.to, '');
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(puts()).toHaveLength(0);
    expect(field(L.to).getAttribute('aria-invalid')).toBe('true');
  });

  it('only "to" filled (from emptied) → no PUT, the empty "from" flagged', async () => {
    await show();
    await setField(L.from, '');
    await save();
    await new Promise((r) => setTimeout(r, 100));
    expect(puts()).toHaveLength(0);
    expect(field(L.from).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('SCR-11 server errors', () => {
  it('409 common.version_conflict → banner "Someone else changed these settings. Reload to see them."; entries kept; no toast; no auto-retry', async () => {
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    await show();
    await setField(L.backlog, '777');
    await save();
    await waitFor(() => expect(bodyHas(CONFLICT)).toBe(true));
    expect(field(L.backlog).value).toBe('777'); // the user's edit is not thrown away
    expect(bodyHas(WINDOW_TOAST)).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(puts()).toHaveLength(1);
  });

  it('after a conflict Save can be pressed again (not stuck in-flight) and it re-sends', async () => {
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    await show();
    await setField(L.backlog, '777');
    await save();
    await waitFor(() => expect(bodyHas(CONFLICT)).toBe(true));
    await save();
    await waitFor(() => expect(puts()).toHaveLength(2));
  });

  it('the banner is announced (alert/status region) and is not shown before any conflict', async () => {
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    await show();
    expect(bodyHas(CONFLICT)).toBe(false);
    await setField(L.backlog, '777');
    await save();
    await waitFor(() => expect(bodyHas(CONFLICT)).toBe(true));
    const hit = [...document.querySelectorAll('[role="alert"], [role="status"], [aria-live]')].some((e) => e.textContent?.includes(CONFLICT));
    expect(hit).toBe(true);
  });

  it('400 common.validation_failed with errors[] JSON-Pointer paths → message on the matching field, no conflict banner', async () => {
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); return problem(400, 'common.validation_failed', { errors: [{ path: '/clock_offset_warn_seconds', code: 'range', message: 'Clock warning seconds must be between 30 and 3600.' }] }); }));
    await show();
    await setField(L.local, '12');
    await save();
    await waitFor(() => expect(field(L.clock).getAttribute('aria-invalid')).toBe('true'));
    expect(bodyHas(CONFLICT)).toBe(false);
  });

  it.each([[403, 'auth.forbidden'], [500, 'common.internal'], [428, 'common.precondition_required']])('%s %s → visible error naming the code; no conflict banner; no success toast', async (status, code) => {
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); return problem(status, code); }));
    await show();
    await setField(L.backlog, '600');
    await save();
    await waitFor(() => expect(bodyHas(code)).toBe(true));
    expect(bodyHas(CONFLICT)).toBe(false);
    expect(bodyHas(WINDOW_TOAST)).toBe(false);
  });

  it('SECURITY: a hostile problem title/detail is rendered as text, never HTML', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); return HttpResponse.json({ type: 'urn:lims:error:common.internal', title: evil, detail: evil, status: 500, code: 'common.internal' }, { status: 500 }); }));
    await show();
    await setField(L.backlog, '600');
    await save();
    await waitFor(() => expect(bodyHas('common.internal')).toBe(true));
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('SCR-11 axe', () => {
  it('populated (manage), read-only, and with the conflict banner', async () => {
    const a = await show();
    await noAxeViolations();
    a.unmount();
    const b = await show({ permissions: READ });
    await noAxeViolations();
    b.unmount();
    api.use(http.put(SETTINGS_URL, async ({ request }) => { await rec(request); return problem(409, 'common.version_conflict'); }));
    await show();
    await setField(L.backlog, '777');
    await save();
    await waitFor(() => expect(bodyHas(CONFLICT)).toBe(true));
    await noAxeViolations();
  });

  it('invalid field state is exposed to assistive tech (aria-invalid + described error), axe-clean', async () => {
    await show();
    await setField(L.backlog, '9');
    await save();
    await waitFor(() => expect(field(L.backlog).getAttribute('aria-invalid')).toBe('true'));
    await noAxeViolations();
  });
});

describe('page → BFF (E40)', () => {
  const page = async () => {
    const mod = await import('../../../app/(staff)/instruments/settings/page');
    return (await mod.default()) as { props: Record<string, any> };
  };

  it('settings page: GET E40 once; passes settings (with version) and the session permissions to the form', async () => {
    const el = await page();
    expect(calls.filter((c) => c.method === 'GET' && c.url.pathname === '/v1/instruments/settings')).toHaveLength(1);
    expect(el.props.settings).toMatchObject({ default_backlog_threshold: 500, version: 1 });
    expect(el.props.permissions).toEqual(MANAGE);
  });

  it('settings page: a read-only user gets read-only permissions (no manage leaked)', async () => {
    session.permissions = READ;
    const el = await page();
    expect(el.props.permissions).toEqual(READ);
    expect(el.props.permissions).not.toContain('instruments.instrument.manage');
  });

  it('settings page: API 403 / 500 are NOT turned into a rendered form or not-found (error.tsx handles them)', async () => {
    api.use(http.get(SETTINGS_URL, () => problem(403, 'auth.forbidden')));
    await expect(page()).rejects.toMatchObject({ status: 403 });
    api.use(http.get(SETTINGS_URL, () => problem(500, 'common.internal')));
    await expect(page()).rejects.toMatchObject({ status: 500 });
  });
});
