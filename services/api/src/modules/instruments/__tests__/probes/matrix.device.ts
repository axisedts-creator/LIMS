// C7 INT-T03 device-operation probes (helper, not a test file): one probe per device operationId (E01-E08 = 8 operations), plus the credential-kind probes (S-05).
// A device never names a tenant or a centre: its token fixes the agent, the DB (device RLS, `app.current_centre_ids()`) fixes the centre. So the probes pin two things:
//   (1) ids the device DOES send (command_id, release_id, instrument_id, the enrolment code it presents) never reach another tenant's / another centre's / another agent's object;
//   (2) E04/E05/E06: an instrument of another tenant or another centre is invisible -> `instruments.instrument_unknown`; an instrument of the SAME centre bound to another agent ->
//       `instruments.device_mismatch`; the refusal stores nothing but a `message_rejections` row in the DEVICE's centre (E04/E05, AB1/AB2/AB2a), and E06 stores nothing at all.
// mode 'tenant' = S-01 (foreign object belongs to tenant B, centre A1's id on purpose); mode 'centre' = S-02 (foreign object is centre A2 / another agent of the SAME tenant).
import { expect } from 'vitest';
import { hqBody, hqSetup } from '../hostQuery.helpers.js';
import { INS, batch, makeIngestCtx, makeWorld, message } from '../ingest.helpers.js';
import { metadata, makeAttachmentsWorld, makeDeviceCtx as attachmentsDeviceCtx, pdfBytes } from '../attachments.helpers.js';
import {
  AGENT_B, AGENT_X, AGENT_Z, CENTRE_A1, CENTRE_A2, CODE_ID, FINGERPRINT, OLD_TOKEN_ID, TENANT_A, TENANT_B, activeAgent, agentRow, bundleBody, cmd, configRow, credRow, enrolCtx, heartbeatBody,
  idN, makeDeviceCtx, makeRepo as makeDeviceRepo, releaseRow, type Row,
} from '../device.helpers.js';
import { call, fails, leakFree, onlyTenant, request, useRepos, type Mode } from './harness.js';

const T = (m: Mode) => m === 'tenant';
const UNKNOWN = 'instruments.instrument_unknown', MISMATCH = 'instruments.device_mismatch', INVALID = 'auth.device_token_invalid';

// ====================================================================================================================== E01-E03, E07-E08 (agent-keyed)
function devSetup(m: Mode) {
  const ft = T(m) ? TENANT_B : TENANT_A, fc = T(m) ? CENTRE_A1 : CENTRE_A2, fid = T(m) ? AGENT_B : AGENT_Z, fscope = { tenant_id: ft, centre_id: fc };
  const FCODE = idN(0x6f01), FTOKEN = idN(0x6f02), R_OWN = idN(0x7001), R_FOREIGN = idN(0x7002), F_CMD = idN(0x8f02);
  const pending = (id: string, code: string, o: Row = {}) => agentRow({ id, status: 'pending_enrolment', health: null, enrolled_at: null, ...o,
    credentials: [credRow({ id: code, kind: 'enrolment_code', expires_at: '2026-11-08T08:00:00.000Z', agent_id: id, ...(o['tenant_id'] ? { tenant_id: o['tenant_id'], centre_id: o['centre_id'] } : {}) })] });
  const w = makeDeviceRepo({
    agents: [
      activeAgent(), pending(idN(0x1100), CODE_ID),                                                                          // own active agent; a second own agent (A1) that is still pending with its enrolment code
      activeAgent({ id: fid, agent_code: 'HUB-FOREIGN', ...fscope, credentials: [credRow({ id: FTOKEN, kind: 'device_token', agent_id: fid, ...fscope })] }),
      pending(idN(0x1f00), FCODE, { ...fscope }),                                                                            // a pending FOREIGN agent holding an enrolment code
    ],
    configs: [configRow(AGENT_X, CENTRE_A1, 1, { targetReleaseId: R_OWN }), configRow(fid, fc, 9, { tenant: ft, targetReleaseId: R_FOREIGN })],
    commands: [cmd(1), cmd(2, { id: F_CMD, agent_id: fid, ...fscope })],
    releases: [releaseRow({ id: R_OWN }), releaseRow({ id: R_FOREIGN, version: '1.3.0' })],
  });
  useRepos({ device: w.repo });
  const foreignIds = [fid, F_CMD, 'HUB-FOREIGN', R_FOREIGN, ...(T(m) ? [TENANT_B] : [])];
  return { w, fid, ft, fc, FCODE, F_CMD, R_FOREIGN, foreignIds, spy: w };
}
const bodyE01 = { host_fingerprint_sha256: FINGERPRINT, agent_version: '1.2.3', launcher_version: '1.0.0', os_version: 'Windows 11 24H2' };
const noWrites = (s: ReturnType<typeof devSetup>) => expect(s.w.mutations(), 'nothing written').toEqual([]);

