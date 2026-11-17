// C6-T08 test helpers (not a test file). Synthetic data only.
// Builds on the T04 in-memory single-transaction fake (consumers.helpers.ts: single-table SQL, `$n` params) and the T06 port fixtures
// (api domain/__tests__/document.fixtures.ts). Adds: ORDER BY / LIMIT post-processing of SELECTs (the base fake ignores them), a row-lock
// emulation (a `SELECT ... FROM reporting.reports ... FOR UPDATE` holds a mutex until the task finishes: two parallel tasks cannot interleave),
// fake ports (lab/frontdesk/catalog/identity/smartreport), fake storage, fake PDF sandbox.
import { createHash } from 'node:crypto';
import {
  HASH_1, SYSTEM_ACTOR, TENANT_A, makeCtx, makeDb, makeLog, idN, type Db, type Row, type Seed, type DbOpts,
} from './consumers.helpers.js';
import { I, TESTS, PANELS, SIGNATORIES, id, makeInput, makeResults } from '../../../../../api/src/modules/reporting/domain/__tests__/document.fixtures.js';
import { fingerprint } from '../../../../../api/src/modules/reporting/domain/readiness.js';

export { HASH_1, TENANT_A, idN, makeLog, I };
export { TENANT_B, NOW, OCCURRED_AT } from './consumers.helpers.js';
export const HASH_2 = 'b'.repeat(64);
export const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

export const LAB = idN(0xa101); export const NARR = idN(0xa102);
export const PARTNER = idN(0x9a47);
export const ITEM = { urine: I.itemUrine, ratio: I.itemRatio, out: id(0x54), nar: id(0x55), removed: id(0x56) } as const;
export const T_OUT = id(0x27); export const T_NAR = id(0x28);
export const OUT_FILE = idN(0xf11e); export const NAR_VER = idN(0xe001); export const NAR_REPORT = idN(0xe002);
export const TEMPLATE = id(0x901); export const TEMPLATE_VERSION = id(0x902);
export const REG_NO = '0001SY000001'; export const CENTRE_CODE = 'C000000099';
export const FULL_NAME = 'Test Patient 0042'; export const MASKED_NAME = 'T*** P*****';
export const PHONE = '+9779800000042'; export const EMAIL = 'patient0042@example.invalid';
export const PORTAL_ORIGIN = 'https://portal.example.invalid';
export const ATT_BUCKET = 'instruments-attachments';
export const ATT_PATH = `${TENANT_A}/2026/11/${idN(0xa77)}.pdf`;
export const ATT_BYTES = new TextEncoder().encode('%PDF-1.7 synthetic ORIGINAL instrument pdf with /JavaScript (/Launch)');
export const SAN_BYTES = new TextEncoder().encode('%PDF-1.7 synthetic SANITISED instrument pdf');

export const mutex = () => {
  let q: Promise<void> = Promise.resolve();
  return { lock(): Promise<() => void> { let rel!: () => void; const next = new Promise<void>((r) => { rel = r; }); const prev = q; q = prev.then(() => next); return prev.then(() => rel); } };
};
export type Mutex = ReturnType<typeof mutex>;

const cmp = (a: any, b: any) => (a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : a < b ? -1 : a > b ? 1 : 0);
/** Wraps the base fake tx: FOR UPDATE on reporting.reports = row lock (until release()); ORDER BY <col> [DESC] and LIMIT n applied to SELECT results. */
export function wrapTx(base: Db['tx'], m: Mutex) {
  let held: (() => void) | undefined;
  const tx: any = {
    startedAt: base.startedAt, savepoint: async <T>(fn: (t: unknown) => Promise<T>) => fn(tx),
    release: () => { held?.(); held = undefined; },
    async query(text: string, values: unknown[] = []) {
      if (/\bfor\s+update\b/i.test(text) && /\breporting\.reports\b/i.test(text) && !held) held = await m.lock();
      const res = await base.query(text, values);
      if (!/^\s*select/i.test(text)) return res;
      let rows = res.rows;
      const ob = /\border\s+by\s+(?:\w+\.)?(\w+)(?:\s+(asc|desc))?/i.exec(text);
      if (ob) rows = [...rows].sort((a, b) => cmp(a[ob[1]!], b[ob[1]!]) * (/desc/i.test(ob[2] ?? '') ? -1 : 1));
      const lim = /\blimit\s+(\d+|\$\d+)/i.exec(text);
      if (lim) rows = rows.slice(0, lim[1]!.startsWith('$') ? Number(values[Number(lim[1]!.slice(1)) - 1]) : Number(lim[1]));
      return { rows };
    },
  };
  return tx;
}

