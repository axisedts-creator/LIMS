// T0B-MSGDESK-1 done_when (4) TEMPLATES + (6) permission / tenant isolation, for the broadcast template operations (contracts/openapi/engagement.yaml, T0C-MSGDESK-1).
// Real PG17 under RLS (helpers.ts). Synthetic data only.
// PINNED PICKS (lead decisions of this task; the contract text has no wording for them, a change needs a ruling):
//  - placeholders are written {{name}} exactly (lowercase, no inner spaces); anything else inside {{ }} is unknown -> 422 engagement.broadcast_placeholder_unknown, on create and on update.
//  - the body is PLAIN TEXT (contract: "Plain text only (no HTML, no attachment)"): a body carrying a tag that can run script or load a resource (<script, <iframe, <img, <a , on...= handlers)
//    is refused with 400 common.validation_failed; the "safe subset" of the brief is therefore the empty set for stored templates, the channel escaping happens when a value is rendered.
//  - an email channel template needs a subject; sms and whatsapp templates ignore a subject (stored absent). A missing email subject is 400 common.validation_failed.
//  - update needs If-Match "<version>": missing = 428 common.precondition_required, stale = 409 common.version_conflict; every change bumps version by 1.
//  - another tenant's template answers 404 common.not_found (same as an unknown id); a wrong actor type or a missing permission answers 403 auth.forbidden before any lookup.
import { describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';
import { ALL_B, PERM, T, TENANT_A, callWith, errCode, idem, ownerRows, rejection, req, schemaErrors, specOf, staff, uid, type Claims } from './helpers.js';

const H = manifest.handlers as Record<string, (r: any, c: any) => Promise<any>>;
const spec = specOf('engagement');
const call = (op: string, r: ReturnType<typeof req>, o: Parameters<typeof callWith>[4] = {}) => callWith(H, op, r, { grants: ALL_B, ...o });
const bad = (op: string, r: ReturnType<typeof req>, o: Parameters<typeof callWith>[4] = {}) => rejection(call(op, r, o));
const mk = (o: Record<string, unknown> = {}) => ({ name: `Synthetic template ${uid().slice(-8)}`, channel: 'sms', body: 'Dear {{party_name}}, {{lab_name}} is closed on {{send_date}}.', ...o });
const create = (body: object, o: Parameters<typeof callWith>[4] = {}) => call('createBroadcastTemplate', req({ body, headers: idem() }), o);
const update = (id: string, body: object, ifMatch: string | null, o: Parameters<typeof callWith>[4] = {}) =>
  call('updateBroadcastTemplate', req({ params: { template_id: id }, body, headers: { ...idem(), ...(ifMatch === null ? {} : { 'if-match': ifMatch }) } }), o);

describe('(4) create: closed placeholder list, derived placeholders, row stored for the tenant', () => {
  it('201 BroadcastTemplate (schema valid), placeholders derived by the server, active, version 1, tenant A row', { timeout: T }, async () => {
    const r = await create(mk());
    expect(r.status).toBe(201);
    expect(schemaErrors(spec, 'BroadcastTemplate', r.body)).toEqual([]);
    expect([...r.body.placeholders].sort()).toEqual(['lab_name', 'party_name', 'send_date']);
    expect(r.body).toMatchObject({ is_active: true, version: 1, channel: 'sms' });
    const [row] = await ownerRows('engagement.broadcast_template', 'id = $1', [r.body.id]);
    expect(row.tenant_id).toBe(TENANT_A);
    expect(row.body).toBe(mk().body);
  });
  it('a client supplied placeholders list is ignored (derived from the body)', { timeout: T }, async () => {
    const r = await create({ ...mk({ body: 'Hello {{party_name}}' }), placeholders: ['lab_phone'] });
    expect(r.status).toBe(201);
    expect(r.body.placeholders).toEqual(['party_name']);
  });
  it.each(['{{patient_name}}', '{{PARTY_NAME}}', '{{ party_name }}', '{{party_name}', '{{}}', '{{lab_name.x}}'])('unknown placeholder %s is refused: 422 engagement.broadcast_placeholder_unknown', { timeout: T }, async (ph) => {
    const e = await bad('createBroadcastTemplate', req({ body: mk({ body: `Hello ${ph} today` }), headers: idem() }));
    expect(['engagement.broadcast_placeholder_unknown', 'common.validation_failed']).toContain(errCode(e));
    if (ph.startsWith('{{') && ph.endsWith('}}') && ph !== '{{}}') expect(errCode(e)).toBe('engagement.broadcast_placeholder_unknown');
    expect(e.statusCode).toBe(errCode(e) === 'engagement.broadcast_placeholder_unknown' ? 422 : 400);
    expect((await ownerRows('engagement.broadcast_template', "tenant_id = $1 AND body = $2", [TENANT_A, mk({ body: `Hello ${ph} today` }).body])).length).toBe(0);
  });
  it.each(['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<iframe src="https://evil.example"></iframe>', '<a href="https://evil.example">x</a>'])('markup %s in a body is refused: 400', { timeout: T }, async (html) => {
    for (const channel of ['email', 'sms']) {
      const e = await bad('createBroadcastTemplate', req({ body: mk({ channel, subject: channel === 'email' ? 'Notice' : undefined, body: `Dear {{party_name}} ${html}` }), headers: idem() }));
      expect(errCode(e), channel).toBe('common.validation_failed');
    }
  });
  it('plain text with a lone < or & is accepted (no false positive on "a < b & c")', { timeout: T }, async () => {
    const r = await create(mk({ body: 'Rates: 5 < 10 & 20 > 3 for {{party_name}}' }));
    expect(r.status).toBe(201);
    expect(r.body.body).toBe('Rates: 5 < 10 & 20 > 3 for {{party_name}}');
  });
  it('email template needs a subject; sms ignores a subject', { timeout: T }, async () => {
    expect(errCode(await bad('createBroadcastTemplate', req({ body: mk({ channel: 'email' }), headers: idem() })))).toBe('common.validation_failed');
    const ok = await create(mk({ channel: 'email', subject: 'Holiday notice' }));
    expect(ok.status).toBe(201);
    expect(ok.body.subject).toBe('Holiday notice');
    const sms = await create(mk({ channel: 'sms', subject: 'ignored' }));
    expect(sms.body.subject).toBeUndefined();
  });
  it('length limits: body 1000, name 120 are accepted at the limit and refused above it', { timeout: T }, async () => {
    expect((await create(mk({ body: 'x'.repeat(1000) }))).status).toBe(201);
    expect(errCode(await bad('createBroadcastTemplate', req({ body: mk({ body: 'x'.repeat(1001) }), headers: idem() })))).toBe('common.validation_failed');
    expect(errCode(await bad('createBroadcastTemplate', req({ body: mk({ name: 'n'.repeat(121) }), headers: idem() })))).toBe('common.validation_failed');
  });
  it('writes a row audit event (audit.audit_log) for the new template', { timeout: T }, async () => {
    const r = await create(mk());
    const rows = await ownerRows('audit.audit_log', "tenant_id = $1 AND schema_name = 'engagement' AND table_name = 'broadcast_template' AND row_id = $2", [TENANT_A, r.body.id]);
    expect(rows.map((x) => x.action)).toEqual(['INSERT']);
  });
});

describe('update and deactivate', () => {
  it('update re-checks the placeholder rule, bumps version, keeps the channel, re-derives placeholders', { timeout: T }, async () => {
    const c = (await create(mk({ body: 'Hi {{party_name}}' }))).body;
    const bad1 = await rejection(update(c.id, { body: 'Hi {{patient_name}}' }, '"1"'));
    expect(errCode(bad1)).toBe('engagement.broadcast_placeholder_unknown');
    expect((await ownerRows('engagement.broadcast_template', 'id = $1', [c.id]))[0].body).toBe('Hi {{party_name}}');
    const r = await update(c.id, { body: 'Hi {{party_name}} from {{lab_phone}}', name: 'Renamed' }, '"1"');
    expect(r.status).toBe(200);
    expect(schemaErrors(spec, 'BroadcastTemplate', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ version: 2, name: 'Renamed', channel: 'sms' });
    expect([...r.body.placeholders].sort()).toEqual(['lab_phone', 'party_name']);
  });
  it('If-Match: missing = 428 precondition_required, stale = 409 version_conflict, row unchanged', { timeout: T }, async () => {
    const c = (await create(mk())).body;
    expect(errCode(await rejection(update(c.id, { name: 'No match' }, null)))).toBe('common.precondition_required');
    await update(c.id, { name: 'First' }, '"1"');
    expect(errCode(await rejection(update(c.id, { name: 'Second' }, '"1"')))).toBe('common.version_conflict');
    expect((await ownerRows('engagement.broadcast_template', 'id = $1', [c.id]))[0].name).toBe('First');
  });
  it('deactivate sets is_active false (200, version + 1), never deletes, and writes an audit UPDATE', { timeout: T }, async () => {
    const c = (await create(mk())).body;
    const r = await call('deactivateBroadcastTemplate', req({ params: { template_id: c.id }, headers: { ...idem(), 'if-match': '"1"' } }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: c.id, is_active: false, version: 2 });
    expect((await ownerRows('engagement.broadcast_template', 'id = $1', [c.id])).length).toBe(1);
    const a = await ownerRows('audit.audit_log', "tenant_id = $1 AND table_name = 'broadcast_template' AND row_id = $2 ORDER BY occurred_at", [TENANT_A, c.id]);
    expect(a.map((x) => x.action)).toEqual(['INSERT', 'UPDATE']);
  });
  it('list: tenant A sees its templates only; filters is_active and channel; 200 BroadcastTemplatePage', { timeout: T }, async () => {
    const a = (await create(mk({ channel: 'whatsapp' }))).body;
    const off = (await create(mk({ channel: 'sms' }))).body;
    await call('deactivateBroadcastTemplate', req({ params: { template_id: off.id }, headers: { ...idem(), 'if-match': '"1"' } }));
    const b = (await create(mk(), { claims: staff('b') })).body;
    const all = await call('listBroadcastTemplates', req({ query: { limit: 200 } }));
    expect(all.status).toBe(200);
    expect(schemaErrors(spec, 'BroadcastTemplatePage', all.body)).toEqual([]);
    const ids = all.body.data.map((x: any) => x.id);
    expect(ids).toContain(a.id); expect(ids).not.toContain(b.id);
    const act = await call('listBroadcastTemplates', req({ query: { is_active: true, limit: 200 } }));
    expect(act.body.data.every((x: any) => x.is_active)).toBe(true);
    expect(act.body.data.map((x: any) => x.id)).not.toContain(off.id);
    const wa = await call('listBroadcastTemplates', req({ query: { channel: 'whatsapp', limit: 200 } }));
    expect(wa.body.data.every((x: any) => x.channel === 'whatsapp')).toBe(true);
    expect(wa.body.data.map((x: any) => x.id)).toContain(a.id);
  });
});

describe('(6) permission denied, wrong actor type, tenant isolation', () => {
  const OPS: Array<[string, string, (id: string) => ReturnType<typeof req>]> = [
    ['listBroadcastTemplates', PERM.bRead, () => req()],
    ['createBroadcastTemplate', PERM.bManage, () => req({ body: mk(), headers: idem() })],
    ['updateBroadcastTemplate', PERM.bManage, (id) => req({ params: { template_id: id }, body: { name: 'x' }, headers: { ...idem(), 'if-match': '"1"' } })],
    ['deactivateBroadcastTemplate', PERM.bManage, (id) => req({ params: { template_id: id }, headers: { ...idem(), 'if-match': '"1"' } })],
  ];
  it.each(OPS)('%s without %s: 403 auth.forbidden and nothing written', { timeout: T }, async (op, perm, build) => {
    const t = (await create(mk())).body;
    const others = ALL_B.filter((p) => p !== perm);
    const r = build(t.id);
    expect(errCode(await rejection(callWith(H, op, r, { grants: others })))).toBe('auth.forbidden');
    if (r.body?.name) expect((await ownerRows('engagement.broadcast_template', 'tenant_id = $1 AND name = $2', [TENANT_A, r.body.name])).length).toBe(0);
    expect((await ownerRows('engagement.broadcast_template', 'id = $1', [t.id]))[0]).toMatchObject({ version: 1, name: t.name, is_active: true });
  });
  it.each(['partner', 'patient', 'portal', 'device'] as const)('%s actor is refused on every template operation (403)', { timeout: T }, async (type) => {
    const t = (await create(mk())).body;
    const claims: Claims = { ...staff('a'), type };
    for (const [op, , build] of OPS) expect(errCode(await rejection(callWith(H, op, build(t.id), { grants: ALL_B, claims }))), `${type} ${op}`).toBe('auth.forbidden');
  });
  it('tenant B cannot read, update or deactivate a tenant A template: 404 common.not_found, row unchanged', { timeout: T }, async () => {
    const t = (await create(mk())).body;
    const b = staff('b');
    expect(errCode(await rejection(update(t.id, { name: 'hijack' }, '"1"', { claims: b })))).toBe('common.not_found');
    expect(errCode(await rejection(call('deactivateBroadcastTemplate', req({ params: { template_id: t.id }, headers: { ...idem(), 'if-match': '"1"' } }), { claims: b })))).toBe('common.not_found');
    const row = (await ownerRows('engagement.broadcast_template', 'id = $1', [t.id]))[0];
    expect(row).toMatchObject({ version: 1, is_active: true, tenant_id: TENANT_A });
    expect(row.name).toBe(t.name);
  });
  it('a handler never trusts a tenant id from the request body (create always stores the actor tenant)', { timeout: T }, async () => {
    const r = await create({ ...mk(), tenant_id: '01a1a98a-ac40-7000-8000-00000000b001' }, { claims: staff('a') });
    expect((await ownerRows('engagement.broadcast_template', 'id = $1', [r.body.id]))[0].tenant_id).toBe(TENANT_A);
  });
  it('no template body or name is written to a log line', { timeout: T }, async () => {
    const secret = `SYNTHETIC-BODY-${uid().slice(-8)}`;
    const r = await create(mk({ body: `${secret} for {{party_name}}` }));
    expect(r.probe.logs.join('\n')).not.toContain(secret);
  });
});
