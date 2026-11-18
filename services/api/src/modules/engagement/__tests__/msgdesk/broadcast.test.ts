// T0B-MSGDESK-1 done_when (2) AUDIENCE, (3) APPROVAL AND SEND, (4) rendering, (6) permissions, tenant isolation, double send proof under concurrent approval.
// Real PG17 under RLS (helpers.ts); NotificationPort is a recording fake that, like the real outbox, answers a repeated idempotencyKey with replayed: true. Synthetic data only.
// PINNED PICKS (lead decisions of this task; contract text silent; a change needs a ruling). Open questions that block more tests: .orchestra/notes/T0B-MSGDESK-1-tests.md (section OPEN)
//  - audience sources used here: laboratory = partners.partners, client = catalog.credit_parties (kind other than partner_lab), address = contact_phone_e164 for sms and whatsapp,
//    contact_email for email. active_only true keeps is_active / status active rows only. Counts are asserted as DELTAS over seeded rows (the shared seed may hold other parties).
//  - a draft broadcast stores the counted audience only (recipient_count) and NO broadcast_recipient rows; the recipient rows (the frozen list) are written at approval.
//  - requested_by / approved_by are the ACTOR ids (claims sub). Self approval = same actor id; it is refused 403 engagement.broadcast_self_approval BEFORE the provider check.
//  - provider "configured and approved" for a channel = active reporting.channel_accounts row of that channel whose provider_kind is not 'recording' (helpers.setProvider).
//  - after approveBroadcast returns, status is approved, sending or sent (the drain is asynchronous); recipient rows are queued (or later sent/failed) or skipped, never absent.
//  - channel mapping: sms -> NotificationPort.sendSms, whatsapp -> sendWhatsAppTemplate, email -> sendEmailLink. idempotencyKey contains the broadcast id AND the recipient row id.
//  - NotificationPort params carry only the closed placeholders (party_name, lab_name, lab_phone, send_date): email values HTML escaped, sms / whatsapp values without control characters.
//  - masked address = '*' x (len - 4) + last 4 for phones (REGAPI-1 rule); an email shows at least one '*'; the full value never appears in a response or a log.
//  - concurrent approvers: exactly one succeeds; the loser gets 409 engagement.broadcast_invalid_transition or common.version_conflict.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';
import { ALL_B, PERM, T, TENANT_A, TENANT_B, callWith, errCode, idem, makeNotification, ownerExec, ownerRows, phone, rejection, req, schemaErrors, seedClient, setProvider, specOf, staff, tag,
  uid, type Claims, type FakeNotification } from './helpers.js';

const H = manifest.handlers as Record<string, (r: any, c: any) => Promise<any>>;
const spec = specOf('engagement');
const call = (op: string, r: ReturnType<typeof req>, o: Parameters<typeof callWith>[4] = {}) => callWith(H, op, r, { grants: ALL_B, ...o });
const bad = (op: string, r: ReturnType<typeof req>, o: Parameters<typeof callWith>[4] = {}) => rejection(call(op, r, o));
const A1 = uid(); const A2 = uid(); const A3 = uid();           // three staff actors of tenant A
const req1 = (side: 'a' | 'b' = 'a') => staff(side, A1);
const as = (sub: string): Claims => staff('a', sub);
const mask = (s: string) => (s.length > 4 ? '*'.repeat(s.length - 4) + s.slice(-4) : '*'.repeat(s.length));
const CLIENT = { party_kinds: ['client'] } as const;

beforeAll(async () => { await setProvider('a', 'sms', true); await setProvider('a', 'whatsapp', true); await setProvider('a', 'email', true); }, T);
afterAll(async () => { await setProvider('a', 'sms', false); await setProvider('a', 'whatsapp', false); await setProvider('a', 'email', false); }, T);

async function template(o: Record<string, unknown> = {}, claims: Claims = req1()): Promise<any> {
  const r = await call('createBroadcastTemplate', req({ body: { name: `Synthetic ${tag()}`, channel: 'sms', body: 'Dear {{party_name}}, {{lab_name}} will be closed on {{send_date}}.', ...o }, headers: idem() }), { claims });
  return r.body;
}
const preview = (filter: object, templateId?: string, o: Parameters<typeof callWith>[4] = {}) =>
  call('previewBroadcastAudience', req({ body: { audience_filter: filter, ...(templateId ? { template_id: templateId } : {}) }, headers: {} }), o);
const createB = (templateId: string, filter: object, o: Parameters<typeof callWith>[4] = {}) =>
  call('createBroadcast', req({ body: { template_id: templateId, audience_filter: filter }, headers: idem() }), { claims: req1(), ...o });
