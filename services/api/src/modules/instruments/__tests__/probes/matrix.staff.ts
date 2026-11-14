// C7 INT-T03 staff-operation probes (helper, not a test file): one probe per staff operationId (E10-E42 = 33 operations), run twice by probes.test.ts:
//   mode 'tenant' = S-01: the object belongs to TENANT B (and carries centre A1's id on purpose: a centre-only check would wave it through);
//   mode 'centre' = S-02: the object belongs to centre A2 of the SAME tenant, the caller holds centre A1 only (centre RLS hides it).
// Object-addressed operations -> 404 common.not_found BEFORE any permission check, nothing written, nothing audited, nothing leaked, every repo call carries the caller tenant.
// List operations -> own rows in the answer, foreign rows never. Create operations -> the foreign agent/centre is refused (404 / 400 /centre_id) or, for a centre named in the body, 403 without
// an existence probe. Tenant-level operations (settings, global reference data) -> only the caller's tenant data; a centre-only grant cannot use the tenant-level permission.
import { expect } from 'vitest';
import { agentRow, bundleRow, commandRow, idN, makeCtx as agentsCtx, makeRepo as makeAgentsRepo, transitionRow, CENTRE_A1, CENTRE_A2, TENANT_A, TENANT_B } from '../agents.helpers.js';
import { GOOD_CHECKLIST, INS, createBody, insRow, makeCtx as insCtx, makeRepo as makeInsRepo, obsRow, settingsRow } from '../instruments.helpers.js';
import { FROM, TO, detailRow, makeCtx as msgCtx, makeMessagesWorld, msgId, rejectionRow, recordRow as msgRecordRow, runRow } from '../messages.helpers.js';
import { makeRctx, makeReprocessWorld, msgRow, recId, recordRow } from '../reprocess.helpers.js';
import { attId, attachmentRow, makeAttachmentsWorld, makeStaffCtx, pdfBytes } from '../attachments.helpers.js';
import { allCentres, call, centreGrantsOnly, centreRls, dump, expectInvisible, expectRows, fails, ifMatch, leakFree, onlyCentre, onlyTenant, request, useRepos, type Mode, type Spy } from './harness.js';

const T = (m: Mode) => m === 'tenant';
const AGENT_OWN = idN(0x1000), AGENT_B = idN(0x1b00), AGENT_A2 = idN(0x1001);

// ====================================================================================================================== E10-E21 agents
function agentsSetup(m: Mode) {
  const ft = T(m) ? TENANT_B : TENANT_A, fc = T(m) ? CENTRE_A1 : CENTRE_A2, fid = T(m) ? AGENT_B : AGENT_A2;
  const own = agentRow({ id: AGENT_OWN, agent_code: 'HUB-A1' });
  const foreign = agentRow({ id: fid, tenant_id: ft, centre_id: fc, agent_code: T(m) ? 'HUB-B-SECRET' : 'HUB-A2-SECRET' });
  const fcmd = idN(0x8f01), fbundle = idN(0xbf01), fscope = { tenant_id: ft, centre_id: fc, agent_id: fid };
  const w = makeAgentsRepo({
    agents: [own, foreign],
    commands: [commandRow({ id: idN(0x8001), agent_id: own.id }), commandRow({ id: fcmd, ...fscope })],
    transitions: [transitionRow({ id: idN(0x9001), agent_id: own.id }), transitionRow({ id: idN(0x9f01), ...fscope })],
    bundles: [bundleRow({ id: idN(0xb001), agent_id: own.id }), bundleRow({ id: fbundle, ...fscope })],
  });
  useRepos({ agents: T(m) ? w.repo : centreRls(w.repo, [CENTRE_A1]) });
  const c = agentsCtx({ roles: T(m) ? allCentres : onlyCentre(CENTRE_A1) });
  const foreignIds = [fid, fcmd, fbundle, foreign.agent_code, ...(T(m) ? [TENANT_B] : [])];
  const spy: Spy = w;
  const inv = (op: string, req: ReturnType<typeof request>) => expectInvisible({ op, req, ctx: c.ctx, spy, asserted: () => c.asserted, access: () => c.accessRows(), foreign: foreignIds, tenant: TENANT_A });
  return { w, c, own, fid, fbundle, foreignIds, spy, inv };
}
const byAgent = (id: string) => request({ params: { agent_id: id } });

