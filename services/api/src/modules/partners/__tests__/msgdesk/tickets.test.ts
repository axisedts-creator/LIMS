// T0B-MSGDESK-1 done_when (5) TICKETS + (6): partner message-to-lab tickets (contracts/openapi/partners.yaml, T0C-MSGDESK-1).
// Real PG17 under RLS; handlers are manifest.handlers of the partners module driven with a staff (user) or partner actor context. Synthetic data only.
// RULES under test: transitions new -> replied | closed, replied -> replied | closed, closed -> new by reopen ONLY; a partner user sees and writes only the own party tickets;
// every message and every status change writes an audit event (audit.audit_log row on partners.partner_ticket: create = INSERT, message / status change = UPDATE of last_message_at / status).
// PINNED PICKS (lead decisions of this task; a change needs a ruling):
//  - lab reply: new -> replied, replied -> replied. partner reply: replied -> new, new -> new (the lab has to look again). A closed ticket takes no reply from either side:
//    409 partners.ticket_invalid_transition. closing a closed ticket and reopening a non closed ticket: 409 partners.ticket_invalid_transition.
//  - close and reopen need If-Match "<version>" (missing = 428 common.precondition_required, stale = 409 common.version_conflict); a status change bumps version.
//  - a partner cannot close or reopen (there is no /me operation for it) and the lab cannot post as partner: sender_kind is derived from the actor, never from the body.
//  - /v1/partners/admin/* = actor type user (staff) only; /v1/partners/me/* = actor type partner only; everything else, and a missing permission, answers 403 auth.forbidden
//    before any lookup. Another party's ticket and another tenant's ticket answer 404 common.not_found (same as an unknown id).
//  - the party of a partner side ticket comes from the session (app.current_partner_id()); a party_id / party_kind / sender_kind in the body is ignored.
import { describe, expect, it } from 'vitest';
import { manifest } from '../../index.js';
import { ALL_T, PERM, T, TENANT_A, callWith, errCode, idem, ownerRows, partnerActor, rejection, req, schemaErrors, seedPartner, specOf, staff, uid, type Claims } from '../../../engagement/__tests__/msgdesk/helpers.js';

const H = manifest.handlers as Record<string, (r: any, c: any) => Promise<any>>;
const spec = specOf('partners');
const lab = (side: 'a' | 'b' = 'a'): Claims => staff(side);
const asLab = (op: string, r: ReturnType<typeof req>, o: Parameters<typeof callWith>[4] = {}) => callWith(H, op, r, { grants: ALL_T, claims: lab(), ...o });
const asPartner = (p: { userId: string; membershipId: string }, op: string, r: ReturnType<typeof req>, o: Parameters<typeof callWith>[4] = {}) =>
  callWith(H, op, r, { grants: ALL_T, claims: partnerActor(p), ...o });
const bad = (p: Promise<unknown>) => rejection(p);
const ticketRow = async (id: string) => (await ownerRows('partners.partner_ticket', 'id = $1', [id]))[0];
const messages = (id: string) => ownerRows('partners.partner_ticket_message', 'ticket_id = $1 ORDER BY created_at, id', [id]);
const auditRows = (id: string) => ownerRows('audit.audit_log', "tenant_id = $1 AND table_name = 'partner_ticket' AND row_id = $2 ORDER BY occurred_at, id", [TENANT_A, id]);
const ifm = async (id: string) => ({ 'if-match': `"${(await ticketRow(id)).version}"` });
const labOpen = (partnerId: string, o: Record<string, unknown> = {}, c: Claims = lab()) =>
  asLab('createPartnerTicket', req({ body: { party_kind: 'partner', party_id: partnerId, subject: `Synthetic subject ${uid().slice(-6)}`, body: 'Lab opens this ticket.', ...o }, headers: idem() }), { claims: c });
const partnerOpen = (p: { userId: string; membershipId: string }, o: Record<string, unknown> = {}) =>
  asPartner(p, 'createMyPartnerTicket', req({ body: { subject: `Synthetic subject ${uid().slice(-6)}`, body: 'Partner asks something.', ...o }, headers: idem() }));