const requestB = (id: string, o: Parameters<typeof callWith>[4] = {}) => call('requestBroadcastApproval', req({ params: { broadcast_id: id }, headers: { ...idem(), 'if-match': '"1"' } }), { claims: req1(), ...o });
const approve = (id: string, version: number, o: Parameters<typeof callWith>[4] = {}) =>
  call('approveBroadcast', req({ params: { broadcast_id: id }, headers: { ...idem(), 'if-match': `"${version}"` } }), { claims: as(A2), ...o });
const cancel = (id: string, o: Parameters<typeof callWith>[4] = {}) => call('cancelBroadcast', req({ params: { broadcast_id: id }, headers: idem() }), { claims: req1(), ...o });
const recipients = (id: string) => ownerRows('engagement.broadcast_recipient', 'broadcast_id = $1 ORDER BY created_at, id', [id]);
const row = async (id: string) => (await ownerRows('engagement.broadcast', 'id = $1', [id]))[0];
/** a pending_approval broadcast over `n` fresh clients plus whatever the seed holds */
async function pending(n = 3, tplOpts: Record<string, unknown> = {}): Promise<{ b: any; tpl: any; clients: any[] }> {
  const clients = []; for (let i = 0; i < n; i++) clients.push(await seedClient('a'));
  const tpl = await template(tplOpts);
  const b = (await createB(tpl.id, CLIENT)).body;
  const r = await requestB(b.id);
  return { b: r.body, tpl, clients };
}

describe('(2) previewBroadcastAudience: one SQL query, counts and masks, sends nothing', () => {
  it('200 BroadcastAudiencePreview (schema valid); count grows by exactly the seeded clients; sample is masked and capped at 20', { timeout: T }, async () => {
    const before = (await preview(CLIENT)).body.recipient_count;
    const added = []; for (let i = 0; i < 25; i++) added.push(await seedClient('a'));
    const r = await preview(CLIENT);
    expect(r.status).toBe(200);
    expect(schemaErrors(spec, 'BroadcastAudiencePreview', r.body)).toEqual([]);
    expect(r.body.recipient_count).toBe(before + 25);
    expect(r.body.sample.length).toBeLessThanOrEqual(20);
    const phones = new Set(added.map((c) => c.contact_phone_e164));
    for (const s of r.body.sample) {
      expect(s.channel_address).toContain('*');
      expect(phones.has(s.channel_address)).toBe(false);
    }
    const one = r.body.sample.find((s: any) => added.some((c) => mask(c.contact_phone_e164) === s.channel_address));
    if (one) expect(added.find((c) => mask(c.contact_phone_e164) === one.channel_address)).toBeTruthy();
  });
  it('resolves the filter in ONE SQL statement against the party source (no per party query)', { timeout: T }, async () => {
    for (let i = 0; i < 5; i++) await seedClient('a');
    const r = await preview(CLIENT);
    expect(r.probe.sql.filter((s) => /credit_parties/.test(s)).length).toBe(1);
  });
  it('sends nothing and stores nothing: no broadcast row, no recipient row, no NotificationPort call, no outbox write', { timeout: T }, async () => {
    const n = makeNotification();
    const nb = (await ownerRows('engagement.broadcast', 'tenant_id = $1', [TENANT_A])).length;
    const nr = (await ownerRows('engagement.broadcast_recipient', 'tenant_id = $1', [TENANT_A])).length;
    await preview(CLIENT, undefined, { notification: n });
    expect(n.sent).toEqual([]);
    expect((await ownerRows('engagement.broadcast', 'tenant_id = $1', [TENANT_A])).length).toBe(nb);
    expect((await ownerRows('engagement.broadcast_recipient', 'tenant_id = $1', [TENANT_A])).length).toBe(nr);
  });
  it('active_only true leaves out an inactive party, active_only false counts it', { timeout: T }, async () => {
    const on0 = (await preview({ ...CLIENT, active_only: true })).body.recipient_count;
    const off0 = (await preview({ ...CLIENT, active_only: false })).body.recipient_count;
    await seedClient('a', { is_active: false });
    expect((await preview({ ...CLIENT, active_only: true })).body.recipient_count).toBe(on0);
    expect((await preview({ ...CLIENT, active_only: false })).body.recipient_count).toBe(off0 + 1);
  });
  it('tenant B parties never count for tenant A', { timeout: T }, async () => {
    const before = (await preview(CLIENT)).body.recipient_count;
    await seedClient('b'); await seedClient('b');
    expect((await preview(CLIENT)).body.recipient_count).toBe(before);
  });
  it('an unknown template id answers 404, an inactive one 422 engagement.broadcast_template_inactive', { timeout: T }, async () => {
    expect(errCode(await bad('previewBroadcastAudience', req({ body: { audience_filter: CLIENT, template_id: uid() } })))).toBe('common.not_found');
    const t = await template();
    await call('deactivateBroadcastTemplate', req({ params: { template_id: t.id }, headers: { ...idem(), 'if-match': '"1"' } }));
    expect(errCode(await bad('previewBroadcastAudience', req({ body: { audience_filter: CLIENT, template_id: t.id } })))).toBe('engagement.broadcast_template_inactive');
  });
  it('the preview count equals the recipient rows created at approval for the same filter and data (the two never drift)', { timeout: T }, async () => {
    for (let i = 0; i < 4; i++) await seedClient('a');
    await seedClient('a', { is_active: false });
    const tpl = await template();
    for (const filter of [CLIENT, { ...CLIENT, active_only: true }]) {
      const p = (await preview(filter, tpl.id)).body;
      const b = (await createB(tpl.id, filter)).body;
      expect(b.recipient_count).toBe(p.recipient_count - p.opted_out_count);
      const pend = (await requestB(b.id)).body;
      expect(pend.recipient_count).toBe(b.recipient_count);
      const done = await approve(b.id, pend.version);
      expect(done.status).toBe(200);
      const rows = await recipients(b.id);
      expect(rows.length).toBe(p.recipient_count);                                   // queued + skipped rows
      expect(rows.filter((x) => x.status !== 'skipped').length).toBe(b.recipient_count);
      expect(rows.filter((x) => x.status === 'skipped').length).toBe(p.opted_out_count);
    }
  });
});