const agents: Record<string, (m: Mode) => Promise<void>> = {
  async listAgents(m) {                                                                                                     // E10
    const s = agentsSetup(m); const r = await call('listAgents', request(), s.c.ctx);
    expect(r.status).toBe(200); expectRows(r.body, [s.own.id], [s.fid]); leakFree(r.body, s.foreignIds); onlyTenant(s.spy, TENANT_A);
    if (!T(m)) {
      const e = await fails(call('listAgents', request({ query: { centre_id: CENTRE_A2 } }), s.c.ctx));
      expect(e.code).toBe('auth.forbidden'); expect(s.w.callsOf('listAgents')).toHaveLength(1);                            // the refused filter never reached the repo
    }
  },
  async createAgent(m) {                                                                                                    // E11
    const s = agentsSetup(m);
    const body = { agent_code: 'NEW-PC-01', display_name: 'New PC', centre_id: T(m) ? idN(0xcb1) : CENTRE_A2 };             // tenant: a centre of tenant B (invisible); centre: A2 (not granted)
    const e = await fails(call('createAgent', request({ body }), s.c.ctx));
    expect(e.code).toBe(T(m) ? 'common.validation_failed' : 'auth.forbidden');
    if (T(m)) expect(dump(e.errors)).toContain('/centre_id'); else expect(s.w.callsOf('getCentre'), 'no existence probe through 400 vs 403').toHaveLength(0);
    expect(s.spy.mutations()).toEqual([]); onlyTenant(s.spy, TENANT_A);
  },
  async getAgent(m) {                                                                                                       // E12
    const s = agentsSetup(m); await s.inv('getAgent', byAgent(s.fid));
    const ok = await call('getAgent', byAgent(s.own.id), s.c.ctx); expect(ok.status).toBe(200);                           // control: the same call on an own agent works
  },
  async updateAgent(m) { const s = agentsSetup(m); await s.inv('updateAgent', request({ params: { agent_id: s.fid }, headers: ifMatch(1), body: { display_name: 'Hijacked' } })); },   // E13
  async issueEnrolmentCode(m) { const s = agentsSetup(m); await s.inv('issueEnrolmentCode', byAgent(s.fid)); },            // E14
  async revokeAgent(m) { const s = agentsSetup(m); await s.inv('revokeAgent', request({ params: { agent_id: s.fid }, headers: ifMatch(1), body: { reason_code: 'other' } })); },   // E15
  async retireAgent(m) { const s = agentsSetup(m); await s.inv('retireAgent', request({ params: { agent_id: s.fid }, headers: ifMatch(1), body: { reason_code: 'other' } })); },   // E16
  async requestAgentCommand(m) { const s = agentsSetup(m); await s.inv('requestAgentCommand', request({ params: { agent_id: s.fid }, body: { kind: 'upload_logs' } })); },        // E17
  async listAgentCommands(m) { const s = agentsSetup(m); await s.inv('listAgentCommands', byAgent(s.fid)); },               // E18
  async listAgentHealthTransitions(m) { const s = agentsSetup(m); await s.inv('listAgentHealthTransitions', byAgent(s.fid)); },   // E19
  async getAgentLogBundle(m) {                                                                                              // E20
    const s = agentsSetup(m);
    await s.inv('getAgentLogBundle', request({ params: { agent_id: s.fid, bundle_id: s.fbundle } }));                       // foreign agent
    const e = await fails(call('getAgentLogBundle', request({ params: { agent_id: s.own.id, bundle_id: s.fbundle } }), s.c.ctx));   // own agent (visible, so assertRole runs) paired with a foreign bundle id
    expect(e.code).toBe('common.not_found'); leakFree(e, s.foreignIds); onlyTenant(s.spy, TENANT_A);
    const ok = await call('getAgentLogBundle', request({ params: { agent_id: s.own.id, bundle_id: idN(0xb001) } }), s.c.ctx); expect(ok.status).toBe(200);
  },
  async listAgentReleases(m) {                                                                                              // E21: global reference data
    const s = agentsSetup(m); const r = await call('listAgentReleases', request(), s.c.ctx);
    expect(r.status).toBe(200); leakFree(r.body, s.foreignIds); expect(s.w.callsOf('listReleases').every((x) => x.tenantId === undefined)).toBe(true);
  },
};

