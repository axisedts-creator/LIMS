// T0D-OFFLINE-4 (LD-322 decisions 2 and 3; offline design operation catalogue): result entry, verification with the T0B-VERLEVEL-1 policy checked LOCALLY,
// and the offline report print marker. The rules mirror services/api/src/modules/lab/service/signoff.service.ts (most specific ACTIVE policy test > department > lab,
// none = level 2 + pathologist + enterer excluded; the level frozen on the result wins; one person signs one version once); the server checks again at sync and a
// refused sign off recalls every report printed offline on it. A final pathologist sign off needs MFA step up: online only unless the tenant allows offline approval
// (LD-322 decision 3, default off). Business refusals RETURN { ok: false, code, message } and queue nothing; permission, input and a locked store THROW OfflineError.
import { t } from '../i18n/messages';
import type { Operation, Outbox } from './outbox';
import { OfflineError, type OfflineStore } from './store';

/* eslint-disable @typescript-eslint/no-explicit-any -- cached read documents, checked here */
type Any = any;
export interface LabFlowsOptions {
  store: OfflineStore; outbox: Outbox; deviceId: string; userId: string; permissions: readonly string[]; now?: () => number;
  /** tenant setting: a locally signed in pathologist may give the final sign off offline (LD-322 decision 3; CR: no cached source yet, default off) */
  offlineApproval?: () => boolean | Promise<boolean>;
}
export type ReportStatus = { state: 'none' | 'pending' | 'confirmed' } | { state: 'recall'; code: string; result_ids: string[] };
type Refusal = { code: string; message: string };

const ACK_FLAGS = ['delta', 'critical', 'unit_mismatch', 'instrument_flag'] as const; // lab.yaml VerifyResultRequest
const ENTRY_KEYS = ['result_id', 'version', 'value_numeric', 'value_text', 'ordinal_code', 'manual_abnormal', 'comment_codes', 'comment_text'] as const; // BulkEnterResultsRequest
const VALUE_KEYS = ['value_numeric', 'value_text', 'ordinal_code'] as const;
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;
const ORDINAL = /^[A-Z0-9_+\-]{1,16}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const MAX_ENTRIES = 200;
const LOCKED_STATUS = new Set(['verified', 'approved']);
const DEFAULT_POLICY = { required_verifiers: 2, require_pathologist: true, allow_enterer_verify: false };
const APPROVE = 'lab.result.approve';

const fail = (code: string): never => { throw new OfflineError(code); };
const bad = () => fail('common.validation_failed');
const str = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const refuse = (code: string): Refusal => ({ code, message: t(code.startsWith('lab.') ? `lab.reason.${code}` : `offline.refusal.${code}`) });
const entryIds = (op: Operation): string[] => (op.op_type === 'result.enter' ? ((op.payload as Any)?.entries ?? []).map((e: Any) => e?.result_id) : []);

/** the flags this result needs acknowledged (QueueScreen neededFlags, result.service needed()) */
export function neededAckFlags(r: Any): string[] {
  const f: string[] = [];
  if (r?.delta?.status === 'fail') f.push('delta');
  if (r?.critical?.is_critical) f.push('critical');
  if (r?.unit_mismatch) f.push('unit_mismatch');
  if (Array.isArray(r?.instrument_flags) && r.instrument_flags.length) f.push('instrument_flag');
  return f;
}