// ------------------------------------------------------------------------------------------------ world (DB seed)
export type Key = 'urine' | 'ratio' | 'out' | 'nar';
export interface WorldOpts {
  combined?: boolean;                       // narrative_report_mode = combined: the narrative item lives on the laboratory report
  ready?: Partial<Record<Key, boolean>>;    // per item flag (lab_ready / outsourced_ready / narrative_ready); default all true except nar
  outFile?: 'confirmed' | 'ready' | 'withdrawn' | 'none';   // default confirmed
  completeness?: 'complete' | 'partial'; containsAmendment?: boolean; hash?: string;
  versions?: Row[]; reportOver?: Row; removedItem?: boolean; rls?: boolean; extraSeed?: Seed; dbOpts?: DbOpts;
}
const ctxBase = { tenant_id: TENANT_A, centre_id: I.centre, created_by: SYSTEM_ACTOR, updated_by: SYSTEM_ACTOR };

export function versionRow(n: number, over: Row = {}): Row {
  return {
    ...ctxBase, id: idN(0xc000 + n), report_id: LAB, order_id: I.order, patient_id: I.patient, partner_id: PARTNER, version_no: n, status: 'rendered',
    report_kind: 'final', completeness: 'complete', order_item_ids: [ITEM.urine, ITEM.ratio, ITEM.out], content_fingerprint: sha256(`fp-${n}`), approved_set_hash: HASH_1,
    content_snapshot: { schemaVersion: 1 }, content_sha256: sha256(`snap-${n}`), template_version_id: TEMPLATE_VERSION, reported_at: '2026-11-07T10:00:00.000Z',
    pdf_object_path: `${TENANT_A}/2026/11/${LAB}-v${n}.pdf`, pdf_sha256: sha256(`pdf-${n}`), pdf_bytes: 1000, page_count: 2, ...over,
  };
}

/** Fingerprint per TRD §4.2 for the stated ready items of the default world (lab hash = the report's stored hash). */
export function expectedFingerprint(keys: readonly Key[], counter = 0, hash = HASH_1): string {
  const one = (k: Key) => k === 'out' ? { orderItemId: ITEM.out, narrativeVersionIds: [], inputFileId: OUT_FILE }
    : k === 'nar' ? { orderItemId: ITEM.nar, narrativeVersionIds: [NAR_VER] } : { orderItemId: ITEM[k], approvedSetHash: hash, narrativeVersionIds: [] };
  return fingerprint({ items: keys.map(one), regenerationCounter: counter });
}