// ====================================================================================================================== E22-E32, E40-E41 instruments + settings
function insSetup(m: Mode, o: { ownSettings?: boolean } = {}) {
  const ft = T(m) ? TENANT_B : TENANT_A, fc = T(m) ? CENTRE_A1 : CENTRE_A2, fagent = T(m) ? AGENT_B : AGENT_A2;
  const own = insRow(1, { state: 'live' });
  const foreign = insRow(22, { tenant_id: ft, centre_id: fc, agent_id: fagent, state: 'live', instrument_code: T(m) ? 'SIM-B-SECRET' : 'SIM-A2-SECRET' });
  const w = makeInsRepo({
    instruments: [own, foreign],
    observed: [obsRow('GLU', { instrument_id: own.id }), obsRow('FOREIGN-CODE', { instrument_id: foreign.id, tenant_id: ft, centre_id: fc })],
    settings: [...(o.ownSettings === false ? [] : [settingsRow({ tenant_id: TENANT_A, default_backlog_threshold: 500 })]), settingsRow({ id: idN(0x5e02), tenant_id: TENANT_B, default_backlog_threshold: 7777 })],
  });
  useRepos({ instruments: T(m) ? w.repo : centreRls(w.repo, [CENTRE_A1]) });
  const c = insCtx({ roles: T(m) ? allCentres : onlyCentre(CENTRE_A1) });
  const foreignIds = [foreign.id, foreign.instrument_code, fagent, ...(T(m) ? [TENANT_B] : [])];
  const spy: Spy = w;
  const inv = (op: string, req: ReturnType<typeof request>) => expectInvisible({ op, req, ctx: c.ctx, spy, asserted: () => c.asserted, access: () => c.accessRows(), foreign: foreignIds, tenant: TENANT_A });
  return { w, c, own, foreign, foreignIds, spy, inv };
}
const byIns = (id: string, o: { headers?: object; body?: unknown; query?: object } = {}) => request({ params: { instrument_id: id }, ...o });
const EVIDENCE = 'Reference compared on three samples';