function checkEntry(e: Any) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) bad();
  if (Object.keys(e).some((k) => !(ENTRY_KEYS as readonly string[]).includes(k))) bad();
  if (!str(e.result_id) || !Number.isSafeInteger(e.version) || e.version < 1) bad();
  const values = VALUE_KEYS.filter((k) => e[k] !== undefined);
  const comment = e.comment_text !== undefined || e.comment_codes !== undefined;
  if (values.length > 1 || (values.length === 0 && !comment)) bad(); // exactly one value field unless only comments change
  if (e.value_numeric !== undefined && (typeof e.value_numeric !== 'string' || e.value_numeric.length > 40 || !DECIMAL.test(e.value_numeric))) bad();
  if (e.value_text !== undefined && (typeof e.value_text !== 'string' || e.value_text.length > 2000)) bad();
  if (e.ordinal_code !== undefined && (typeof e.ordinal_code !== 'string' || !ORDINAL.test(e.ordinal_code))) bad();
  if (e.manual_abnormal !== undefined && typeof e.manual_abnormal !== 'boolean') bad();
  if (e.comment_text !== undefined && (typeof e.comment_text !== 'string' || e.comment_text.length > 1000)) bad();
  if (e.comment_codes !== undefined && (!Array.isArray(e.comment_codes) || e.comment_codes.length > 10
    || e.comment_codes.some((c: unknown) => typeof c !== 'string' || c.length > 100 || !CODE.test(c)))) bad();
}

