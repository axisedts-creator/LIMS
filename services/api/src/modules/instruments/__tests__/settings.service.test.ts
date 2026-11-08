// C7 API-T05 — settings service E40/E41 (02-TRD §5.10 settings_changed, 05-SCHEMA §2.17; AC-15.5 update-window part). Seams: instruments.helpers.ts header.
// done_when: "settings_changed on update-window change" — one config version for EVERY non-retired agent of the tenant, in the E41 transaction.
import { describe, expect, it } from 'vitest';
import { createSettingsService } from '../service/settings.service.js';
import { responseViolations } from './agents.contract.js';
import { AGENT_A1, AGENT_A2, AGENT_B, AGENT_PENDING, AGENT_RETIRED, TENANT_A, TENANT_B, USER, idN, makeCtx, makePublisher, makeRepo, noRights, readOnly, rejection, settingsRow, type FakeSeed } from './instruments.helpers.js';

function world(seed: FakeSeed = {}, ctxOver: Parameters<typeof makeCtx>[0] = {}, failPublishOn?: number) {
  const r = makeRepo(seed); const pub = makePublisher(failPublishOn); const c = makeCtx(ctxOver);
  const svc: any = createSettingsService({ repo: r.repo, publish: pub.publish, now: () => new Date('2026-11-07T12:00:00.000Z') });
  return { ...r, ...c, pub, svc };
}
const code = (e: any) => e?.code;
const BODY = { default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 300, agent_uploaded_retention_hours: 24 };
const WINDOW = { update_window_from: '01:00', update_window_to: '04:00' };
const put = (w: any, body: Record<string, unknown>, expectedVersion: number | undefined = 1) => w.svc.updateInstrumentSettings(w.ctx, { expectedVersion, body });
const withWindow = (o: Record<string, unknown> = {}) => settingsRow({ ...WINDOW, ...o });

describe('fail closed', () => {
  it.each(['getInstrumentSettings', 'updateInstrumentSettings'])('%s without tenant / actor / tx -> auth.unauthenticated, repo untouched', async (op) => {
    const w = world({ settings: [settingsRow()] });
    for (const bad of [{}, { tenantId: 'x' }, { tenantId: TENANT_A, actor: { id: USER } }, { ...w.ctx, tx: undefined }]) expect(code(await rejection(w.svc[op](bad, { expectedVersion: 1, body: BODY })))).toBe('auth.unauthenticated');
    expect(w.calls).toHaveLength(0);
  });
});

describe('E40 getInstrumentSettings', () => {
  it('first read creates the tenant row lazily with the 05-SCHEMA §2.17 defaults and returns it (200, schema-valid, version 1)', async () => {
    const w = world();
    const r = await w.svc.getInstrumentSettings(w.ctx, {});
    expect(r.status).toBe(200); expect(r.version).toBe(1);
    expect(r.body).toEqual({ default_backlog_threshold: 500, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 300, agent_uploaded_retention_hours: 24, version: 1 });
    expect(responseViolations('getInstrumentSettings', '200', r.body)).toEqual([]);
    expect(w.callsOf('insertDefaultSettings')).toHaveLength(1); expect(w.callsOf('insertDefaultSettings')[0]!.tenantId).toBe(TENANT_A);
    expect(w.asserted).toEqual([{ permission: 'instruments.instrument.read' }]);
  });
  it('second read does not insert again', async () => {
    const w = world();
    await w.svc.getInstrumentSettings(w.ctx, {}); await w.svc.getInstrumentSettings(w.ctx, {});
    expect(w.callsOf('insertDefaultSettings')).toHaveLength(1);
  });
  it('an existing row is returned as is; update window rendered HH:MM even when the DB returns HH:MM:SS; no id / tenant / audit columns leak', async () => {
    const w = world({ settings: [settingsRow({ update_window_from: '01:00:00', update_window_to: '04:30:00', version: 4, default_backlog_threshold: 700 })] });
    const r = await w.svc.getInstrumentSettings(w.ctx, {});
    expect(r.body).toEqual({ default_backlog_threshold: 700, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 300, agent_uploaded_retention_hours: 24, update_window_from: '01:00', update_window_to: '04:30', version: 4 });
    expect(responseViolations('getInstrumentSettings', '200', r.body)).toEqual([]);
    expect(w.callsOf('insertDefaultSettings')).toHaveLength(0);
    expect(r.version).toBe(4);
  });
  it('S-01: reads only the caller\'s tenant row (every repo call carries ctx.tenantId)', async () => {
    const w = world({ settings: [settingsRow({ tenant_id: TENANT_B, default_backlog_threshold: 9999 })] });
    const r = await w.svc.getInstrumentSettings(w.ctx, {});
    expect(r.body.default_backlog_threshold).toBe(500);
    expect(w.calls.every((c) => c.tenantId === TENANT_A)).toBe(true);
  });
  it('S-04: a principal without instrument.read gets 403 and nothing (not even the lazy insert) is written', async () => {
    const w = world({}, { roles: noRights });
    expect(code(await rejection(w.svc.getInstrumentSettings(w.ctx, {})))).toBe('auth.forbidden');
    expect(w.mutations()).toHaveLength(0);
  });
});

