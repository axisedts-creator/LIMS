// M1a-M1b plans, M2 enrol, M3 list, M4 lookup, M5 cancel, E47 listMyMemberships (02-TRD §4.12, §5; 05-SCHEMA §2 memberships; PRD US-EN-17.1-17.5;
// 07-SECURITY "Membership card QR"; 08 A24.1 / CR-C16-023 / R25).
// Tenant and actor come from ctx only. Error details are fixed text: no submitted value, card number or token is echoed, logged or audited (REQ-SEC-080).
// The price list is validated through ctx.ports.CatalogPort.getPriceListStatus only; no catalog view/table is read (08 R25 / A17 P-21).
import { randomBytes } from 'node:crypto';
import { LimsError, type FieldError } from '../../../core/errors.js';
import * as defaultRepo from '../repository/membership.repo.js';
import { parseIfMatch } from './settings.service.js';

export interface MembershipCtx {
  readonly tenantId: string;
  readonly actor: { readonly type: string; readonly id: string };
  readonly tx: unknown;
  now(): string;
  readonly ports?: { CatalogPort?: { getPriceListStatus(ctx: unknown, input: { priceListId: string }): Promise<{ isActive: boolean; status: string }> } };
  readonly audit: { access(e: Record<string, unknown>): Promise<void> };
}
export type MembershipRepo = typeof defaultRepo;

const TZ = 'Asia/Kathmandu'; // [CONV] 05-SCHEMA P-15: the only v1 tenant timezone
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 without I L O U (05-SCHEMA patient_memberships__card__ck)
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE = /^[A-Z0-9_]{2,20}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CARD_NO = /^MB[0-9]{8}$/;
const REASONS = ['patient_request', 'staff_error', 'other'];
const PLAN_KEYS = new Set(['code', 'display_name', 'description', 'price_list_id', 'validity_days', 'is_active']);
const ACTIVE_UQ = 'patient_memberships__tenant_id_patient_active__p_uq';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const fe = (path: string, code: string, message: string): FieldError => ({ path, code, message });
const invalid = (path: string, code = 'common.field_invalid', message = 'Field invalid'): never => {
  throw new LimsError('common.validation_failed', undefined, [fe(path, code, message)]);
};
const pgCode = (e: unknown): string | undefined => (e as { code?: string } | null)?.code;

function scope(ctx: MembershipCtx): { tx: any; tenantId: string; userId: string } {
  if (typeof ctx?.tenantId !== 'string' || typeof ctx.actor?.id !== 'string' || !ctx.tx) throw new LimsError('auth.unauthenticated');
  return { tx: ctx.tx, tenantId: ctx.tenantId, userId: ctx.actor.id };
}
const needUuid = (v: unknown, path: string): string => (typeof v === 'string' && UUID.test(v) ? v : invalid(path));
/** pg DATE may arrive as a Date or a string; the wire wants 'YYYY-MM-DD'. */
const day = (d: unknown): string => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));
const utc = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d));
const localDate = (now: string): string => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
const addDays = (iso: string, n: number): string => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