const instruments: Record<string, (m: Mode) => Promise<void>> = {
  async listDrivers(m) {                                                                                                    // E22: global reference data
    const s = insSetup(m); const r = await call('listDrivers', request(), s.c.ctx);
    expect(r.status).toBe(200); leakFree(r.body, s.foreignIds); expect(s.w.callsOf('listDrivers').every((x) => x.tenantId === undefined)).toBe(true);
  },
  async listInstruments(m) {                                                                                                // E23
    const s = insSetup(m); const r = await call('listInstruments', request(), s.c.ctx);
    expect(r.status).toBe(200); expectRows(r.body, [s.own.id], [s.foreign.id]); onlyTenant(s.spy, TENANT_A);
    const byFilter = await call('listInstruments', request({ query: { agent_id: s.foreign.agent_id } }), s.c.ctx);              // naming the foreign agent returns nothing, not an error
    expect(byFilter.body.data).toEqual([]);
    if (!T(m)) {
      const e = await fails(call('listInstruments', request({ query: { centre_id: CENTRE_A2 } }), s.c.ctx));
      expect(e.code).toBe('auth.forbidden');
    }
  },
  async createInstrument(m) {                                                                                               // E24: the agent of the body is foreign
    const s = insSetup(m); await s.inv('createInstrument', request({ body: createBody({ agent_id: s.foreign.agent_id }) }));
  },
  async getInstrument(m) {                                                                                                  // E25
    const s = insSetup(m); await s.inv('getInstrument', byIns(s.foreign.id));
    const ok = await call('getInstrument', byIns(s.own.id), s.c.ctx); expect(ok.status).toBe(200);
  },
  async updateInstrument(m) { const s = insSetup(m); await s.inv('updateInstrument', byIns(s.foreign.id, { headers: ifMatch(1), body: { display_name: 'Hijacked' } })); },                       // E26
  async startInstrumentCommissioning(m) { const s = insSetup(m); await s.inv('startInstrumentCommissioning', byIns(s.foreign.id, { headers: ifMatch(1), body: {} })); },                         // E27
  async goLiveInstrument(m) { const s = insSetup(m); await s.inv('goLiveInstrument', byIns(s.foreign.id, { headers: ifMatch(1), body: { checklist: GOOD_CHECKLIST, evidence_note: EVIDENCE } })); },  // E28
  async suspendInstrument(m) { const s = insSetup(m); await s.inv('suspendInstrument', byIns(s.foreign.id, { headers: ifMatch(1), body: { reason_text: 'maintenance window' } })); },              // E29
  async resumeInstrument(m) { const s = insSetup(m); await s.inv('resumeInstrument', byIns(s.foreign.id, { headers: ifMatch(1), body: {} })); },                                                  // E30
  async retireInstrument(m) { const s = insSetup(m); await s.inv('retireInstrument', byIns(s.foreign.id, { headers: ifMatch(1), body: { reason_text: 'decommissioned' } })); },                    // E31
  async listObservedInstrumentCodes(m) {                                                                                    // E32
    const s = insSetup(m); await s.inv('listObservedInstrumentCodes', byIns(s.foreign.id));
    const ok = await call('listObservedInstrumentCodes', byIns(s.own.id), s.c.ctx); expect(ok.status).toBe(200); leakFree(ok.body, ['FOREIGN-CODE']);
  },
  async getInstrumentSettings(m) {                                                                                          // E40: tenant-level
    if (T(m)) {
      const s = insSetup(m); const r = await call('getInstrumentSettings', request(), s.c.ctx);
      expect(r.status).toBe(200); expect(dump(r.body)).not.toContain('7777'); expect(s.w.callsOf('getSettings').map((x) => x.tenantId)).toEqual([TENANT_A]);
    } else {                                                                                                                // a centre-only grant is not the tenant-level permission, and a 403 writes nothing (not even the lazy default row)
      const s = insSetup(m, { ownSettings: false }); s.c.ctx.ports.IdentityPort.assertRole = async (_c: unknown, r: any) => centreGrantsOnly(r);
      const e = await fails(call('getInstrumentSettings', request(), s.c.ctx)); expect(e.code).toBe('auth.forbidden'); expect(s.spy.mutations()).toEqual([]);
    }
  },
  async updateInstrumentSettings(m) {                                                                                       // E41: tenant-level
    const body = { default_backlog_threshold: 600, backlog_max_oldest_pending_seconds: 900, clock_offset_warn_seconds: 300, agent_uploaded_retention_hours: 24 };
    const s = insSetup(m);
    if (T(m)) {
      const r = await call('updateInstrumentSettings', request({ headers: ifMatch(1), body }), s.c.ctx);
      expect(r.status).toBe(200); expect(s.w.settings.find((x) => x['tenant_id'] === TENANT_B)).toMatchObject({ default_backlog_threshold: 7777, version: 1 });   // B untouched
      expect(s.w.callsOf('updateSettings').map((x) => x.tenantId)).toEqual([TENANT_A]); onlyTenant(s.spy, TENANT_A);
    } else {
      s.c.ctx.ports.IdentityPort.assertRole = async (_c: unknown, r: any) => centreGrantsOnly(r);
      const e = await fails(call('updateInstrumentSettings', request({ headers: ifMatch(1), body }), s.c.ctx)); expect(e.code).toBe('auth.forbidden'); expect(s.spy.mutations()).toEqual([]);
    }
  },
};

