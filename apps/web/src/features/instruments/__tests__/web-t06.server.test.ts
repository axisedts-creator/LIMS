// WEB-T06 — BFF server functions for SCR-11 settings (E40 getInstrumentSettings, E41 updateInstrumentSettings) + static guards.
// ACs: AC-15.5 (window part: E41 carries the update window; If-Match optimistic concurrency, 02-TRD §7.4 / E41).
// ASSUMED module/signature contract (spec gives operationIds + folders only; dispute if wrong):
//   server/getInstrumentSettings.server.ts     getInstrumentSettings() → InstrumentSettings                       GET /v1/instruments/settings
//   server/updateInstrumentSettings.server.ts  updateInstrumentSettings(version, body) → InstrumentSettings       PUT /v1/instruments/settings, If-Match "<version>"
//   server/actions.ts                          updateInstrumentSettingsAction(version, body) → ActionResult<…>    (ApiError → {ok:false, status, code})
// Invalid input must throw ApiError(400 common.validation_failed) BEFORE any network call. Synthetic data only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

vi.mock('server-only', () => ({}));
vi.mock('@/core/session/server', () => ({ getAccessToken: async () => 'jwt-synthetic', getShellSession: async () => undefined }));

const ORIGIN = 'http://api.test';
process.env.LIMS_ORIGIN_API = ORIGIN;
const URL_SETTINGS = `${ORIGIN}/v1/instruments/settings`;

const settings = (o: Record<string, unknown> = {}) => ({ default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 120, agent_uploaded_retention_hours: 24, update_window_from: '01:00', update_window_to: '04:00', version: 1, ...o });
const body = (o: Record<string, unknown> = {}) => { const { version: _v, ...b } = settings(); return { ...b, ...o }; };

const seen: { url: URL; method: string; headers: Headers; body?: any }[] = [];
const rec = async (r: Request) => { seen.push({ url: new URL(r.url), method: r.method, headers: r.headers, body: r.method === 'GET' ? undefined : await r.clone().json().catch(() => undefined) }); };
const problem = (status: number, code: string) => HttpResponse.json({ type: `urn:lims:error:${code}`, title: code, status, code }, { status });
const server = setupServer(
  http.get(URL_SETTINGS, async ({ request }) => { await rec(request); return HttpResponse.json(settings()); }),
  http.put(URL_SETTINGS, async ({ request }) => { await rec(request); return HttpResponse.json(settings({ version: 2 })); }),
);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => { server.resetHandlers(); seen.length = 0; });
afterAll(() => server.close());

const load = async () => (await import('../server/updateInstrumentSettings.server')).updateInstrumentSettings;
const rejects400 = async (p: Promise<unknown>) => { await expect(p).rejects.toMatchObject({ status: 400, problem: { code: 'common.validation_failed' } }); expect(seen).toHaveLength(0); };

describe('E40 getInstrumentSettings', () => {
  it('GET /v1/instruments/settings with the bearer token; returns the DTO incl. version', async () => {
    const { getInstrumentSettings } = await import('../server/getInstrumentSettings.server');
    const s = await getInstrumentSettings();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url.pathname).toBe('/v1/instruments/settings');
    expect(seen[0]!.headers.get('authorization')).toBe('Bearer jwt-synthetic');
    expect(s).toMatchObject({ default_backlog_threshold: 500, update_window_from: '01:00', version: 1 });
  });

  it('403 (no instruments.instrument.read) propagates as ApiError, not swallowed', async () => {
    server.use(http.get(URL_SETTINGS, () => problem(403, 'auth.forbidden')));
    const { getInstrumentSettings } = await import('../server/getInstrumentSettings.server');
    await expect(getInstrumentSettings()).rejects.toMatchObject({ status: 403, problem: { code: 'auth.forbidden' } });
  });
});