export function createLabFlows(o: LabFlowsOptions) {
  const { store, outbox } = o;
  const can = (p: string) => { if (!o.permissions.includes(p)) fail('auth.forbidden'); if (!store.isUnlocked()) fail('offline.locked'); };
  const list = async (type: string): Promise<Any[]> => {
    const keys = (await store.keys('refdata')).filter((k) => k.startsWith(`${type}:`));
    return (await Promise.all(keys.map((k) => store.get('refdata', k)))).filter(Boolean);
  };

  /** the cached row with this device's pending operations laid over it, in creation order (each applied op moves the server version by 1) */
  function overlay(row: Any, pending: Operation[]) {
    const r = { ...row, signoffs: (Array.isArray(row.signoffs) ? row.signoffs : []).filter((s: Any) => row.current_version_no === undefined || s.result_version === row.current_version_no),
      signoff_count: Number(row.signoff_count ?? 0), device_ops: [] as string[], device_signers: [] as string[] };
    if (row.status === 'verified' && r.signoff_count === 0) r.signoff_count = 1; // signoff.service countOf: a legacy verified row counts as one
    for (const op of pending) {
      if (op.op_type === 'result.enter') {
        const e = ((op.payload as Any)?.entries ?? []).find((x: Any) => x?.result_id === row.id);
        if (!e) continue;
        if (r.signoff_count > 0) { r.current_version_no = Number(r.current_version_no ?? 1) + 1; r.signoff_count = 0; r.signoffs = []; } // a correction starts a new version
        const { result_id: _id, version: _v, ...vals } = e;
        if (VALUE_KEYS.some((k) => vals[k] !== undefined)) for (const k of VALUE_KEYS) delete r[k];
        Object.assign(r, vals, { version: Number(r.version) + 1, entered_by_user_id: op.user_id });
        r.device_ops.push(op.op_id);
      } else if (op.op_type === 'result.verify' && op.entity_id === row.id) {
        r.signoffs = [...r.signoffs, { signer_user_id: op.user_id, result_version: r.current_version_no, action: 'verify', device: true }];
        r.signoff_count += 1; r.version = Number(r.version) + 1;
        r.device_ops.push(op.op_id); r.device_signers.push(op.user_id);
      }
    }
    return r;
  }

  async function policyFor(r: Any) {
    const act = (await list('verification_policy')).filter((p) => p.active);
    return act.find((p) => p.scope === 'test' && p.test_id === r.test_id) ?? act.find((p) => p.scope === 'department' && p.department_id === r.department_id)
      ?? act.find((p) => p.scope === 'lab') ?? DEFAULT_POLICY;
  }

  async function load(id: unknown, pending?: Operation[]) {
    if (!str(id)) bad();
    if (!store.isUnlocked()) fail('offline.locked');
    const row = await store.get<Any>('refdata', `worklist_item:${id as string}`);
    if (!row) fail('common.not_found');
    return overlay(row, pending ?? (await outbox.pending()));
  }

  async function state(r: Any) {
    const p = await policyFor(r);
    const required = Number.isSafeInteger(r.signoff_required) ? r.signoff_required : p.required_verifiers;
    const final = r.status === 'approved' || r.signoff_count >= required;
    return { p, required, count: r.signoff_count as number, final, signers: r.signoffs.map((s: Any) => s.signer_user_id) as string[], source: r.device_signers.length ? 'device' as const : 'server' as const };
  }

  async function approvalAllowed() { try { return (await o.offlineApproval?.()) === true; } catch { return false; } }

  async function check(id: unknown, input: Any): Promise<({ allowed: true; final: boolean } | ({ allowed: false } & Refusal)) & { r?: Any }> {
    if (!store.isUnlocked()) fail('offline.locked');
    const acks = input?.acknowledged_flags;
    if (acks !== undefined && (!Array.isArray(acks) || acks.length > 4 || acks.some((f) => !(ACK_FLAGS as readonly string[]).includes(f)))) bad();
    const r = await load(id);
    const s = await state(r);
    const no = (code: string) => ({ allowed: false as const, ...refuse(code) });
    const enterer = !s.p.allow_enterer_verify && !!r.entered_by_user_id && r.entered_by_user_id === o.userId;
    // [CONV] the person who entered the result on this device is told why at once, even without lab.result.verify (outage drill); anyone else lacking it: auth.forbidden
    if (!o.permissions.includes('lab.result.verify')) { if (enterer) return no('lab.enterer_cannot_verify'); fail('auth.forbidden'); }
    // signoff.service order: status and flag gates, then counter, distinct people, enterer, pathologist
    if (r.status === 'approved' || s.final) return no('lab.result_invalid_transition');
    if (neededAckFlags(r).some((f) => !(acks ?? []).includes(f))) return no('lab.flag_ack_required');
    if (s.signers.includes(o.userId)) return no('lab.verifier_not_distinct');
    if (enterer) return no('lab.enterer_cannot_verify');
    const final = s.count + 1 >= s.required;
    if (final && s.p.require_pathologist) {
      if (!o.permissions.includes(APPROVE)) return no('lab.pathologist_required');
      if (!(await approvalAllowed())) return no('sync.offline_not_allowed'); // MFA step up cannot happen offline (LD-322 decision 3)
    }
    return { allowed: true, final, r };
  }

  /** a report's status from the local print record and the outbox lists; nothing held in memory, so it survives a reload */
  async function reportStatus(id: string): Promise<ReportStatus> {
    if (!store.isUnlocked()) fail('offline.locked');
    const rec = await store.get<{ prints: Array<{ op_id: string; relied: string[] }>; result_ids: string[] }>('refdata', `report_print:${id}`);
    if (!rec?.prints?.length) return { state: 'none' };
    const [pending, attention, conflicts] = await Promise.all([outbox.pending(), outbox.needsAttention(), outbox.conflicts()]);
    const watched = new Set(rec.prints.flatMap((p) => [p.op_id, ...p.relied]));
    const refused = [...attention.map((a) => ({ op: a as Operation, code: a.code })), ...conflicts.map((c) => ({ op: c as Operation, code: c.code ?? 'sync.conflict' }))]
      .filter((x) => watched.has(x.op.op_id));
    if (refused.length) {
      const ids = new Set(refused.flatMap((x) => (x.op.op_type === 'result.verify' ? [x.op.entity_id] : entryIds(x.op))));
      return { state: 'recall', code: refused[0]!.code, result_ids: rec.result_ids.filter((r) => ids.has(r)) };
    }
    return pending.some((p) => watched.has(p.op_id)) ? { state: 'pending' } : { state: 'confirmed' };
  }

  return {
    async worklist(): Promise<Any[]> {
      if (!store.isUnlocked()) fail('offline.locked');
      const pending = await outbox.pending();
      return (await list('worklist_item')).map((r) => overlay(r, pending)).sort((a, b) => String(a.registration_no).localeCompare(String(b.registration_no)));
    },
    localResult: (id: string) => load(id),

    async enterResults(input: Any) {
      can('lab.result.enter');
      const entries: Any[] = input?.entries;
      if (!input || typeof input !== 'object' || Object.keys(input).some((k) => k !== 'entries')) bad();
      if (!Array.isArray(entries) || entries.length < 1 || entries.length > MAX_ENTRIES) bad();
      entries.forEach(checkEntry);
      if (new Set(entries.map((e) => e.result_id)).size !== entries.length) bad();
      const pending = await outbox.pending();
      const rows = await Promise.all(entries.map((e) => load(e.result_id, pending)));
      const locked = rows.filter((r) => LOCKED_STATUS.has(r.status) || r.device_signers.length > 0).map((r) => r.id as string);
      if (locked.length) return { ok: false as const, ...refuse('sync.result_locked'), result_ids: locked };
      // signed at the version the user sees on this device (the cached version plus this device's pending changes)
      const payload = { entries: entries.map((e, i) => { const x: Record<string, unknown> = {}; for (const k of ENTRY_KEYS) if (e[k] !== undefined) x[k] = e[k]; x['version'] = rows[i]!.version; return x; }) };
      const op = await outbox.append({ op_type: 'result.enter', payload });
      return { ok: true as const, op_id: op.op_id, entered: entries.length };
    },

    async checkVerify(id: string, input: Any = {}) { const { r: _r, ...c } = await check(id, input); return c; },
    async verifyResult(input: Any) {
      const c = await check(input?.result_id, input);
      if (!c.allowed) return { ok: false as const, code: c.code, message: c.message };
      const payload = Array.isArray(input.acknowledged_flags) && input.acknowledged_flags.length ? { acknowledged_flags: [...input.acknowledged_flags] } : {};
      const op = await outbox.append({ op_type: 'result.verify', entity_id: c.r.id, base_version: c.r.version, payload });
      return { ok: true as const, op_id: op.op_id, final: c.final };
    },
    async signoffState(id: string) {
      const s = await state(await load(id));
      return { required: s.required, count: s.count, final: s.final, signers: s.signers, source: s.source };
    },

    async printReport(input: Any) {
      can('reporting.report.print');
      if (!str(input?.report_version_id) || !['letterhead', 'plain'].includes(input?.variant) || !Number.isSafeInteger(input?.copies) || input.copies < 1 || input.copies > 5) bad();
      const key = `report_print:${input.report_version_id}`;
      const rep = await store.get<Any>('refdata', `report_version:${input.report_version_id}`);
      if (!rep) fail('common.not_found');
      const ids: string[] = Array.isArray(rep.result_ids) ? rep.result_ids : [];
      const pending = await outbox.pending();
      const rows = await Promise.all(ids.map((id) => load(id, pending).catch((e) => { if (e instanceof OfflineError && e.code === 'common.not_found') return null; throw e; })));
      const states = await Promise.all(rows.map((r) => (r ? state(r) : null)));
      if (ids.length === 0 || states.some((s) => !s?.final)) return { ok: false as const, ...refuse('reporting.print_not_ready') };
      // the print relies on every device operation that made one of its results final (a refusal of any of them recalls the report)
      const relied = rows.flatMap((r) => r!.device_ops as string[]);
      const prev = await store.get<Any>('refdata', key);
      const op_id = outbox.nextId();
      const rec = { result_ids: ids, prints: [...(prev?.prints ?? []), { op_id, relied, at: new Date((o.now ?? Date.now)()).toISOString() }] };
      await outbox.append({ op_id, op_type: 'report.print_marker', entity_id: input.report_version_id, payload: { variant: input.variant, copies: input.copies } },
        [{ store: 'refdata', key, value: rec }]);
      return { ok: true as const, op_id, issued_offline: true as const, relied_on_device: relied.length > 0 };
    },
    reportStatus,
  };
}

export type LabFlows = ReturnType<typeof createLabFlows>;