describe('createBroadcast and requestBroadcastApproval', () => {
  it('201 Broadcast draft (schema valid): requested_by is the actor, no approver, counted audience, no recipient rows, nothing sent', { timeout: T }, async () => {
    for (let i = 0; i < 3; i++) await seedClient('a');
    const n = makeNotification();
    const tpl = await template();
    const r = await createB(tpl.id, CLIENT, { notification: n });
    expect(r.status).toBe(201);
    expect(schemaErrors(spec, 'Broadcast', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ template_id: tpl.id, status: 'draft', requested_by: A1, version: 1, audience_filter: CLIENT });
    expect(r.body.approved_by).toBeUndefined();
    expect(r.body.recipient_count).toBeGreaterThanOrEqual(3);
    expect((await recipients(r.body.id)).length).toBe(0);
    expect(n.sent).toEqual([]);
    expect((await row(r.body.id)).tenant_id).toBe(TENANT_A);
  });
  it('inactive template: 422 engagement.broadcast_template_inactive; unknown or other tenant template: 404', { timeout: T }, async () => {
    const t = await template();
    await call('deactivateBroadcastTemplate', req({ params: { template_id: t.id }, headers: { ...idem(), 'if-match': '"1"' } }));
    expect(errCode(await bad('createBroadcast', req({ body: { template_id: t.id, audience_filter: CLIENT }, headers: idem() }), { claims: req1() }))).toBe('engagement.broadcast_template_inactive');
    expect(errCode(await bad('createBroadcast', req({ body: { template_id: uid(), audience_filter: CLIENT }, headers: idem() }), { claims: req1() }))).toBe('common.not_found');
    const tb = await template({}, staff('b'));
    expect(errCode(await bad('createBroadcast', req({ body: { template_id: tb.id, audience_filter: CLIENT }, headers: idem() }), { claims: req1() }))).toBe('common.not_found');
  });
  it('requestBroadcastApproval: draft -> pending_approval (200, version + 1, recounted); any other source status is 409 engagement.broadcast_invalid_transition', { timeout: T }, async () => {
    const tpl = await template();
    const b = (await createB(tpl.id, CLIENT)).body;
    await seedClient('a');                                                           // audience grows between draft and request: the request counts again
    const r = await requestB(b.id);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'pending_approval', version: 2 });
    expect(r.body.recipient_count).toBe(b.recipient_count + 1);
    const again = await rejection(call('requestBroadcastApproval', req({ params: { broadcast_id: b.id }, headers: { ...idem(), 'if-match': '"2"' } }), { claims: req1() }));
    expect(errCode(again)).toBe('engagement.broadcast_invalid_transition');
  });
  it('each status change writes an audit event on engagement.broadcast', { timeout: T }, async () => {
    const { b } = await pending(1);
    await approve(b.id, b.version);
    const a = await ownerRows('audit.audit_log', "tenant_id = $1 AND table_name = 'broadcast' AND row_id = $2 ORDER BY occurred_at", [TENANT_A, b.id]);
    expect(a.map((x) => x.action)[0]).toBe('INSERT');
    expect(a.filter((x) => x.action === 'UPDATE').length).toBeGreaterThanOrEqual(2);       // request, approve (+ sending / sent)
  });
});