describe('E41 updateInstrumentSettings (AC-15.5 window part)', () => {
  it('PUT with If-Match "<version>" and the mutable fields as JSON; returns the new DTO', async () => {
    const update = await load();
    const r = await update(1, body());
    expect(seen).toHaveLength(1);
    const c = seen[0]!;
    expect(c.method).toBe('PUT');
    expect(c.url.pathname).toBe('/v1/instruments/settings');
    expect(c.headers.get('if-match')).toBe('"1"');
    expect(c.headers.get('content-type')).toMatch(/application\/json/);
    expect(c.body).toEqual(body());
    expect(c.body).not.toHaveProperty('version'); // version is read-only: it travels as If-Match only
    expect(r.version).toBe(2);
  });

  it('window may be omitted entirely (both or neither) → body without update_window_*', async () => {
    const update = await load();
    await update(3, { default_backlog_threshold: 10, backlog_max_oldest_pending_seconds: 60, clock_offset_warn_seconds: 30, agent_uploaded_retention_hours: 1 });
    expect(seen[0]!.headers.get('if-match')).toBe('"3"');
    expect(seen[0]!.body).not.toHaveProperty('update_window_from');
    expect(seen[0]!.body).not.toHaveProperty('update_window_to');
  });

  it('boundary values of every range are accepted (TRD §7.4)', async () => {
    const update = await load();
    await update(1, body({ default_backlog_threshold: 10, backlog_max_oldest_pending_seconds: 60, clock_offset_warn_seconds: 30, agent_uploaded_retention_hours: 1, update_window_from: '00:00', update_window_to: '23:59' }));
    await update(1, body({ default_backlog_threshold: 100000, backlog_max_oldest_pending_seconds: 86400, clock_offset_warn_seconds: 3600, agent_uploaded_retention_hours: 72 }));
    expect(seen).toHaveLength(2);
  });

  it.each([
    ['default_backlog_threshold', 9], ['default_backlog_threshold', 100001],
    ['backlog_max_oldest_pending_seconds', 59], ['backlog_max_oldest_pending_seconds', 86401],
    ['clock_offset_warn_seconds', 29], ['clock_offset_warn_seconds', 3601],
    ['agent_uploaded_retention_hours', 0], ['agent_uploaded_retention_hours', 73],
    ['default_backlog_threshold', 10.5], ['agent_uploaded_retention_hours', Number.NaN], ['clock_offset_warn_seconds', '120'],
  ])('out-of-range / non-integer %s=%s → 400 before any network call', async (k, v) => {
    const update = await load();
    await rejects400(update(1, body({ [k]: v }) as never));
  });

  it.each([['24:00'], ['1:00'], ['12:60'], ['0100'], ['01:00:00'], ['aa:bb'], ['']])('update_window_from=%j (bad HH:MM) → 400 before any network call', async (v) => {
    const update = await load();
    await rejects400(update(1, body({ update_window_from: v }) as never));
  });

  it('only one of update_window_from / update_window_to → 400 (both or neither)', async () => {
    const update = await load();
    const { update_window_to: _t, ...onlyFrom } = body();
    const { update_window_from: _f, ...onlyTo } = body();
    await rejects400(update(1, onlyFrom as never));
    await rejects400(update(1, onlyTo as never));
  });

  it.each([[0], [-1], [1.5], [Number.NaN], ['1']])('invalid version %j → 400 before any network call (never "NaN" in If-Match)', async (v) => {
    const update = await load();
    await rejects400(update(v as never, body()));
  });

  it('missing required field → 400 before any network call', async () => {
    const update = await load();
    const { clock_offset_warn_seconds: _c, ...rest } = body();
    await rejects400(update(1, rest as never));
  });

  it('SECURITY: no raw-archive retention can be sent — unknown / retention keys are rejected or dropped, never forwarded (D-42: C2 owns it)', async () => {
    const update = await load();
    const r = await update(1, body({ raw_retention_years: 0, rawInstrumentYears: 0, retention_years: 0, version: 99, __proto__: { x: 1 } }) as never).then(() => 'sent', () => 'rejected');
    if (r === 'sent') {
      const b = seen[0]!.body;
      expect(Object.keys(b).sort()).toEqual(Object.keys(body()).sort());
    } else {
      expect(seen).toHaveLength(0);
    }
  });

  it('409 common.version_conflict propagates as ApiError (If-Match lost)', async () => {
    server.use(http.put(URL_SETTINGS, () => problem(409, 'common.version_conflict')));
    const update = await load();
    await expect(update(1, body())).rejects.toMatchObject({ status: 409, problem: { code: 'common.version_conflict' } });
  });

  it('server action maps ApiError to { ok:false, status, code } (409 and 400 with errors[] pointers)', async () => {
    const { updateInstrumentSettingsAction } = await import('../server/actions');
    server.use(http.put(URL_SETTINGS, () => problem(409, 'common.version_conflict')));
    expect(await updateInstrumentSettingsAction(1, body())).toMatchObject({ ok: false, status: 409, code: 'common.version_conflict' });
    server.use(http.put(URL_SETTINGS, () => HttpResponse.json({ type: 'urn:lims:error:common.validation_failed', title: 'v', status: 400, code: 'common.validation_failed', errors: [{ path: '/default_backlog_threshold', code: 'range', message: 'out of range' }] }, { status: 400 })));
    const r = await updateInstrumentSettingsAction(1, body());
    expect(r).toMatchObject({ ok: false, status: 400, code: 'common.validation_failed', errors: [{ path: '/default_backlog_threshold' }] });
  });

  it('server action success → { ok:true } carrying the new version', async () => {
    const { updateInstrumentSettingsAction } = await import('../server/actions');
    const r = await updateInstrumentSettingsAction(1, body());
    expect(r).toMatchObject({ ok: true, data: { version: 2 } });
  });
});