// ====================================================================================================================== E33-E36, E42 messages (read), E38-E39 reprocess, E37 attachment download
function msgSetup(m: Mode) {
  const ft = T(m) ? TENANT_B : TENANT_A, fc = T(m) ? CENTRE_A1 : CENTRE_A2, fscope = { tenant_id: ft, centre_id: fc };
  const own = detailRow(1), foreign = detailRow(2, { ...fscope, instrument_id: INS(22), agent_id: T(m) ? AGENT_B : AGENT_A2, instrument_code: 'SIM-FOREIGN-SECRET' });
  const w = makeMessagesWorld({
    messages: [own, foreign], runs: [runRow(own.id, 1), runRow(foreign.id, 1, fscope)], records: [msgRecordRow(own.id, 1), msgRecordRow(foreign.id, 1, fscope)],
    rejections: [rejectionRow(1), rejectionRow(2, { ...fscope, agent_id: T(m) ? AGENT_B : AGENT_A2 })],
  });
  useRepos({ messages: T(m) ? w.repo : centreRls(w.repo, [CENTRE_A1]) });
  const c = msgCtx({ roles: T(m) ? allCentres : onlyCentre(CENTRE_A1) });
  const spy: Spy = { calls: w.calls, mutations: () => [] };                                                                  // the messages repo has no write method at all
  const foreignIds = [foreign.id, 'SIM-FOREIGN-SECRET', rejectionRow(2).id, ...(T(m) ? [TENANT_B] : [])];
  const inv = (op: string, req: ReturnType<typeof request>) => expectInvisible({ op, req, ctx: c.ctx, spy, asserted: () => c.asserted, access: () => c.accessRows(), foreign: foreignIds, tenant: TENANT_A });
  return { w, c, own, foreign, foreignIds, spy, inv };
}
const WINDOW = { received_at_from: FROM, received_at_to: TO };
const byMsg = (id: string, o: { query?: object } = {}) => request({ params: { instrument_message_id: id }, ...o });

const messages: Record<string, (m: Mode) => Promise<void>> = {
  async listInstrumentMessages(m) {                                                                                         // E33
    const s = msgSetup(m); const r = await call('listInstrumentMessages', request({ query: WINDOW }), s.c.ctx);
    expect(r.status).toBe(200); expectRows(r.body, [s.own.id], [s.foreign.id]); onlyTenant(s.spy, TENANT_A);
    if (!T(m)) { const e = await fails(call('listInstrumentMessages', request({ query: { ...WINDOW, centre_id: CENTRE_A2 } }), s.c.ctx)); expect(e.code).toBe('auth.forbidden'); expect(s.w.callsOf('listMessages')).toHaveLength(1); }
  },
  async searchInstrumentMessages(m) {                                                                                       // E34: same barcode planted on every message
    const s = msgSetup(m); const r = await call('searchInstrumentMessages', request({ body: { sample_barcode: 'E2600000042' } }), s.c.ctx);
    expect(r.status).toBe(200); expectRows(r.body, [s.own.id], [s.foreign.id]); onlyTenant(s.spy, TENANT_A);
  },
  async getInstrumentMessage(m) {                                                                                           // E35 (+ preview_parse must not parse a foreign raw)
    const s = msgSetup(m); await s.inv('getInstrumentMessage', byMsg(s.foreign.id)); await s.inv('getInstrumentMessage', byMsg(s.foreign.id, { query: { preview_parse: true } }));
    for (const op of ['getMessageRawBytes', 'listRuns', 'listRecords', 'findAttachmentByMessage']) expect(s.w.callsOf(op), `${op} after an invisible message`).toHaveLength(0);
    const ok = await call('getInstrumentMessage', byMsg(s.own.id), s.c.ctx); expect(ok.status).toBe(200);
  },
  async getInstrumentMessageRaw(m) {                                                                                        // E36
    const s = msgSetup(m); await s.inv('getInstrumentMessageRaw', byMsg(s.foreign.id));
    const ok = await call('getInstrumentMessageRaw', byMsg(s.own.id), s.c.ctx); expect(ok.status).toBe(200); expect(s.c.accessRows()).toHaveLength(1);   // control: an own raw view IS logged, the foreign one was not
  },
  async listMessageRejections(m) {                                                                                          // E42
    const s = msgSetup(m); const r = await call('listMessageRejections', request({ query: WINDOW }), s.c.ctx);
    expect(r.status).toBe(200); expectRows(r.body, [rejectionRow(1).id], [rejectionRow(2).id]); onlyTenant(s.spy, TENANT_A);
  },
};