const agentKeyed: Record<string, (m: Mode) => Promise<void>> = {
  async enrolAgent(m) {                                                                                                     // E01: an enrolment code is redeemable only by the agent it was issued for
    const s = devSetup(m); const before = JSON.stringify(s.w.agents);
    const c = enrolCtx({ agentId: idN(0x1100), credentialId: s.FCODE });                                                    // own pending agent presents a FOREIGN agent's code
    const e = await fails(call('enrolAgent', request({ body: bodyE01 }), c.ctx)); expect(e.code).toBe(INVALID);
    noWrites(s); expect(c.accessRows(), 'no credential issue logged').toEqual([]); expect(JSON.stringify(s.w.agents), 'no agent, code or token changed').toBe(before);
    if (T(m)) {                                                                                                              // a tenant-A ctx naming tenant B's pending agent + its code
      const x = enrolCtx({ agentId: idN(0x1f00), credentialId: s.FCODE }); const e2 = await fails(call('enrolAgent', request({ body: bodyE01 }), x.ctx));
      expect(e2.code).toBe(INVALID); noWrites(s); expect(JSON.stringify(s.w.agents)).toBe(before);
    }
    onlyTenant(s.spy, TENANT_A); leakFree(e, s.foreignIds);
  },
  async getAgentConfig(m) {                                                                                                 // E02
    const s = devSetup(m); const c = makeDeviceCtx({ agentId: AGENT_X, credentialId: OLD_TOKEN_ID });
    const r = await call('getAgentConfig', request(), c.ctx);
    expect(r.status).toBe(200); expect(r.body.document).toMatchObject({ agent_id: AGENT_X, config_version: 1 }); leakFree(r.body, s.foreignIds); onlyTenant(s.spy, TENANT_A);
    await invisibleAgent(m, 'getAgentConfig', request());
  },
  async submitAgentHeartbeat(m) {                                                                                           // E03: commands of another agent are never delivered
    const s = devSetup(m); const c = makeDeviceCtx({ agentId: AGENT_X, credentialId: OLD_TOKEN_ID });
    const foreignBefore = JSON.stringify([s.w.agent(s.fid), s.w.commands.find((x) => x['id'] === s.F_CMD)]);
    const r = await call('submitAgentHeartbeat', request({ body: heartbeatBody() }), c.ctx);
    expect(r.status).toBe(200); expect(r.body.commands.map((x: Row) => x['command_id'] ?? x['id'])).toEqual([idN(0x8001)]); leakFree(r.body, s.foreignIds);
    expect(JSON.stringify([s.w.agent(s.fid), s.w.commands.find((x) => x['id'] === s.F_CMD)]), 'foreign agent status and command untouched').toBe(foreignBefore);
    for (const x of s.w.calls.filter((y) => /^(record|claim)/.test(y.op))) expect(JSON.stringify(x.args)).toContain(AGENT_X);
    onlyTenant(s.spy, TENANT_A); await invisibleAgent(m, 'submitAgentHeartbeat', request({ body: heartbeatBody() }));
  },
  async submitAgentLogBundle(m) {                                                                                           // E07: a command of another agent -> 404, nothing stored, command untouched
    const s = devSetup(m); const c = makeDeviceCtx({ agentId: AGENT_X, credentialId: OLD_TOKEN_ID }); const before = JSON.stringify(s.w.commands);
    const e = await fails(call('submitAgentLogBundle', request({ body: bundleBody(s.F_CMD) }), c.ctx));
    expect(e.code).toBe('common.not_found'); expect(s.w.bundles).toEqual([]); expect(s.w.callsOf('insertLogBundle')).toEqual([]); expect(s.w.callsOf('completeCommand')).toEqual([]);
    expect(JSON.stringify(s.w.commands)).toBe(before); leakFree(e, s.foreignIds); onlyTenant(s.spy, TENANT_A); await invisibleAgent(m, 'submitAgentLogBundle', request({ body: bundleBody(idN(0x8001)) }));
  },
  async downloadAgentRelease(m) {                                                                                           // E08: a release that is another agent's target is not this agent's
    const s = devSetup(m); const c = makeDeviceCtx({ agentId: AGENT_X, credentialId: OLD_TOKEN_ID });
    const e = await fails(call('downloadAgentRelease', request({ params: { release_id: s.R_FOREIGN } }), c.ctx));
    expect(e.code).toBe('common.not_found'); leakFree(e, [s.fid, ...(T(m) ? [TENANT_B] : [])]); onlyTenant(s.spy, TENANT_A);
    await invisibleAgent(m, 'downloadAgentRelease', request({ params: { release_id: idN(0x7001) } }));
  },
};
/** tenant mode: a token whose agent is not visible in the caller's tenant (agent of tenant B under a tenant-A ctx) is refused 401 before anything else. */
async function invisibleAgent(m: Mode, op: string, req: ReturnType<typeof request>) {
  if (!T(m)) return;
  const s = devSetup(m); const c = makeDeviceCtx({ agentId: AGENT_B, credentialId: idN(0x6f02) });
  const e = await fails(call(op, req, c.ctx)); expect(e.code, `${op} with a foreign agent's identity`).toBe(INVALID); expect(s.w.mutations()).toEqual([]);
}