const labReply = (id: string, body = 'Lab answer.', c: Claims = lab()) => asLab('replyPartnerTicket', req({ params: { ticket_id: id }, body: { body }, headers: idem() }), { claims: c });
const partnerReply = (p: { userId: string; membershipId: string }, id: string, body = 'Partner answer.') =>
  asPartner(p, 'replyMyPartnerTicket', req({ params: { ticket_id: id }, body: { body }, headers: idem() }));
const close = async (id: string, c: Claims = lab()) => asLab('closePartnerTicket', req({ params: { ticket_id: id }, headers: { ...idem(), ...(await ifm(id)) } }), { claims: c });
const reopen = async (id: string, c: Claims = lab()) => asLab('reopenPartnerTicket', req({ params: { ticket_id: id }, headers: { ...idem(), ...(await ifm(id)) } }), { claims: c });
const TRANS = 'partners.ticket_invalid_transition';

describe('(5) lab side: open, reply, close, reopen', () => {
  it('createPartnerTicket: 201 PartnerTicket (schema valid), status new, first message from the lab, created_by = actor, one audit INSERT', { timeout: T }, async () => {
    const p = await seedPartner();
    const c = lab();
    const r = await labOpen(p.partnerId, { subject: 'Report delay (SYNTHETIC)', body: 'Please check sample 12.' }, c);
    expect(r.status).toBe(201);
    expect(schemaErrors(spec, 'PartnerTicket', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ party_kind: 'partner', party_id: p.partnerId, subject: 'Report delay (SYNTHETIC)', status: 'new', created_by: c.sub, version: 1 });
    const m = await messages(r.body.id);
    expect(m.length).toBe(1);
    expect(m[0]).toMatchObject({ sender_kind: 'lab', body: 'Please check sample 12.', created_by: c.sub, tenant_id: TENANT_A });
    expect((await auditRows(r.body.id)).map((a) => a.action)).toEqual(['INSERT']);
  });
  it('an unknown partner or a partner of another tenant answers 404 and creates nothing', { timeout: T }, async () => {
    const before = (await ownerRows('partners.partner_ticket', 'tenant_id = $1', [TENANT_A])).length;
    expect(errCode(await bad(labOpen(uid())))).toBe('common.not_found');
    const p = await seedPartner();
    expect(errCode(await bad(labOpen(p.partnerId, {}, lab('b'))))).toBe('common.not_found');
    expect((await ownerRows('partners.partner_ticket', 'tenant_id = $1', [TENANT_A])).length).toBe(before);
  });
  it('lab reply: new -> replied, replied -> replied; sender_kind is lab whatever the body says; each reply is one appended message and one audit UPDATE', { timeout: T }, async () => {
    const p = await seedPartner();
    const t = (await labOpen(p.partnerId)).body;
    const a0 = (await auditRows(t.id)).length;
    const r1 = await asLab('replyPartnerTicket', req({ params: { ticket_id: t.id }, body: { body: 'First answer', sender_kind: 'partner' }, headers: idem() }));
    expect(r1.status).toBe(201);
    expect(schemaErrors(spec, 'PartnerTicketMessage', r1.body)).toEqual([]);
    expect(r1.body).toMatchObject({ ticket_id: t.id, sender_kind: 'lab', body: 'First answer' });
    expect((await ticketRow(t.id)).status).toBe('replied');
    await labReply(t.id, 'Second answer');
    expect((await ticketRow(t.id)).status).toBe('replied');
    expect((await messages(t.id)).map((m) => [m.sender_kind, m.body])).toEqual([['lab', 'Lab opens this ticket.'], ['lab', 'First answer'], ['lab', 'Second answer']]);
    expect((await auditRows(t.id)).length).toBeGreaterThanOrEqual(a0 + 2);
    expect((await ticketRow(t.id)).last_message_at).toBeTruthy();
  });
  it('close: new or replied -> closed (200, version + 1, audit UPDATE); closing a closed ticket is 409 partners.ticket_invalid_transition', { timeout: T }, async () => {
    const p = await seedPartner();
    const t = (await labOpen(p.partnerId)).body;
    const v = (await ticketRow(t.id)).version;
    const c1 = await close(t.id);
    expect(c1.status).toBe(200);
    expect(schemaErrors(spec, 'PartnerTicket', c1.body)).toEqual([]);
    expect(c1.body).toMatchObject({ status: 'closed', version: v + 1 });
    expect((await auditRows(t.id)).some((a) => a.action === 'UPDATE' && a.changed_columns.includes('status'))).toBe(true);
    const e = await bad(close(t.id));
    expect(errCode(e)).toBe(TRANS); expect(e.statusCode).toBe(409);
    const t2 = (await labOpen(p.partnerId)).body;
    await labReply(t2.id);
    expect((await close(t2.id)).body.status).toBe('closed');
  });
  it('a closed ticket takes no reply from the lab; reopen it first', { timeout: T }, async () => {
    const p = await seedPartner();
    const t = (await labOpen(p.partnerId)).body;
    await close(t.id);
    const n = (await messages(t.id)).length;
    expect(errCode(await bad(labReply(t.id)))).toBe(TRANS);
    expect((await messages(t.id)).length).toBe(n);
  });
  it('reopen: closed -> new only; reopening a new or replied ticket is 409; a reopened ticket takes replies again', { timeout: T }, async () => {
    const p = await seedPartner();
    const t = (await labOpen(p.partnerId)).body;
    expect(errCode(await bad(reopen(t.id)))).toBe(TRANS);
    await labReply(t.id);
    expect(errCode(await bad(reopen(t.id)))).toBe(TRANS);
    await close(t.id);
    const r = await reopen(t.id);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('new');
    expect((await labReply(t.id)).status).toBe(201);
    expect((await ticketRow(t.id)).status).toBe('replied');
  });
  it('close and reopen need If-Match: missing = 428 common.precondition_required, stale = 409 common.version_conflict, ticket unchanged', { timeout: T }, async () => {
    const p = await seedPartner();
    const t = (await labOpen(p.partnerId)).body;
    expect(errCode(await bad(asLab('closePartnerTicket', req({ params: { ticket_id: t.id }, headers: idem() }))))).toBe('common.precondition_required');
    expect(errCode(await bad(asLab('closePartnerTicket', req({ params: { ticket_id: t.id }, headers: { ...idem(), 'if-match': '"999"' } }))))).toBe('common.version_conflict');
    expect((await ticketRow(t.id)).status).toBe('new');
  });
  it('two lab users closing at the same moment: exactly one wins, the other gets 409, one status audit UPDATE', { timeout: T }, async () => {
    const p = await seedPartner();
    const t = (await labOpen(p.partnerId)).body;
    const h = await ifm(t.id);
    const go = (c: Claims) => asLab('closePartnerTicket', req({ params: { ticket_id: t.id }, headers: { ...idem(), ...h } }), { claims: c });
    const res = await Promise.allSettled([go(lab()), go(lab())]);
    expect(res.filter((x) => x.status === 'fulfilled').length).toBe(1);
    const lost = res.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect([TRANS, 'common.version_conflict']).toContain(errCode(lost.reason));
    expect((await auditRows(t.id)).filter((a) => a.action === 'UPDATE' && a.changed_columns.includes('status')).length).toBe(1);
  });
  it('getPartnerTicket: PartnerTicketDetail schema valid, messages oldest first; unknown id 404', { timeout: T }, async () => {
    const p = await seedPartner({ withUser: true });
    const t = (await labOpen(p.partnerId, { body: 'one' })).body;
    await labReply(t.id, 'two'); await partnerReply(p, t.id, 'three');
    const r = await asLab('getPartnerTicket', req({ params: { ticket_id: t.id } }));
    expect(r.status).toBe(200);
    expect(schemaErrors(spec, 'PartnerTicketDetail', r.body)).toEqual([]);
    expect(r.body.messages.map((m: any) => m.body)).toEqual(['one', 'two', 'three']);
    expect(r.body.messages.map((m: any) => m.sender_kind)).toEqual(['lab', 'lab', 'partner']);
    expect(errCode(await bad(asLab('getPartnerTicket', req({ params: { ticket_id: uid() } }))))).toBe('common.not_found');
  });
  it('listPartnerTickets: schema valid page, filters status / party_id / created_from / created_to, newest message first, own tenant only', { timeout: T }, async () => {
    const p1 = await seedPartner(); const p2 = await seedPartner();
    const a = (await labOpen(p1.partnerId)).body; const b = (await labOpen(p2.partnerId)).body;
    await labReply(a.id); await labReply(b.id);                                       // b answered last: newest message first puts b before a
    await close(a.id);
    const other = await seedPartner();
    const l = await asLab('listPartnerTickets', req({ query: { limit: 200 } }));
    expect(l.status).toBe(200);
    expect(schemaErrors(spec, 'PartnerTicketPage', l.body)).toEqual([]);
    const ids: string[] = l.body.data.map((x: any) => x.id);
    expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(a.id));
    const fs = await asLab('listPartnerTickets', req({ query: { status: 'closed', party_id: p1.partnerId } }));
    expect(fs.body.data.map((x: any) => x.id)).toEqual([a.id]);
    const fp = await asLab('listPartnerTickets', req({ query: { party_id: p2.partnerId, party_kind: 'partner' } }));
    expect(fp.body.data.map((x: any) => x.id)).toEqual([b.id]);
    const day = new Date().toISOString().slice(0, 10);
    const fd = await asLab('listPartnerTickets', req({ query: { party_id: p2.partnerId, created_from: '2000-01-01', created_to: '2099-12-31' } }));
    expect(fd.body.data.map((x: any) => x.id)).toEqual([b.id]);
    const none = await asLab('listPartnerTickets', req({ query: { party_id: p2.partnerId, created_to: '2000-01-01' } }));
    expect(none.body.data).toEqual([]);
    expect(day).toBeTruthy(); expect(other.partnerId).toBeTruthy();
    const tb = await asLab('listPartnerTickets', req({ query: { limit: 200 } }), { claims: lab('b') });
    expect(tb.body.data.map((x: any) => x.id)).not.toContain(a.id);
  });
});