describe('static guards on the WEB-T06 files (REQ-SEC-068: browser holds no JWT/API origin)', () => {
  const WEB = async () => (await import('node:path')).join(import.meta.dirname, '..', '..', '..', '..');
  const read = async (rel: string) => (await import('node:fs')).readFileSync((await import('node:path')).join(await WEB(), rel), 'utf8');
  const exists = async (rel: string) => (await import('node:fs')).existsSync((await import('node:path')).join(await WEB(), rel));

  it('new server fns start with the "server-only" guard', async () => {
    for (const n of ['getInstrumentSettings', 'updateInstrumentSettings']) {
      const p = `src/features/instruments/server/${n}.server.ts`;
      expect(await exists(p), n).toBe(true);
      expect(await read(p), n).toMatch(/^(\s*\/\/[^\n]*\n|\s*'use server';?\s*\n)*\s*import ['"]server-only['"]/);
    }
  });

  it('the settings component never mentions the API origin, bearer tokens or persistence; no dangerouslySetInnerHTML', async () => {
    const p = 'src/features/instruments/components/InstrumentSettingsForm.tsx';
    expect(await exists(p)).toBe(true);
    expect(await read(p)).not.toMatch(/LIMS_ORIGIN_API|authorization|Bearer |localStorage|sessionStorage|document\.cookie|dangerouslySetInnerHTML/i);
  });

  it('the settings component has no raw-archive retention field (D-42: C2 tenant setting retention.rawInstrumentYears)', async () => {
    const src = await read('src/features/instruments/components/InstrumentSettingsForm.tsx');
    expect(src).not.toMatch(/rawInstrumentYears|raw_retention|retention_years|retentionYears/);
  });

  it('settings page exists as a server component (no "use client")', async () => {
    const p = 'src/app/(staff)/instruments/settings/page.tsx';
    expect(await exists(p)).toBe(true);
    expect(await read(p)).not.toMatch(/^\s*['"]use client['"]/);
  });
});