// ====================================================================================================================== E04-E06 (instrument-keyed)
const rejectedFor = (m: Mode) => (T(m) ? INS(8) : INS(3));                                                                  // tenant B instrument | centre A2 instrument: both invisible to the A1 device
const batchIngest = async (m: Mode) => {                                                                                    // E04
  const w = makeWorld(); useRepos({ ingest: w.repo }); const c = makeIngestCtx(w); const spy = { calls: w.calls };
  let n = 1;
  const probe = async (instrument: string, code: string) => {
    const msg = message({ n: n++, instrument }); const r = await call('submitMessageBatch', request({ body: batch([msg]) }), c.ctx);
    expect(r.status).toBe(200); expect(r.body.results).toEqual([{ agent_message_id: msg['agent_message_id'], outcome: 'rejected', error_code: code }]);
    expect(w.rejections.at(-1)).toMatchObject({ tenant_id: TENANT_A, centre_id: CENTRE_A1, agent_id: w.deviceAgent, claimed_instrument_id: instrument, reason_code: code });   // the rejection lives in the DEVICE's centre
  };
  await probe(rejectedFor(m), UNKNOWN);
  if (!T(m)) await probe(INS(4), MISMATCH);                                                                                 // AB2a: same centre, bound to another agent
  for (const [k, v] of Object.entries({ messages: w.messages, runs: w.runs, records: w.records, events: w.events, observed: w.observed, status: w.status })) expect(v, `${k} stored for a refused message`).toEqual([]);
  onlyTenant(spy, TENANT_A); leakFree(w.rejections.map((r) => r['tenant_id']), [TENANT_B]);
  const ok = await call('submitMessageBatch', request({ body: batch([message({ n: 90, instrument: INS(1) })]) }), c.ctx); expect(ok.body.results[0].outcome).toBe('accepted');   // control: the own instrument works through the same handler
};
const hostQuery = async (m: Mode) => {                                                                                      // E05
  const s = hqSetup(); useRepos({ ingest: s.repo }); const spy = { calls: s.world.calls };
  const probe = async (instrument: string, code: string) => {
    const e = await fails(call('submitHostQuery', request({ body: hqBody({ instrument }) }), s.ctx)); expect(e.code).toBe(code);
    expect(s.world.rejections.at(-1)).toMatchObject({ tenant_id: TENANT_A, centre_id: CENTRE_A1, agent_id: s.world.deviceAgent, claimed_instrument_id: instrument, reason_code: code }); leakFree(e, [TENANT_B]);
  };
  await probe(rejectedFor(m), UNKNOWN);
  if (!T(m)) await probe(INS(4), MISMATCH);
  expect(s.commitOnError, 'the rejection row is kept (commitOnError)').toHaveBeenCalled(); expect(s.lab.calls, 'LabPort never asked about a refused query').toEqual([]);
  expect(s.world.messages).toEqual([]); onlyTenant(spy, TENANT_A);
};
const attachment = async (m: Mode) => {                                                                                     // E06
  const w = makeAttachmentsWorld(); useRepos({ attachments: w.repo }); const c = attachmentsDeviceCtx(w); const f = pdfBytes(); const spy = { calls: w.calls };
  const send = (instrument: string) => call('submitAttachment', request({ body: { metadata: metadata(f, { instrument_id: instrument }), file: { filename: 'slide-0042.pdf', mimetype: 'application/pdf', data: f } } }), c.ctx);
  const probe = async (instrument: string, code: string) => { const e = await fails(send(instrument)); expect(e.code).toBe(code); leakFree(e, [TENANT_B]); };
  await probe(rejectedFor(m), UNKNOWN);
  if (!T(m)) await probe(INS(4), MISMATCH);
  expect(w.messages, 'no message').toEqual([]); expect(w.attachments, 'no attachment row').toEqual([]); expect(c.storage.paths(), 'no object in Storage').toEqual([]); expect(w.jobs, 'no scan job').toEqual([]);
  onlyTenant(spy, TENANT_A);
  const ok = await send(idN(0x2009)); expect(ok.status).toBe(202);                                                          // control: the file-drop instrument of this device (INS 9) works
};