describe('(5) partner side: only the own party', () => {
  it('createMyPartnerTicket: 201, party from the session (body party ignored), status new, first message sender partner, audit INSERT', { timeout: T }, async () => {
    const p = await seedPartner({ withUser: true }); const other = await seedPartner();
    const r = await partnerOpen(p, { party_id: other.partnerId, party_kind: 'partner', sender_kind: 'lab', status: 'closed' });
    expect(r.status).toBe(201);
    expect(schemaErrors(spec, 'PartnerTicket', r.body)).toEqual([]);
    expect(r.body).toMatchObject({ party_id: p.partnerId, status: 'new', created_by: p.userId });
    const m = await messages(r.body.id);
    expect(m.map((x) => x.sender_kind)).toEqual(['partner']);
    expect((await auditRows(r.body.id)).map((a) => a.action)).toEqual(['INSERT']);
  });
  it('partner reply: replied -> new, new -> new, appended as sender partner; a closed ticket takes no reply (409); the partner cannot close or reopen', { timeout: T }, async () => {
    const p = await seedPartner({ withUser: true });
    const t = (await partnerOpen(p)).body;
    await labReply(t.id);
    expect((await ticketRow(t.id)).status).toBe('replied');
    const r = await partnerReply(p, t.id, 'Thanks, one more thing');
    expect(r.status).toBe(201);
    expect(schemaErrors(spec, 'PartnerTicketMessage', r.body)).toEqual([]);
    expect(r.body.sender_kind).toBe('partner');
    expect((await ticketRow(t.id)).status).toBe('new');
    await partnerReply(p, t.id, 'Still waiting');
    expect((await ticketRow(t.id)).status).toBe('new');
    await close(t.id);
    expect(errCode(await bad(partnerReply(p, t.id)))).toBe(TRANS);
    for (const op of ['closePartnerTicket', 'reopenPartnerTicket']) {
      expect(errCode(await bad(asPartner(p, op, req({ params: { ticket_id: t.id }, headers: { ...idem(), 'if-match': '"1"' } }))))).toBe('auth.forbidden');
    }
    expect((await ticketRow(t.id)).status).toBe('closed');
  });
  it('every partner message writes an audit UPDATE on the ticket (message count and audit trail agree)', { timeout: T }, async () => {
    const p = await seedPartner({ withUser: true });
    const t = (await partnerOpen(p)).body;
    await labReply(t.id); await partnerReply(p, t.id); await labReply(t.id);
    const msgs = (await messages(t.id)).length;
    expect(msgs).toBe(4);
    expect((await auditRows(t.id)).length).toBeGreaterThanOrEqual(1 + (msgs - 1));      // INSERT + one UPDATE per message after the first
  });
  it('listMyPartnerTickets / getMyPartnerTicket / replyMyPartnerTicket: partner 1 never sees or writes partner 2 tickets (404, nothing written)', { timeout: T }, async () => {
    const p1 = await seedPartner({ withUser: true }); const p2 = await seedPartner({ withUser: true });
    const t1 = (await partnerOpen(p1)).body; const t2 = (await partnerOpen(p2)).body;
    const l1 = await asPartner(p1, 'listMyPartnerTickets', req({ query: { limit: 200 } }));
    expect(l1.status).toBe(200);
    expect(schemaErrors(spec, 'PartnerTicketPage', l1.body)).toEqual([]);
    expect(l1.body.data.map((x: any) => x.id)).toContain(t1.id);
    expect(l1.body.data.map((x: any) => x.id)).not.toContain(t2.id);
    expect(l1.body.data.every((x: any) => x.party_id === p1.partnerId)).toBe(true);
    expect(errCode(await bad(asPartner(p1, 'getMyPartnerTicket', req({ params: { ticket_id: t2.id } }))))).toBe('common.not_found');
    const n = (await messages(t2.id)).length;
    expect(errCode(await bad(partnerReply(p1, t2.id, 'intrusion')))).toBe('common.not_found');
    expect((await messages(t2.id)).length).toBe(n);
    const d = await asPartner(p1, 'getMyPartnerTicket', req({ params: { ticket_id: t1.id } }));
    expect(schemaErrors(spec, 'PartnerTicketDetail', d.body)).toEqual([]);
    expect(d.body.ticket.id).toBe(t1.id);
  });
  it('a partner list filter cannot widen the scope: party_id of another partner in the query returns nothing of theirs', { timeout: T }, async () => {
    const p1 = await seedPartner({ withUser: true }); const p2 = await seedPartner({ withUser: true });
    const t2 = (await partnerOpen(p2)).body;
    const r = await asPartner(p1, 'listMyPartnerTickets', req({ query: { party_id: p2.partnerId, limit: 200 } })).catch((e) => ({ body: { data: [] as any[] }, e }));
    expect(r.body.data.map((x: any) => x.id)).not.toContain(t2.id);
  });
  it('no message body or subject is written to a log line, on either side', { timeout: T }, async () => {
    const p = await seedPartner({ withUser: true });
    const secret = `SYN-SECRET-${uid().slice(-8)}`;
    const subj = `SYN-SUBJECT-${uid().slice(-8)}`;
    const a = await partnerOpen(p, { subject: subj, body: `B ${secret}` });
    const b = await labReply(a.body.id, `R ${secret}`);
    const c = await partnerReply(p, a.body.id, `P ${secret}`);
    for (const o of [a, b, c]) {
      for (const s of [secret, subj]) { expect(o.probe.logs.join('\n')).not.toContain(s); expect(JSON.stringify(o.probe.accessCalls)).not.toContain(s); }
    }
    const audits = (await auditRows(a.body.id)).map((x) => JSON.stringify([x.old_values, x.new_values])).join('\n');
    expect(audits).not.toContain(secret);                                              // message bodies never reach the row audit of the ticket
  });
});