describe('E41 updateInstrumentSettings — validation, If-Match, privilege', () => {
  it('valid update: 200, values stored, version +1 (result.version and body.version), response schema-valid, asserts instrument.manage (tenant-level, no centre)', async () => {
    const w = world({ settings: [settingsRow()] });
    const r = await put(w, { ...BODY, default_backlog_threshold: 800, clock_offset_warn_seconds: 120 });
    expect(r.status).toBe(200); expect(r.version).toBe(2); expect(r.body).toMatchObject({ default_backlog_threshold: 800, clock_offset_warn_seconds: 120, version: 2 });
    expect(responseViolations('updateInstrumentSettings', '200', r.body)).toEqual([]);
    expect(w.callsOf('updateSettings')[0]).toMatchObject({ tenantId: TENANT_A });
    expect(w.asserted).toEqual([{ permission: 'instruments.instrument.manage' }]);
  });
  it('missing If-Match -> 428 common.precondition_required; stale -> 409 common.version_conflict; neither writes nor publishes', async () => {
    const w = world({ settings: [withWindow()] });
    expect(code(await rejection(w.svc.updateInstrumentSettings(w.ctx, { expectedVersion: undefined, body: { ...BODY } })))).toBe('common.precondition_required');
    expect(code(await rejection(put(w, { ...BODY, update_window_from: '02:00', update_window_to: '05:00' }, 9)))).toBe('common.version_conflict');
    expect(w.pub.calls).toHaveLength(0); expect(w.callsOf('listNonRetiredAgentIds')).toHaveLength(0);
  });
  it.each([
    ['default_backlog_threshold', 9], ['default_backlog_threshold', 100001], ['backlog_max_oldest_pending_seconds', 59], ['backlog_max_oldest_pending_seconds', 86401],
    ['clock_offset_warn_seconds', 29], ['clock_offset_warn_seconds', 3601], ['agent_uploaded_retention_hours', 0], ['agent_uploaded_retention_hours', 73],
    ['default_backlog_threshold', 500.5], ['default_backlog_threshold', '500'], ['agent_uploaded_retention_hours', null],
  ])('%s = %j -> 400 common.validation_failed at /%s, nothing written', async (field, value) => {
    const w = world({ settings: [settingsRow()] });
    const e = await rejection(put(w, { ...BODY, [field as string]: value }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.[0]?.path).toBe(`/${field}`);
    expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
  });
  it('boundary values 10/100000, 60/86400, 30/3600, 1/72 are accepted', async () => {
    for (const body of [
      { default_backlog_threshold: 10, backlog_max_oldest_pending_seconds: 60, clock_offset_warn_seconds: 30, agent_uploaded_retention_hours: 1 },
      { default_backlog_threshold: 100000, backlog_max_oldest_pending_seconds: 86400, clock_offset_warn_seconds: 3600, agent_uploaded_retention_hours: 72 },
    ]) expect((await put(world({ settings: [settingsRow()] }), body)).status).toBe(200);
  });
  it.each([['missing a required field', (b: any) => { delete b.clock_offset_warn_seconds; }], ['unknown property', (b: any) => { b.retention_years = 7; }], ['smuggled version', (b: any) => { b.version = 99; }], ['smuggled tenant_id', (b: any) => { b.tenant_id = TENANT_B; }]])(
    '%s -> 400 common.validation_failed (closed body; raw-archive retention is NOT a C7 setting), nothing written', async (_n, mutate) => {
      const w = world({ settings: [settingsRow()] }); const body: any = { ...BODY }; mutate(body);
      expect(code(await rejection(put(w, body)))).toBe('common.validation_failed'); expect(w.mutations()).toHaveLength(0);
    });
  it.each([['only from', { update_window_from: '01:00' }, '/update_window_to'], ['only to', { update_window_to: '04:00' }, '/update_window_from']])('update window: %s -> 400 (both or neither), nothing written', async (_n, win, path) => {
    const w = world({ settings: [settingsRow()] });
    const e = await rejection(put(w, { ...BODY, ...win }));
    expect(code(e)).toBe('common.validation_failed'); expect(e.errors?.map((x: any) => x.path)).toContain(path);
    expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
  });
  it.each(['24:00', '1:00', '01:60', '0100', '01:00:00', 'ab:cd', ''])('update window time %j is not HH:MM -> 400', async (t) => {
    const w = world({ settings: [settingsRow()] });
    expect(code(await rejection(put(w, { ...BODY, update_window_from: t, update_window_to: '04:00' })))).toBe('common.validation_failed');
    expect(w.mutations()).toHaveLength(0);
  });
  it('a window that spans midnight (from > to) is valid (TRD §5.10 "to < from means spans midnight")', async () => {
    const w = world({ settings: [settingsRow()] });
    expect((await put(w, { ...BODY, update_window_from: '22:00', update_window_to: '02:00' })).status).toBe(200);
  });
  it('S-04: technologist / reader (instrument.read only) -> 403; nothing written, nothing published', async () => {
    const w = world({ settings: [settingsRow()] }, { roles: readOnly });
    expect(code(await rejection(put(w, { ...BODY, ...WINDOW })))).toBe('auth.forbidden');
    expect(w.mutations()).toHaveLength(0); expect(w.pub.calls).toHaveLength(0);
  });
  it('first write on a tenant with no row yet: the row is created lazily, then updated with If-Match 1', async () => {
    const w = world();
    const r = await put(w, { ...BODY, default_backlog_threshold: 600 });
    expect(r.status).toBe(200); expect(r.body.default_backlog_threshold).toBe(600); expect(r.version).toBe(2);
  });
  it('mass assignment: the row written has only the six mutable columns (no id / tenant_id / version / audit columns)', async () => {
    const w = world({ settings: [settingsRow()] });
    await put(w, { ...BODY, ...WINDOW });
    const row = w.callsOf('updateSettings')[0]!.args[1] as Record<string, unknown>;
    const allowed = ['agent_uploaded_retention_hours', 'backlog_max_oldest_pending_seconds', 'clock_offset_warn_seconds', 'default_backlog_threshold', 'update_window_from', 'update_window_to', 'updated_by'];
    expect(Object.keys(row).filter((k) => !allowed.includes(k))).toEqual([]);
    expect(row).toMatchObject({ default_backlog_threshold: 500, update_window_from: '01:00', update_window_to: '04:00' });
  });
});

describe('E41 settings_changed config versions — AC-15.5 (window part), TRD §5.10', () => {
  const seedAgents = () => [
    { ...makeRepo().agents[0]!, id: AGENT_A1 }, { ...makeRepo().agents[1]!, id: AGENT_A2 }, makeRepo().agents[2]!, makeRepo().agents[3]!, makeRepo().agents[4]!,
  ];   // A1 active, A2 active, RETIRED, PENDING (non-retired), tenant-B agent
  it('window set for the first time -> ONE settings_changed version for EVERY non-retired agent of the tenant (active AND pending_enrolment), none for retired agents or other tenants', async () => {
    const w = world({ settings: [settingsRow()], agents: seedAgents() });
    const r = await put(w, { ...BODY, ...WINDOW });
    expect(r.status).toBe(200);
    expect(w.pub.reasons()).toEqual(['settings_changed', 'settings_changed', 'settings_changed']);
    expect([...w.pub.agentIds()].sort()).toEqual([AGENT_A1, AGENT_A2, AGENT_PENDING].sort());
    expect(w.pub.agentIds()).not.toContain(AGENT_RETIRED); expect(w.pub.agentIds()).not.toContain(AGENT_B);
    expect(w.pub.calls.every((c) => c.tenantId === TENANT_A && c.actorId === USER)).toBe(true);
    expect(w.callsOf('listNonRetiredAgentIds')[0]!.tenantId).toBe(TENANT_A);
  });
  it('the versions are created in the E41 transaction (same tx object) and AFTER the settings row is updated', async () => {
    const w = world({ settings: [settingsRow()], agents: seedAgents() });
    await put(w, { ...BODY, ...WINDOW });
    expect(w.pub.calls.every((c) => c.tx === w.ctx.tx)).toBe(true);
    expect(w.calls.findIndex((c) => c.op === 'updateSettings')).toBeGreaterThanOrEqual(0);
    expect(w.calls.findIndex((c) => c.op === 'updateSettings')).toBeLessThan(w.calls.findIndex((c) => c.op === 'listNonRetiredAgentIds'));
  });
  it.each([
    ['from changed', { update_window_from: '02:00', update_window_to: '04:00' }], ['to changed', { update_window_from: '01:00', update_window_to: '05:00' }],
    ['both changed', { update_window_from: '22:00', update_window_to: '02:00' }], ['window cleared (PUT without the pair)', {}],
  ])('window already 01:00-04:00, %s -> a version per non-retired agent', async (_n, win) => {
    const w = world({ settings: [withWindow()], agents: seedAgents() });
    const r = await put(w, { ...BODY, ...win });
    expect(w.pub.calls).toHaveLength(3);
    if (!Object.keys(win).length) { expect(r.body.update_window_from).toBeUndefined(); expect(r.body.update_window_to).toBeUndefined(); }
  });
  it('same window re-sent (even when the DB returns HH:MM:SS) -> NO config versions', async () => {
    const w = world({ settings: [settingsRow({ update_window_from: '01:00:00', update_window_to: '04:00:00' })], agents: seedAgents() });
    await put(w, { ...BODY, default_backlog_threshold: 700, ...WINDOW });
    expect(w.pub.calls).toHaveLength(0);
  });
  it('only non-window settings changed (no window before or after) -> NO config versions', async () => {
    const w = world({ settings: [settingsRow()], agents: seedAgents() });
    await put(w, { ...BODY, agent_uploaded_retention_hours: 48 });
    expect(w.pub.calls).toHaveLength(0);
  });
  it('a window change on a tenant with no non-retired agents succeeds and publishes nothing', async () => {
    const w = world({ settings: [settingsRow()], agents: [makeRepo().agents[2]!, makeRepo().agents[4]!] });
    expect((await put(w, { ...BODY, ...WINDOW })).status).toBe(200);
    expect(w.pub.calls).toHaveLength(0);
  });
  it('a publisher failure for ANY agent propagates (the core rolls back the settings update and every earlier version); not swallowed, not reported as success', async () => {
    const w = world({ settings: [settingsRow()], agents: seedAgents() }, {}, 2);
    await expect(put(w, { ...BODY, ...WINDOW })).rejects.toThrow('signing unavailable');
  });
  it('version conflict -> neither listing agents nor publishing happens', async () => {
    const w = world({ settings: [withWindow({ version: 3 })], agents: seedAgents() });
    expect(code(await rejection(put(w, { ...BODY, update_window_from: '02:00', update_window_to: '05:00' }, 1)))).toBe('common.version_conflict');
    expect(w.pub.calls).toHaveLength(0); expect(w.callsOf('listNonRetiredAgentIds')).toHaveLength(0);
  });
  it('S-01: a tenant-B settings change never reaches tenant-A agents', async () => {
    const w = world({ settings: [settingsRow({ tenant_id: TENANT_B, id: idN(0x5e0b) })], agents: seedAgents() }, { tenantId: TENANT_B });
    await put(w, { ...BODY, ...WINDOW });
    expect(w.pub.agentIds()).toEqual([AGENT_B]);
  });
});