export const DEVICE_PROBES: Record<string, (m: Mode) => Promise<void>> = {
  ...agentKeyed, submitMessageBatch: batchIngest, submitHostQuery: hostQuery, submitAttachment: attachment,
};

// ====================================================================================================================== S-05 credential kind (AB4): E01 takes only an enrolment code, E02-E08 only a device token
type Mk = () => { ctx: any; calls: Array<{ op: string }> };
const mkDevice = (kind: string | null): Mk => () => { const s = devSetup('tenant'); const c = makeDeviceCtx({ agentId: AGENT_X, credentialId: OLD_TOKEN_ID, kind }); return { ctx: c.ctx, calls: s.w.calls }; };
const mkIngest = (kind: string | null): Mk => () => { const w = makeWorld(); useRepos({ ingest: w.repo }); const c = makeIngestCtx(w); c.ctx.claims = kind === null ? undefined : { credential_kind: kind, credential_id: idN(0x6002) }; return { ctx: c.ctx, calls: w.calls }; };
const mkHq = (kind: string | null): Mk => () => { const s = hqSetup(); useRepos({ ingest: s.repo }); s.ctx.claims = kind === null ? undefined : { credential_kind: kind, credential_id: idN(0x6002) }; return { ctx: s.ctx, calls: s.world.calls }; };
const mkAtt = (kind: string | null): Mk => () => { const w = makeAttachmentsWorld(); useRepos({ attachments: w.repo }); const c = attachmentsDeviceCtx(w); c.ctx.claims = kind === null ? undefined : { credential_kind: kind, credential_id: idN(0x6002) }; return { ctx: c.ctx, calls: w.calls }; };
const F = pdfBytes();
export const KIND_PROBES: Record<string, { wrong: (kind: string | null) => Mk; req: () => ReturnType<typeof request> }> = {
  enrolAgent: { wrong: (k) => () => { const s = devSetup('tenant'); const c = enrolCtx({ kind: k as any }); return { ctx: c.ctx, calls: s.w.calls }; }, req: () => request({ body: bodyE01 }) },
  getAgentConfig: { wrong: mkDevice, req: () => request() },
  submitAgentHeartbeat: { wrong: mkDevice, req: () => request({ body: heartbeatBody() }) },
  submitAgentLogBundle: { wrong: mkDevice, req: () => request({ body: bundleBody(idN(0x8001)) }) },
  downloadAgentRelease: { wrong: mkDevice, req: () => request({ params: { release_id: idN(0x7001) } }) },
  submitMessageBatch: { wrong: mkIngest, req: () => request({ body: batch([message({ n: 1 })]) }) },
  submitHostQuery: { wrong: mkHq, req: () => request({ body: hqBody({ n: 1 }) }) },
  submitAttachment: { wrong: mkAtt, req: () => request({ body: { metadata: metadata(F), file: { filename: 'slide-0042.pdf', mimetype: 'application/pdf', data: F } } }) },
};
export const kindFor = (op: string) => (op === 'enrolAgent' ? 'device_token' : 'enrolment_code');                          // the WRONG kind for that operation