export function world(o: WorldOpts = {}) {
  const ready = { urine: true, ratio: true, out: true, nar: false, ...o.ready };
  const item = (n: number, key: string, orderItem: string, orderable: string, tests: string[], req: [boolean, boolean, boolean], flags: [boolean, boolean, boolean], extra: Row = {}) => ({
    ...ctxBase, id: idN(0xb100 + n), report_id: LAB, order_id: I.order, order_item_id: orderItem, orderable_id: orderable, orderable_kind: 'test', test_ids: tests,
    priority: 'routine', requires_lab: req[0], requires_narrative: req[1], requires_outsourced: req[2], lab_ready: flags[0], narrative_ready: flags[1],
    outsourced_ready: flags[2], items_version: 1, ...extra, _key: key });
  const items = [
    item(1, 'urine', ITEM.urine, I.tUrine, [I.tUrine], [true, false, false], [ready.urine, false, false]),
    item(2, 'ratio', ITEM.ratio, I.tRatio, [I.tRatio], [true, false, false], [ready.ratio, false, false]),
    item(3, 'out', ITEM.out, T_OUT, [T_OUT], [false, false, true], [false, false, ready.out]),
    ...(o.combined ? [item(4, 'nar', ITEM.nar, T_NAR, [T_NAR], [false, true, false], [false, ready.nar, false], { narrative_test_ids: [T_NAR] })] : []),
    ...(o.removedItem ? [item(5, 'removed', ITEM.removed, I.tTc, [I.tTc], [true, false, false], [false, false, false], { item_status: 'removed' })] : []),
  ].map(({ _key, ...r }) => r);
  const versions = o.versions ?? [];
  const reportBase = {
    ...ctxBase, id: LAB, branch_id: id(5), order_id: I.order, patient_id: I.patient, referrer_id: I.referrer, partner_id: PARTNER, family: 'laboratory',
    order_source: 'front_desk', registered_at: '2026-11-05T02:17:00.000Z', registration_no: REG_NO, centre_code: CENTRE_CODE, patient_display_name: null, referrer_name: null,
    needs_assembly: true, needs_assembly_since: '2026-11-07T11:50:00.000Z', lab_ready_seq: 1, lab_approved_set_hash: o.hash ?? HASH_1,
    lab_completeness: o.completeness ?? 'complete', lab_contains_amendment: o.containsAmendment ?? false,
    latest_version_no: Math.max(0, ...versions.map((v) => v['version_no'])),
    released_version_no: versions.find((v) => v['status'] === 'released')?.['version_no'] ?? null, ...o.reportOver,
  };
  const file = (state: string): Row => ({ ...ctxBase, id: OUT_FILE, order_id: I.order, order_item_id: ITEM.out, kind: 'outsourced_pdf', state, original_filename: 'scan.pdf',
    declared_mime: 'application/pdf', detected_mime: 'application/pdf', size_bytes: 1000, sha256_original: 'c'.repeat(64), quarantine_object_path: `${TENANT_A}/quarantine/x`,
    sanitized_object_path: `${TENANT_A}/outsourced/2026/11/${OUT_FILE}.pdf`, sanitized_sha256: 'd'.repeat(64), page_count: 3, external_lab_name: 'Synthetic Reference Lab',
    confirmed_at: '2026-11-07T09:00:00.000Z', confirmed_by: idN(0xa001) });
  const outFile = o.outFile ?? 'confirmed';
  const signed = o.combined && ready.nar;
  const seed: Seed = {
    'reporting.reports': [reportBase, { ...ctxBase, id: NARR, branch_id: id(5), order_id: I.order, patient_id: I.patient, family: 'narrative', order_source: 'front_desk',
      registered_at: '2026-11-05T02:17:00.000Z', registration_no: REG_NO, centre_code: CENTRE_CODE, needs_assembly: true, needs_assembly_since: '2026-11-07T11:50:00.000Z' }],
    'reporting.report_order_items': items,
    'reporting.report_versions': versions,
    'reporting.settings': [{ ...ctxBase, id: idN(0x5e7), narrative_report_mode: o.combined ? 'combined' : 'separate', print_critical_label: false }],
    'reporting.report_templates': [{ ...ctxBase, id: TEMPLATE, family: 'laboratory', name: 'Default', current_version_id: TEMPLATE_VERSION, is_default: true }],
    'reporting.report_template_versions': [{ ...ctxBase, id: TEMPLATE_VERSION, template_id: TEMPLATE, version_no: 1, status: 'published',
      config: { signatoryMode: 'approvers', maxSignatories: 2, disclaimers: ['Synthetic disclaimer line 1.'] }, config_sha256: 'e'.repeat(64) }],
    'reporting.input_files': outFile === 'none' ? [] : [file(outFile)],
    'reporting.narrative_reports': o.combined ? [{ ...ctxBase, id: NAR_REPORT, report_id: LAB, order_id: I.order, order_item_id: ITEM.nar, test_id: T_NAR, template_kind: 'xray',
      status: signed ? 'signed' : 'draft', current_version_no: 1, signed_version_no: signed ? 1 : null }] : [],
    'reporting.narrative_versions': o.combined ? [{ ...ctxBase, id: NAR_VER, narrative_report_id: NAR_REPORT, version_no: 1, status: signed ? 'signed' : 'draft',
      sections: [{ heading: 'Findings', html: '<p>Synthetic findings.</p>' }], signed_by_membership_id: signed ? I.m1 : null, signed_at: signed ? '2026-11-07T09:30:00.000Z' : null }] : [],
    ...o.extraSeed,
  };
  const db = makeDb(seed, { ...(o.rls === undefined ? {} : { rls: o.rls }), ...o.dbOpts });
  return { db, versions: () => db.all('reporting.report_versions').sort((a, b) => a['version_no'] - b['version_no']),
    qr: () => db.all('reporting.qr_tokens'), report: () => db.all('reporting.reports').find((r) => r['id'] === LAB)!,
    renderJobs: () => db.jobs.filter((j) => j.identifier === 'reporting.render_report_version'), assemblyJobs: () => db.jobs.filter((j) => j.identifier === 'reporting.assemble_report') };
}
export type World = ReturnType<typeof world>;