function reproSetup(m: Mode) {
  const ft = T(m) ? TENANT_B : TENANT_A, fc = T(m) ? CENTRE_A1 : CENTRE_A2, fscope = { tenant_id: ft, centre_id: fc };
  const own = msgRow(1), foreign = msgRow(2, fscope), frec = recordRow(2, foreign.id, fscope);
  const w = makeReprocessWorld({ messages: [own, foreign], records: [recordRow(1, own.id), frec] });
  useRepos({ reprocess: T(m) ? w.repo : centreRls(w.repo, [CENTRE_A1]) });
  const c = makeRctx(w, { roles: T(m) ? allCentres : onlyCentre(CENTRE_A1) });
  const spy: Spy = { calls: w.calls, mutations: () => w.writes() };
  const foreignIds = [foreign.id, frec.id, ...(T(m) ? [TENANT_B] : [])];
  const inv = async (op: string, req: ReturnType<typeof request>) => {
    await expectInvisible({ op, req, ctx: c.ctx, spy, asserted: () => c.asserted, access: () => w.accessRows(), foreign: foreignIds, tenant: TENANT_A });
    expect(c.port.calls, 'C5 port never called').toEqual([]); expect(w.events, 'no event emitted').toEqual([]); expect(w.callsOf('getMessageRawBytes'), 'raw never read').toHaveLength(0);
  };
  return { w, c, foreign, frec, inv };
}
const reprocess: Record<string, (m: Mode) => Promise<void>> = {
  async reprocessInstrumentMessage(m) { const s = reproSetup(m); await s.inv('reprocessInstrumentMessage', request({ params: { instrument_message_id: s.foreign.id }, body: { reason_code: 'other' } })); },   // E38
  async rematchInstrumentRecord(m) { const s = reproSetup(m); await s.inv('rematchInstrumentRecord', request({ params: { record_id: s.frec.id }, body: { sample_barcode: 'E2600000099', reason_code: 'other' } })); },                // E39
};

const attachments: Record<string, (m: Mode) => Promise<void>> = {
  async downloadInstrumentAttachment(m) {                                                                                   // E37
    const ft = T(m) ? TENANT_B : TENANT_A, fc = T(m) ? CENTRE_A1 : CENTRE_A2, ownMsg = idN(0xf001), foreignMsg = idN(0xf0b1);
    const own = attachmentRow({ id: attId(1), message_id: ownMsg });
    const foreign = attachmentRow({ id: attId(2), message_id: foreignMsg, tenant_id: ft, centre_id: fc, object_path: `${ft}/2026/11/${attId(2)}.pdf` });
    const w = makeAttachmentsWorld({ attachments: [own, foreign] });
    useRepos({ attachments: T(m) ? w.repo : centreRls(w.repo, [CENTRE_A1]) });
    const s = makeStaffCtx(w); s.storage.seed(own['object_path'], pdfBytes()); s.storage.seed(foreign['object_path'], pdfBytes('foreign'));
    const spy: Spy = { calls: w.calls, mutations: () => w.calls.filter((x) => /^insert/.test(x.op)) };
    await expectInvisible({ op: 'downloadInstrumentAttachment', req: byMsg(foreignMsg), ctx: s.ctx, spy, asserted: () => s.roleCalls, access: () => w.accessRows, foreign: [foreignMsg, foreign['object_path'], attId(2)], tenant: TENANT_A });
    expect(s.storage.callsOf('read'), 'the foreign object was never read from Storage').toHaveLength(0);
    const ok = await call('downloadInstrumentAttachment', byMsg(ownMsg), s.ctx); expect(ok.status).toBe(200);              // control
  },
};

export const STAFF_PROBES: Record<string, (m: Mode) => Promise<void>> = { ...agents, ...instruments, ...messages, ...reprocess, ...attachments };