describe('(6) permission denied, wrong actor type, cross tenant', () => {
  const LAB_OPS: Array<[string, string, (id: string, p: string) => ReturnType<typeof req>]> = [
    ['listPartnerTickets', PERM.tRead, () => req()],
    ['getPartnerTicket', PERM.tRead, (id) => req({ params: { ticket_id: id } })],
    ['createPartnerTicket', PERM.tManage, (_i, p) => req({ body: { party_kind: 'partner', party_id: p, subject: 's', body: 'b' }, headers: idem() })],
    ['replyPartnerTicket', PERM.tManage, (id) => req({ params: { ticket_id: id }, body: { body: 'x' }, headers: idem() })],
    ['closePartnerTicket', PERM.tManage, (id) => req({ params: { ticket_id: id }, headers: { ...idem(), 'if-match': '"1"' } })],
    ['reopenPartnerTicket', PERM.tManage, (id) => req({ params: { ticket_id: id }, headers: { ...idem(), 'if-match': '"1"' } })],
  ];
  const ME_OPS: Array<[string, string, (id: string) => ReturnType<typeof req>]> = [
    ['listMyPartnerTickets', PERM.tRead, () => req()],
    ['getMyPartnerTicket', PERM.tRead, (id) => req({ params: { ticket_id: id } })],
    ['createMyPartnerTicket', PERM.tManage, () => req({ body: { subject: 's', body: 'b' }, headers: idem() })],
    ['replyMyPartnerTicket', PERM.tManage, (id) => req({ params: { ticket_id: id }, body: { body: 'x' }, headers: idem() })],
  ];
  it.each(LAB_OPS)('lab op %s without %s: 403 auth.forbidden, ticket unchanged', { timeout: T }, async (op, perm, build) => {
    const p = await seedPartner(); const t = (await labOpen(p.partnerId)).body;
    const e = await bad(callWith(H, op, build(t.id, p.partnerId), { grants: ALL_T.filter((x) => x !== perm), claims: lab() }));
    expect(errCode(e)).toBe('auth.forbidden');
    expect(await ticketRow(t.id)).toMatchObject({ status: 'new', version: 1 });
    expect((await messages(t.id)).length).toBe(1);
  });
  it.each(ME_OPS)('partner op %s without %s: 403 auth.forbidden, ticket unchanged', { timeout: T }, async (op, perm, build) => {
    const p = await seedPartner({ withUser: true }); const t = (await partnerOpen(p)).body;
    expect(errCode(await bad(callWith(H, op, build(t.id), { grants: ALL_T.filter((x) => x !== perm), claims: partnerActor(p) })))).toBe('auth.forbidden');
    expect((await messages(t.id)).length).toBe(1);
  });
  it.each(['partner', 'patient', 'portal', 'device'] as const)('%s actor on a /admin ticket operation: 403 before any lookup', { timeout: T }, async (type) => {
    const p = await seedPartner({ withUser: true }); const t = (await labOpen(p.partnerId)).body;
    const claims: Claims = type === 'partner' ? partnerActor(p) : { ...lab(), type };
    for (const [op, , build] of LAB_OPS) expect(errCode(await bad(callWith(H, op, build(t.id, p.partnerId), { grants: ALL_T, claims }))), `${type} ${op}`).toBe('auth.forbidden');
    expect(await ticketRow(t.id)).toMatchObject({ status: 'new', version: 1 });
  });
  it.each(['user', 'system', 'patient', 'portal', 'device'] as const)('%s actor on a /me ticket operation: 403 (partner actors only)', { timeout: T }, async (type) => {
    const p = await seedPartner({ withUser: true }); const t = (await partnerOpen(p)).body;
    const claims: Claims = { ...lab(), type };
    for (const [op, , build] of ME_OPS) expect(errCode(await bad(callWith(H, op, build(t.id), { grants: ALL_T, claims }))), `${type} ${op}`).toBe('auth.forbidden');
    expect((await messages(t.id)).length).toBe(1);
  });
  it('tenant B staff cannot read, reply, close or reopen a tenant A ticket: 404, nothing changes', { timeout: T }, async () => {
    const p = await seedPartner(); const t = (await labOpen(p.partnerId)).body;
    const b = lab('b');
    for (const [op, , build] of LAB_OPS.filter(([o]) => o !== 'listPartnerTickets' && o !== 'createPartnerTicket')) {
      expect(errCode(await bad(callWith(H, op, build(t.id, p.partnerId), { grants: ALL_T, claims: b }))), op).toBe('common.not_found');
    }
    expect(await ticketRow(t.id)).toMatchObject({ status: 'new', version: 1, tenant_id: TENANT_A });
    expect((await messages(t.id)).length).toBe(1);
  });
});