// ------------------------------------------------------------------------------------------------ ports
export interface PortOpts {
  partialReleaseAllowed?: boolean; amend?: boolean; attachment?: boolean; labFails?: boolean; smartFlag?: boolean; noReferrer?: boolean;
  patientName?: string;
}
export function makePorts(o: PortOpts = {}) {
  const base = makeInput();
  const calls = { lab: [] as any[], summary: [] as any[], demographics: [] as any[], referrer: [] as any[], settings: [] as any[], smart: [] as any[], signatories: [] as any[] };
  const results = makeResults().filter((g) => g.orderItemId === ITEM.urine || g.orderItemId === ITEM.ratio);
  const ph = results.flatMap((g) => g.results).find((r: any) => r.analyteId === I.aPh);
  if (o.amend) ph.amendment = { previousVersionNo: 1, reasonCode: 'corrected_value', reasonText: 'Synthetic correction', amendedAt: '2026-11-07T09:00:00.000Z' };
  if (o.attachment) ph.attachments = [{ bucket: ATT_BUCKET, objectPath: ATT_PATH, sha256: sha256(ATT_BYTES), mimeType: 'application/pdf' }];
  const out = { orderItemId: ITEM.out, orderableId: T_OUT, orderableKind: 'test', testIds: [T_OUT], priority: 'routine', status: 'active', outsourced: true };
  const nar = { orderItemId: ITEM.nar, orderableId: T_NAR, orderableKind: 'test', testIds: [T_NAR], priority: 'routine', status: 'active', outsourced: false };
  const summary = { ...base.orderSummary, referrerId: o.noReferrer ? undefined : I.referrer, partnerId: PARTNER,
    items: [...base.orderSummary.items.filter((i: any) => i.orderItemId === ITEM.urine || i.orderItemId === ITEM.ratio), out, nar] };
  const tests = [...TESTS,
    { id: T_OUT, code: 'OUT1', name: 'Synthetic outsourced assay', departmentId: I.deptBio, departmentName: 'Biochemistry', departmentCode: 'BIO', specimenTypeCodes: ['SERUM'], workflowType: 'outsourced', analytes: [], isActive: true, revision: 1 },
    { id: T_NAR, code: 'XR1', name: 'Synthetic chest X-ray', departmentId: I.deptClin, departmentName: 'Clinical Pathology', departmentCode: 'CLIN', specimenTypeCodes: ['NONE'], workflowType: 'narrative', analytes: [], isActive: true, revision: 1 }];
  const down = () => Object.assign(new Error('lab down'), { code: 'common.unavailable' });
  const ports = {
    lab: { async getOrderResults(_c: unknown, i: any) { calls.lab.push(i); if (o.labFails) throw down(); return { orderId: I.order, approvedSetHash: HASH_1, specimens: base.orderResults.specimens, items: structuredClone(results) }; } },
    frontdesk: {
      async getOrderSummary(_c: unknown, i: any) { calls.summary.push(i); return structuredClone(summary); },
      async getPatientDemographics(_c: unknown, i: any) {
        calls.demographics.push(i);
        if (i.purpose === 'portal_display') return { ...base.demographics, fullName: MASKED_NAME, phoneE164: undefined, email: undefined };
        if (i.purpose !== 'report_render') throw Object.assign(new Error('purpose not allowed for assembly'), { code: 'common.forbidden' });
        return { ...base.demographics, fullName: o.patientName ?? FULL_NAME };
      },
    },
    catalog: {
      async getTest(_c: unknown, i: any) { const t = tests.find((x) => x.id === i.testId); if (!t) throw Object.assign(new Error('nf'), { code: 'common.not_found' }); return structuredClone(t); },
      async getPanel(_c: unknown, i: any) { return PANELS.find((p) => p.id === i.panelId); },
      async getReferrer(_c: unknown, i: any) { calls.referrer.push(i); return { referrerId: I.referrer, canonicalReferrerId: I.referrer, code: 'R1', displayName: 'Dr. Synthetic Referrer', isVerified: true, isActive: true }; },
      async resolveCommentCodes() { return { resolved: [], unknown: [] }; },
    },
    identity: {
      async getTenantSettings(_c: unknown, i: any) { calls.settings.push(i); return { ...base.settings, partialReleaseAllowed: o.partialReleaseAllowed ?? false, featureFlags: o.smartFlag ? { smart_report: true } : {} }; },
      async getSignatories(_c: unknown, i: any) { calls.signatories.push(i); return SIGNATORIES.filter((s) => i.membershipIds.includes(s.membershipId)); },
    },
    smartreport: { async buildSummary(_c: unknown, i: any) { calls.smart.push(i); throw Object.assign(new Error('off'), { code: 'smartreport.feature_disabled' }); } },
  };
  return { ports, calls };
}