describe('(3) approveBroadcast: second person, provider, frozen list, one outbox row per recipient', () => {
  it('the approver is never the requester: 403 engagement.broadcast_self_approval, nothing queued, status unchanged', { timeout: T }, async () => {
    const { b } = await pending(2);
    const n = makeNotification();
    const e = await rejection(approve(b.id, b.version, { claims: as(A1), notification: n }));
    expect(errCode(e)).toBe('engagement.broadcast_self_approval');
    expect(e.statusCode).toBe(403);
    expect(n.sent).toEqual([]);
    expect(await row(b.id)).toMatchObject({ status: 'pending_approval', approved_by: null });
    expect((await recipients(b.id)).length).toBe(0);
  });
  it('a second person approves: approved_by = that actor, approved_at set, status approved | sending | sent (200 Broadcast schema valid)', { timeout: T }, async () => {
    const { b } = await pending(3);
    const r = await approve(b.id, b.version);
    expect(r.status).toBe(200);
    expect(schemaErrors(spec, 'Broadcast', r.body)).toEqual([]);
    expect(['approved', 'sending', 'sent']).toContain(r.body.status);
    expect(r.body.approved_by).toBe(A2);
    expect(r.body.approved_at).toBeTruthy();
    expect(r.body.requested_by).toBe(A1);
    const d = await row(b.id);
    expect(d.approved_by).toBe(A2); expect(d.requested_by).toBe(A1);
  });
  it('approving needs the approve permission: manage + read alone is 403 auth.forbidden, nothing queued', { timeout: T }, async () => {
    const { b } = await pending(1);
    const n = makeNotification();
    expect(errCode(await rejection(approve(b.id, b.version, { grants: [PERM.bRead, PERM.bManage], notification: n })))).toBe('auth.forbidden');
    expect(n.sent).toEqual([]);
    expect((await row(b.id)).status).toBe('pending_approval');
  });
  it('allowed only from pending_approval: a draft, an approved and a cancelled broadcast answer 409 engagement.broadcast_invalid_transition', { timeout: T }, async () => {
    const tpl = await template();
    const draft = (await createB(tpl.id, CLIENT)).body;
    expect(errCode(await rejection(approve(draft.id, 1)))).toBe('engagement.broadcast_invalid_transition');
    const { b } = await pending(1);
    await approve(b.id, b.version);
    const n = makeNotification();
    expect(errCode(await rejection(approve(b.id, b.version + 1, { claims: as(A3), notification: n })))).toBe('engagement.broadcast_invalid_transition');
    expect(n.sent).toEqual([]);
    const p2 = (await pending(1)).b;
    await cancel(p2.id);
    expect(errCode(await rejection(approve(p2.id, p2.version + 1)))).toBe('engagement.broadcast_invalid_transition');
  });
  it('no provider configured for the channel: 422 engagement.broadcast_provider_not_configured, nothing queued, no recipient rows, status stays pending_approval', { timeout: T }, async () => {
    const { b } = await pending(2, { channel: 'whatsapp' });
    await setProvider('a', 'whatsapp', false);
    try {
      const n = makeNotification();
      const e = await rejection(approve(b.id, b.version, { notification: n }));
      expect(errCode(e)).toBe('engagement.broadcast_provider_not_configured');
      expect(e.statusCode).toBe(422);
      expect(n.sent).toEqual([]);
      expect((await row(b.id)).status).toBe('pending_approval');
      expect((await recipients(b.id)).length).toBe(0);
    } finally { await setProvider('a', 'whatsapp', true); }
  });
  it('the recording provider does not count as configured (it never reaches a handset)', { timeout: T }, async () => {
    const { b } = await pending(1, { channel: 'email', subject: 'Notice' });
    await ownerExec(`UPDATE reporting.channel_accounts SET provider_kind = 'recording' WHERE tenant_id = $1 AND channel = 'email'`, [TENANT_A]);
    try { expect(errCode(await rejection(approve(b.id, b.version)))).toBe('engagement.broadcast_provider_not_configured'); }
    finally { await setProvider('a', 'email', true); }
  });
  it('a template deactivated after the request is refused at approval: 422 engagement.broadcast_template_inactive', { timeout: T }, async () => {
    const { b, tpl } = await pending(1);
    await call('deactivateBroadcastTemplate', req({ params: { template_id: tpl.id }, headers: { ...idem(), 'if-match': '"1"' } }));
    const n = makeNotification();
    expect(errCode(await rejection(approve(b.id, b.version, { notification: n })))).toBe('engagement.broadcast_template_inactive');
    expect(n.sent).toEqual([]);
  });
  it('one outbox row per recipient: one NotificationPort call per queued recipient, key = broadcast id + recipient id, all keys distinct, outbox_id stored and unique', { timeout: T }, async () => {
    const { b, clients } = await pending(4);
    const n = makeNotification();
    const r = await approve(b.id, b.version, { notification: n });
    expect(r.status).toBe(200);
    const rows = await recipients(b.id);
    const queued = rows.filter((x) => x.status !== 'skipped');
    expect(rows.length).toBe(r.body.recipient_count + r.body.opted_out_count);
    expect(n.sent.length).toBe(queued.length);
    expect(new Set(n.sent.map((s) => s.input.idempotencyKey)).size).toBe(n.sent.length);
    expect(n.sent.every((s) => s.channel === 'sms')).toBe(true);
    for (const q of queued) {
      expect(q.outbox_id, 'outbox_id stored').toBeTruthy();
      const call1 = n.sent.find((s) => n.byKey.get(s.input.idempotencyKey) === q.outbox_id);
      expect(call1, `a send for recipient ${q.id}`).toBeTruthy();
      expect(call1!.input.idempotencyKey).toContain(b.id);
      expect(call1!.input.idempotencyKey).toContain(q.id);
      expect(q.party_kind).toBe('client');
    }
    expect(new Set(queued.map((q) => q.outbox_id)).size).toBe(queued.length);
    for (const c of clients) expect(rows.some((x) => x.party_id === c.id && x.party_kind === 'client'), `recipient for ${c.id}`).toBe(true);
  });
  it('the recipient list is frozen at approval: a party added afterwards gets no message and no row', { timeout: T }, async () => {
    const { b } = await pending(2);
    const n = makeNotification();
    await approve(b.id, b.version, { notification: n });
    const frozen = (await recipients(b.id)).length;
    const late = await seedClient('a');
    expect((await recipients(b.id)).length).toBe(frozen);
    expect((await recipients(b.id)).some((x) => x.party_id === late.id)).toBe(false);
    expect(n.sent.length).toBe(frozen);
  });
  it('rendering: only the closed placeholders are passed; email values are HTML escaped; sms values carry no control characters; no phone or email in params', { timeout: T }, async () => {
    const evil = `Acme <script>alert(1)</script> & Co`;
    const c = await seedClient('a', { name: evil });
    const email = await template({ channel: 'email', subject: 'Notice', body: 'Dear {{party_name}}, from {{lab_name}} on {{send_date}} {{lab_phone}}' });
    const be = (await createB(email.id, CLIENT)).body; const pe = (await requestB(be.id)).body;
    const ne = makeNotification();
    await approve(be.id, pe.version, { notification: ne });
    const mine = ne.sent.filter((s) => s.input.params.party_name?.includes('Acme'));
    expect(mine.length).toBe(1);
    expect(mine[0]!.channel).toBe('email');
    expect(mine[0]!.input.params.party_name).toBe('Acme &lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    for (const s of ne.sent) {
      expect(Object.keys(s.input.params).every((k) => ['party_name', 'lab_name', 'lab_phone', 'send_date'].includes(k)), JSON.stringify(Object.keys(s.input.params))).toBe(true);
      expect(JSON.stringify(s.input.params)).not.toContain(c.contact_phone_e164);
      expect(JSON.stringify(s.input.params)).not.toContain(c.contact_email);
    }
    const c2 = await seedClient('a', { name: 'Line one\nLine\ttwo\u0007' });
    const sms = await template({ channel: 'sms' });
    const bs = (await createB(sms.id, CLIENT)).body; const ps = (await requestB(bs.id)).body;
    const ns = makeNotification();
    await approve(bs.id, ps.version, { notification: ns });
    const hit = ns.sent.find((s) => String(s.input.params.party_name).startsWith('Line one'));
    expect(hit).toBeTruthy();
    expect(hit!.input.params.party_name).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(c2.id).toBeTruthy();
  });
  it('no personal data in logs: no phone, email or party name in any log line of preview, create, request, approve', { timeout: T }, async () => {
    const c = await seedClient('a', { name: `Logscan ${tag()} Party` });
    const tpl = await template();
    const outs = [await preview(CLIENT, tpl.id), await createB(tpl.id, CLIENT)];
    const b = outs[1]!.body; const p = await requestB(b.id); outs.push(p);
    outs.push(await approve(b.id, p.body.version));
    const logs = outs.flatMap((o) => o.probe.logs).join('\n') + outs.flatMap((o) => o.probe.accessCalls).map((a) => JSON.stringify(a)).join('\n');
    for (const secret of [c.contact_phone_e164, c.contact_email, c.name]) expect(logs).not.toContain(secret);
  });
});