function planInput(body: unknown): defaultRepo.PlanValues {
  if (!isObj(body)) return invalid('/');
  for (const k of Object.keys(body)) if (!PLAN_KEYS.has(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field'); // mass assignment
  for (const k of ['code', 'display_name', 'price_list_id', 'validity_days', 'is_active']) if (body[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
  const { code, display_name: name, description, price_list_id: pl, validity_days: days, is_active: active } = body;
  if (typeof code !== 'string' || !CODE.test(code)) invalid('/code');
  if (typeof name !== 'string' || name.length < 1 || name.length > 60) invalid('/display_name');
  if (description !== undefined && (typeof description !== 'string' || description.length > 300)) invalid('/description');
  needUuid(pl, '/price_list_id');
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 30 || days > 1095) invalid('/validity_days');
  if (typeof active !== 'boolean') invalid('/is_active');
  return { code: code as string, display_name: name as string, description: (description as string | undefined) ?? null, price_list_id: pl as string, validity_days: days as number, is_active: active as boolean };
}

const planBody = (r: Record<string, any>) => ({
  id: r['id'], code: r['code'], display_name: r['display_name'], ...(r['description'] == null ? {} : { description: r['description'] }),
  price_list_id: r['price_list_id'], validity_days: r['validity_days'], is_active: r['is_active'], version: r['version'],
});
const cardFields = (r: Record<string, any>) => ({ card_no: r['card_no'], card_token: r['card_token'], valid_from: day(r['valid_from']), valid_to: day(r['valid_to']), status: r['status'] });
const membershipBody = (r: Record<string, any>, planName: string) => ({
  id: r['id'], patient_id: r['patient_id'], plan_id: r['plan_id'], plan_display_name: planName, ...cardFields(r),
  ...(r['cancelled_at'] == null ? {} : { cancelled_at: utc(r['cancelled_at']) }), ...(r['cancel_reason_code'] == null ? {} : { cancel_reason_code: r['cancel_reason_code'] }), version: r['version'],
});

/** 130 bits from the CSPRNG (04 A11 floor); 256 % 32 = 0, so masking a byte to 5 bits is unbiased. */
function newCardToken(): string {
  let t = '';
  for (const b of randomBytes(26)) t += ALPHABET[b & 31];
  return t;
}

export function createMembershipService(deps: { repo?: MembershipRepo } = {}) {
  const repo = deps.repo ?? defaultRepo;

  /** M1b: published + active only. not_found / inactive / any other status -> 400; other port errors propagate. */
  async function checkPriceList(ctx: MembershipCtx, priceListId: string): Promise<void> {
    const port = ctx.ports?.CatalogPort;
    if (!port) throw new LimsError('common.service_unavailable');
    let st: { isActive: boolean; status: string } | undefined;
    try { st = await port.getPriceListStatus(ctx, { priceListId }); } catch (e) {
      if (e instanceof LimsError && e.code === 'common.not_found') return invalid('/price_list_id');
      throw e;
    }
    if (st?.isActive !== true || st.status !== 'published') invalid('/price_list_id');
  }
  const duplicateCode = (e: unknown): never => { if (pgCode(e) === '23505') return invalid('/code', 'common.field_invalid', 'Plan code already in use'); throw e; };

  async function namesOf(tx: any, tenantId: string, rows: Array<Record<string, any>>): Promise<Map<string, string>> {
    const plans = await repo.plansByIds(tx, { tenantId, ids: [...new Set(rows.map((r) => r['plan_id'] as string))] });
    return new Map(plans.map((p) => [p['id'] as string, p['display_name'] as string]));
  }

  return {
    async listPlans(ctx: MembershipCtx, input: { query: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const q = isObj(input.query) ? input.query : {};
      const raw = q['is_active'];
      const isActive = raw === undefined ? undefined : raw === true || raw === 'true' ? true : raw === false || raw === 'false' ? false : invalid('/is_active');
      return { data: (await repo.listPlans(tx, { tenantId, ...(isActive === undefined ? {} : { isActive }) })).map(planBody) };
    },

    async createPlan(ctx: MembershipCtx, input: { body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const v = planInput(input.body);
      await checkPriceList(ctx, v.price_list_id);
      try { return planBody(await repo.insertPlan(tx, { tenantId, userId, v })); } catch (e) { return duplicateCode(e); }
    },

    async updatePlan(ctx: MembershipCtx, input: { planId: unknown; headers: unknown; body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      const id = needUuid(input.planId, '/plan_id');
      const v = planInput(input.body);
      const cur = await repo.getPlan(tx, { tenantId, id });
      if (!cur) throw new LimsError('common.not_found');
      if (cur['version'] !== expectedVersion) throw new LimsError('common.version_conflict');
      if (v.price_list_id !== cur['price_list_id']) await checkPriceList(ctx, v.price_list_id); // an unchanged list is not re-judged: deactivating or renaming a plan must stay possible
      let row;
      try { row = await repo.updatePlan(tx, { tenantId, userId, id, expectedVersion, v }); } catch (e) { return duplicateCode(e); }
      if (!row) throw new LimsError('common.version_conflict');
      return planBody(row);
    },

    /** US-EN-17.2: one active card per patient (partial unique index is the guard for races); valid_from within today..today+30 (NPT). */
    async enrol(ctx: MembershipCtx, input: { body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const b = input.body;
      if (!isObj(b)) return invalid('/');
      for (const k of Object.keys(b)) if (!['patient_id', 'plan_id', 'valid_from'].includes(k)) invalid(`/${k.slice(0, 64)}`, 'common.unknown_field', 'Unknown field');
      for (const k of ['patient_id', 'plan_id', 'valid_from']) if (b[k] === undefined) invalid(`/${k}`, 'common.field_required', 'Field required');
      const patientId = needUuid(b['patient_id'], '/patient_id'), planId = needUuid(b['plan_id'], '/plan_id');
      const from = b['valid_from'];
      const today = localDate(ctx.now());
      if (typeof from !== 'string' || !ISO_DATE.test(from) || addDays(from, 0) !== from || from < today || from > addDays(today, 30)) invalid('/valid_from');

      const plan = await repo.getPlan(tx, { tenantId, id: planId });
      if (!plan) throw new LimsError('common.not_found');
      if (plan['is_active'] !== true) throw new LimsError('engagement.plan_inactive');
      if (await repo.activeOf(tx, { tenantId, patientId })) throw new LimsError('engagement.membership_overlap');

      const yy = today.slice(2, 4);
      let cardNo = '';
      for (let i = 0; i < 5 && !cardNo; i++) { // a number already taken (counter reset / manual row) is skipped, never reused
        const c = `MB${yy}${String(await repo.nextCardSeq(tx, { tenantId, userId, yy })).padStart(6, '0')}`;
        if (!(await repo.cardNoTaken(tx, { tenantId, cardNo: c }))) cardNo = c;
      }
      if (!cardNo) throw new LimsError('common.internal');
      let row;
      try {
        row = await repo.insertMembership(tx, { tenantId, userId, patientId, planId, cardNo, cardToken: newCardToken(), validFrom: from as string, validTo: addDays(from as string, plan['validity_days'] as number) });
      } catch (e) {
        const c = pgCode(e);
        if (c === '23505' && (e as { constraint?: string }).constraint === ACTIVE_UQ) throw new LimsError('engagement.membership_overlap');
        if (c === '23503') throw new LimsError('common.not_found'); // patient of another tenant / unknown (FK)
        throw e;
      }
      return membershipBody(row, plan['display_name'] as string);
    },

    async listOfPatient(ctx: MembershipCtx, input: { patientId: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const patientId = needUuid(input.patientId, '/patient_id');
      const rows = await repo.listOfPatient(tx, { tenantId, patientId });
      const names = await namesOf(tx, tenantId, rows);
      return { data: rows.map((r) => membershipBody(r, names.get(r['plan_id'] as string) ?? '')) };
    },

    /** US-EN-17.4: card_token XOR card_no; the scanned value is a bind parameter only; a hit is access-logged without the value. */
    async lookup(ctx: MembershipCtx, input: { body: unknown }) {
      const { tx, tenantId } = scope(ctx);
      const b = input.body;
      if (!isObj(b)) return invalid('/');
      const keys = Object.keys(b);
      const [k] = keys;
      if (keys.length !== 1 || (k !== 'card_token' && k !== 'card_no')) return invalid('/');
      const v = b[k];
      if (typeof v !== 'string' || !(k === 'card_token' ? TOKEN : CARD_NO).test(v)) return invalid(`/${k}`);
      const row = k === 'card_token' ? await repo.findByToken(tx, { tenantId, cardToken: v }) : await repo.findByCardNo(tx, { tenantId, cardNo: v });
      if (!row) throw new LimsError('common.not_found');
      await ctx.audit.access({ action: 'patient_membership.lookup', entityType: 'patient_membership', entityId: row['id'], outcome: 'success' });
      const names = await namesOf(tx, tenantId, [row]);
      return membershipBody(row, names.get(row['plan_id'] as string) ?? '');
    },

    async cancel(ctx: MembershipCtx, input: { membershipId: unknown; headers: unknown; body: unknown }) {
      const { tx, tenantId, userId } = scope(ctx);
      const expectedVersion = parseIfMatch(input.headers);
      const id = needUuid(input.membershipId, '/membership_id');
      const b = input.body;
      if (!isObj(b) || Object.keys(b).some((k) => k !== 'reason_code')) return invalid('/');
      const reason = b['reason_code'];
      if (typeof reason !== 'string' || !REASONS.includes(reason)) return invalid('/reason_code');
      const cur = await repo.getMembership(tx, { tenantId, id });
      if (!cur) throw new LimsError('common.not_found');
      if (cur['version'] !== expectedVersion || cur['status'] !== 'active') throw new LimsError('common.version_conflict'); // [CONV] no 409 code of its own for "not active"; registry 409 = state moved
      const row = await repo.cancel(tx, { tenantId, userId, id, expectedVersion, reason, now: ctx.now() });
      if (!row) throw new LimsError('common.version_conflict');
      const names = await namesOf(tx, tenantId, [row]);
      return membershipBody(row, names.get(row['plan_id'] as string) ?? '');
    },

    /** E47: patient actor only; the cards of the caller's ACTIVE profile links (a revoked link hides its card at once). Cards carry profile_id (link id), never patient_id. */
    async listMine(ctx: MembershipCtx) {
      const { tx, tenantId, userId } = scope(ctx);
      if (ctx.actor.type !== 'patient') throw new LimsError('auth.forbidden');
      const account = await repo.accountByMembership(tx, { tenantId, membershipId: userId });
      if (!account) return { data: [] };
      const links = await repo.activeLinks(tx, { tenantId, accountId: account['id'] as string });
      const profileOf = new Map(links.map((l) => [l['patient_id'] as string, l['id'] as string]));
      const rows = await repo.ofPatients(tx, { tenantId, patientIds: [...profileOf.keys()] });
      const names = await namesOf(tx, tenantId, rows);
      return {
        data: rows.filter((r) => profileOf.has(r['patient_id'] as string)).map((r) => ({
          membership_id: r['id'], profile_id: profileOf.get(r['patient_id'] as string), plan_display_name: names.get(r['plan_id'] as string) ?? '', ...cardFields(r),
        })),
      };
    },
  };
}
export type MembershipService = ReturnType<typeof createMembershipService>;