export function makeStorage() {
  const objects = new Map<string, Uint8Array>([[`${ATT_BUCKET}::${ATT_PATH}`, ATT_BYTES]]);
  const reads: Array<[string, string]> = []; const puts: Array<{ bucket: string; path: string; bytes: Uint8Array }> = [];
  return { objects, reads, puts,
    async read(bucket: string, path: string) { reads.push([bucket, path]); const b = objects.get(`${bucket}::${path}`); if (!b) throw new Error('object not found'); return b; },
    async put(bucket: string, path: string, bytes: Uint8Array) { puts.push({ bucket, path, bytes }); objects.set(`${bucket}::${path}`, bytes); return { path }; } };
}

export const sandboxOk = (bytes: Uint8Array = SAN_BYTES, pages = 2) => ({ ok: true as const, page_count: pages, sha256: sha256(bytes), pdf_base64: Buffer.from(bytes).toString('base64') });
export function makeSandbox(reply: any = sandboxOk()) {
  const calls: Uint8Array[] = [];
  return { calls, sanitize: async (b: Uint8Array) => { calls.push(b); if (typeof reply === 'function') return reply(b); if (reply instanceof Error) throw reply; return reply; } };
}

// ------------------------------------------------------------------------------------------------ ctx + runner
export interface Setup extends World {
  ports: ReturnType<typeof makePorts>; storage: ReturnType<typeof makeStorage>; sandbox: ReturnType<typeof makeSandbox>; logs: ReturnType<typeof makeLog>;
  metrics: Array<{ name: string; labels?: Record<string, string> }>; mutex: Mutex; ctx(): any;
  run(handler: (p: any, c: any) => Promise<void>, payload?: any, ctx?: any): Promise<void>;
}
export function setup(o: WorldOpts & PortOpts & { sandboxReply?: any } = {}): Setup {
  const w = world(o); const ports = makePorts(o); const storage = makeStorage(); const logs = makeLog(); const m = mutex();
  const sandbox = makeSandbox(o.sandboxReply); const metrics: Setup['metrics'] = [];
  const ctx = () => {
    const c = makeCtx(w.db, { ports: ports.ports as any, logs }).ctx;
    c.tx = wrapTx(w.db.tx, m); c.storage = storage; c.metrics = { inc: (name: string, labels?: Record<string, string>) => { metrics.push({ name, ...(labels ? { labels } : {}) }); } };
    return c;
  };
  return { ...w, ports, storage, sandbox, logs, metrics, mutex: m, ctx,
    async run(handler, payload = { tenant_id: TENANT_A, report_id: LAB }, c = ctx()) { try { await handler(payload, c); } finally { c.tx.release(); } } };
}

export async function build(s: { sandbox: { sanitize(b: Uint8Array): Promise<any> } }) {
  const mod: any = await import('../tasks/assemble_report.js');
  return mod.createAssembleReport({ sandbox: s.sandbox }) as (payload: any, ctx: any) => Promise<void>;
}
export const settle = (p: Promise<unknown>) => p.then(() => 'ok' as const, (e) => e as Error);
export const snapshotOf = (v: Row): any => (typeof v['content_snapshot'] === 'string' ? JSON.parse(v['content_snapshot']) : v['content_snapshot']);
export const hex = (x: unknown) => Buffer.from(x as Uint8Array).toString('hex');
export const tokenOf = (snap: any): string => String(snap.qr.verifyUrl).split('/').pop()!;