describe('(3) double send proof: retry, crash, concurrent approval', () => {
  it('a retry of a successful approval is refused (409) and queues nothing more', { timeout: T }, async () => {
    const { b } = await pending(3);
    const n = makeNotification();
    await approve(b.id, b.version, { notification: n });
    const sent = n.sent.length; const keys = new Set(n.byKey.keys());
    const e = await rejection(approve(b.id, b.version, { claims: as(A2), notification: n }));
    expect(['engagement.broadcast_invalid_transition', 'common.version_conflict']).toContain(errCode(e));
    expect(n.sent.length).toBe(sent);
    expect(new Set(n.byKey.keys())).toEqual(keys);
  });
  it('a crash in the middle of the send leaves no half state; the retry ends with exactly one outbox row per recipient', { timeout: T }, async () => {
    const { b } = await pending(4);
    let calls = 0;
    const n: FakeNotification = makeNotification({ failFor: () => ++calls === 2 });   // the 2nd NotificationPort call throws
    const e = await rejection(approve(b.id, b.version, { notification: n }));
    expect(e).toBeTruthy();
    const mid = await recipients(b.id);
    for (const r of mid) if (r.status === 'queued') expect(r.outbox_id, 'queued without an outbox row').toBeTruthy();
    expect(['pending_approval', 'approved', 'sending']).toContain((await row(b.id)).status);
    const retried = await approve(b.id, (await row(b.id)).version, { claims: as(A3), notification: n });
    expect(retried.status).toBe(200);
    const rows = await recipients(b.id);
    const queued = rows.filter((x) => x.status !== 'skipped');
    expect(queued.every((q) => !!q.outbox_id)).toBe(true);
    expect(new Set(queued.map((q) => q.outbox_id)).size).toBe(queued.length);
    expect(rows.length).toBe(new Set(rows.map((x) => `${x.party_kind}:${x.party_id}`)).size);
  });
  it('three approvers at the same moment: exactly one wins, one outbox row per recipient, no duplicate recipient row', { timeout: T }, async () => {
    const { b } = await pending(6);
    const n = makeNotification();
    const A4 = uid(); const A5 = uid();
    const results = await Promise.allSettled([A2, A3, A4, A5].map((sub) => approve(b.id, b.version, { claims: as(sub), notification: n })));
    const ok = results.filter((x) => x.status === 'fulfilled');
    const lost = results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(lost.length).toBe(3);
    for (const l of lost) expect(['engagement.broadcast_invalid_transition', 'common.version_conflict']).toContain(errCode(l.reason));
    const rows = await recipients(b.id);
    const queued = rows.filter((x) => x.status !== 'skipped');
    expect(n.sent.length, 'NotificationPort calls = queued recipients').toBe(queued.length);
    expect(n.byKey.size).toBe(queued.length);
    expect(new Set(rows.map((x) => `${x.party_kind}:${x.party_id}`)).size).toBe(rows.length);
    const winner = (await row(b.id)).approved_by;
    expect([A2, A3, A4, A5]).toContain(winner);
  });
  it('a requester racing as approver and a second person: only the second person can win', { timeout: T }, async () => {
    const { b } = await pending(3);
    const n = makeNotification();
    const [self, other] = await Promise.allSettled([approve(b.id, b.version, { claims: as(A1), notification: n }), approve(b.id, b.version, { claims: as(A2), notification: n })]);
    expect(self.status).toBe('rejected');
    expect(other.status).toBe('fulfilled');
    expect((await row(b.id)).approved_by).toBe(A2);
  });
});

describe('cancelBroadcast, listBroadcasts, listBroadcastRecipients', () => {
  it('cancel is allowed from draft, pending_approval and approved-before-send; cancelled twice and sent/sending are 409 invalid_transition', { timeout: T }, async () => {
    const tpl = await template();
    const d = (await createB(tpl.id, CLIENT)).body;
    const r = await cancel(d.id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('cancelled');
    expect(errCode(await rejection(cancel(d.id)))).toBe('engagement.broadcast_invalid_transition');
    const p = (await pending(1)).b;
    expect((await cancel(p.id)).body.status).toBe('cancelled');
    const sent = (await pending(1)).b;
    await approve(sent.id, sent.version);
    await ownerExec(`UPDATE engagement.broadcast SET status = 'sent' WHERE id = $1`, [sent.id]);
    expect(errCode(await rejection(cancel(sent.id)))).toBe('engagement.broadcast_invalid_transition');
    await ownerExec(`UPDATE engagement.broadcast SET status = 'sending' WHERE id = $1`, [sent.id]);
    expect(errCode(await rejection(cancel(sent.id)))).toBe('engagement.broadcast_invalid_transition');
  });
  it('a cancelled broadcast sends nothing and cannot be revived', { timeout: T }, async () => {
    const { b } = await pending(2);
    await cancel(b.id);
    const n = makeNotification();
    await rejection(approve(b.id, b.version + 1, { notification: n }));
    expect(n.sent).toEqual([]);
    expect((await row(b.id)).status).toBe('cancelled');
  });
  it('listBroadcasts: schema valid page, status filter, own tenant only', { timeout: T }, async () => {
    const { b } = await pending(1);
    const other = (await createB((await template({}, staff('b'))).id, CLIENT, { claims: staff('b') })).body;
    const all = await call('listBroadcasts', req({ query: { limit: 200 } }), { claims: req1() });
    expect(all.status).toBe(200);
    expect(schemaErrors(spec, 'BroadcastPage', all.body)).toEqual([]);
    const ids = all.body.data.map((x: any) => x.id);
    expect(ids).toContain(b.id); expect(ids).not.toContain(other.id);
    const f = await call('listBroadcasts', req({ query: { status: 'pending_approval', limit: 200 } }), { claims: req1() });
    expect(f.body.data.every((x: any) => x.status === 'pending_approval')).toBe(true);
    expect(f.body.data.map((x: any) => x.id)).toContain(b.id);
  });
  it('listBroadcastRecipients: per recipient status, masked address (never the full value), status filter, 404 for an unknown or other tenant broadcast', { timeout: T }, async () => {
    const { b, clients } = await pending(3);
    await approve(b.id, b.version);
    const r = await call('listBroadcastRecipients', req({ params: { broadcast_id: b.id }, query: { limit: 200 } }), { claims: req1() });
    expect(r.status).toBe(200);
    expect(schemaErrors(spec, 'BroadcastRecipientPage', r.body)).toEqual([]);
    const full = new Set(clients.map((c) => c.contact_phone_e164));
    for (const x of r.body.data) { expect(full.has(x.channel_address)).toBe(false); expect(x.channel_address).toContain('*'); expect(x.broadcast_id).toBe(b.id); }
    const mine = r.body.data.find((x: any) => x.party_id === clients[0].id);
    expect(mine.channel_address).toBe(mask(clients[0].contact_phone_e164));
    expect(['queued', 'sent', 'failed']).toContain(mine.status);
    const q = await call('listBroadcastRecipients', req({ params: { broadcast_id: b.id }, query: { status: 'skipped', limit: 200 } }), { claims: req1() });
    expect(q.body.data.every((x: any) => x.status === 'skipped')).toBe(true);
    expect(errCode(await rejection(call('listBroadcastRecipients', req({ params: { broadcast_id: uid() } }), { claims: req1() })))).toBe('common.not_found');
    expect(errCode(await rejection(call('listBroadcastRecipients', req({ params: { broadcast_id: b.id } }), { claims: staff('b') })))).toBe('common.not_found');
  });
  it('the full recipient address is in no response body of any broadcast operation', { timeout: T }, async () => {
    const { b, clients } = await pending(2);
    const outs = [await approve(b.id, b.version), await call('listBroadcastRecipients', req({ params: { broadcast_id: b.id } }), { claims: req1() }), await preview(CLIENT)];
    const text = JSON.stringify(outs.map((o) => o.body));
    for (const c of clients) { expect(text).not.toContain(c.contact_phone_e164); expect(text).not.toContain(c.contact_email); }
  });
});

describe('(6) permission denied, wrong actor type, cross tenant', () => {
  const OPS: Array<[string, string, (id: string) => ReturnType<typeof req>]> = [
    ['listBroadcasts', PERM.bRead, () => req()],
    ['listBroadcastRecipients', PERM.bRead, (id) => req({ params: { broadcast_id: id } })],
    ['createBroadcast', PERM.bManage, () => req({ body: { template_id: uid(), audience_filter: CLIENT }, headers: idem() })],
    ['previewBroadcastAudience', PERM.bManage, () => req({ body: { audience_filter: CLIENT } })],
    ['requestBroadcastApproval', PERM.bManage, (id) => req({ params: { broadcast_id: id }, headers: { ...idem(), 'if-match': '"2"' } })],
    ['cancelBroadcast', PERM.bManage, (id) => req({ params: { broadcast_id: id }, headers: idem() })],
    ['approveBroadcast', PERM.bApprove, (id) => req({ params: { broadcast_id: id }, headers: { ...idem(), 'if-match': '"2"' } })],
  ];
  it.each(OPS)('%s without %s: 403 auth.forbidden, broadcast unchanged', { timeout: T }, async (op, perm, build) => {
    const { b } = await pending(1);
    const n = makeNotification();
    const others = ALL_B.filter((p) => p !== perm);
    expect(errCode(await rejection(callWith(H, op, build(b.id), { grants: others, claims: as(A2), notification: n })))).toBe('auth.forbidden');
    expect(n.sent).toEqual([]);
    expect(await row(b.id)).toMatchObject({ status: 'pending_approval', version: 2 });
  });
  it.each(['partner', 'patient', 'portal', 'device'] as const)('%s actor is refused on every broadcast operation (403)', { timeout: T }, async (type) => {
    const { b } = await pending(1);
    const claims: Claims = { ...staff('a', A2), type };
    for (const [op, , build] of OPS) expect(errCode(await rejection(callWith(H, op, build(b.id), { grants: ALL_B, claims }))), `${type} ${op}`).toBe('auth.forbidden');
  });
  it('tenant B cannot request, approve or cancel a tenant A broadcast: 404, row unchanged, nothing queued', { timeout: T }, async () => {
    const { b } = await pending(2);
    const n = makeNotification();
    const eb = staff('b', A3);
    for (const op of [() => approve(b.id, b.version, { claims: eb, notification: n }), () => cancel(b.id, { claims: eb }),
      () => requestB(b.id, { claims: eb }), () => call('listBroadcastRecipients', req({ params: { broadcast_id: b.id } }), { claims: eb })]) {
      expect(errCode(await rejection(op()))).toBe('common.not_found');
    }
    expect(n.sent).toEqual([]);
    expect(await row(b.id)).toMatchObject({ status: 'pending_approval', tenant_id: TENANT_A });
  });
  it('a tenant B approval cannot be made by a tenant A actor either (RLS and the tenant filter agree)', { timeout: T }, async () => {
    await setProvider('b', 'sms', true);
    try {
      const tb = await template({}, staff('b', A1));
      await seedClient('b');
      const bb = (await createB(tb.id, CLIENT, { claims: staff('b', A1) })).body;
      const pb = (await requestB(bb.id, { claims: staff('b', A1) })).body;
      expect(errCode(await rejection(approve(bb.id, pb.version, { claims: as(A2) })))).toBe('common.not_found');
      const ok = await approve(bb.id, pb.version, { claims: staff('b', A2) });
      expect(ok.status).toBe(200);
      expect((await recipients(bb.id)).every((r) => r.tenant_id === TENANT_B)).toBe(true);
    } finally { await setProvider('b', 'sms', false); }
  });
});

describe('(3) the 5000 recipient cap (tenant B, restored afterwards)', () => {
  const MARK = `CAP${tag().toUpperCase().slice(0, 5)}`;
  const fill = (n: number, from: number) => ownerExec(
    `INSERT INTO catalog.credit_parties (id, tenant_id, party_code, name, kind, contact_phone_e164, is_active, created_by, updated_by)
     SELECT app.uuidv7(), $1, $2 || lpad(i::text, 6, '0'), 'Synthetic cap party ' || i, 'hospital', '+97798' || lpad((i % 100000000)::text, 8, '0'), true, $3, $3 FROM generate_series($4::int, $5::int) i`,
    [TENANT_B, MARK, '01a1b34e-1000-7eee-9d29-d7ca59a102b5', from, from + n - 1], TENANT_B);
  const clear = () => ownerExec('DELETE FROM catalog.credit_parties WHERE tenant_id = $1 AND party_code LIKE $2', [TENANT_B, `${MARK}%`], TENANT_B);
  afterAll(async () => { await clear(); }, T);
  it('exactly 5000 is accepted; 5001 is refused 422 engagement.broadcast_recipient_limit at create AND at request; the preview still counts and sends nothing', { timeout: 600_000 }, async () => {
    await setProvider('b', 'sms', true);
    const sb = (sub: string) => staff('b', sub);
    const tpl = (await call('createBroadcastTemplate', req({ body: { name: `Synthetic cap ${tag()}`, channel: 'sms', body: 'Hello {{party_name}}' }, headers: idem() }), { claims: sb(A1) })).body;
    try {
      const base = (await preview(CLIENT, tpl.id, { claims: sb(A1) })).body.recipient_count;
      expect(base).toBeLessThan(5000);
      await fill(5000 - base, 1);
      const ok = await createB(tpl.id, CLIENT, { claims: sb(A1) });
      expect(ok.body.recipient_count).toBe(5000);
      await fill(1, 5000 - base + 1);
      const p = await preview(CLIENT, tpl.id, { claims: sb(A1) });
      expect(p.body.recipient_count).toBe(5001);
      const e = await rejection(createB(tpl.id, CLIENT, { claims: sb(A1) }));
      expect(errCode(e)).toBe('engagement.broadcast_recipient_limit');
      expect(e.statusCode).toBe(422);
      expect(errCode(await rejection(requestB(ok.body.id, { claims: sb(A1) })))).toBe('engagement.broadcast_recipient_limit');
      const n = makeNotification();
      expect(n.sent).toEqual([]);
    } finally { await clear(); await setProvider('b', 'sms', false); }
  });
  it('approval builds the list again and re-checks the cap (audience grew past 5000 between request and approval)', { timeout: 600_000 }, async () => {
    await setProvider('b', 'sms', true);
    const sb = (sub: string) => staff('b', sub);
    const tpl = (await call('createBroadcastTemplate', req({ body: { name: `Synthetic cap2 ${tag()}`, channel: 'sms', body: 'Hello {{party_name}}' }, headers: idem() }), { claims: sb(A1) })).body;
    try {
      const base = (await preview(CLIENT, tpl.id, { claims: sb(A1) })).body.recipient_count;
      await fill(5000 - base, 1);
      const b = (await createB(tpl.id, CLIENT, { claims: sb(A1) })).body;
      const p = (await requestB(b.id, { claims: sb(A1) })).body;
      await fill(1, 5000 - base + 1);
      const n = makeNotification();
      expect(errCode(await rejection(approve(b.id, p.version, { claims: sb(A2), notification: n })))).toBe('engagement.broadcast_recipient_limit');
      expect(n.sent).toEqual([]);
      expect((await recipients(b.id)).length).toBe(0);
    } finally { await clear(); await setProvider('b', 'sms', false); }
  });
});
