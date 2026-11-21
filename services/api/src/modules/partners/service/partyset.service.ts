// T0B-PARTYSET-1 (LD-321, LD-325 b; founder blanket authority LD-310; contract T0C-PARTYSET-1): the 13 partners operations of party settings, onboarding,
// non compliance penalties and the government ID reveal (/v1/partners/admin/...).
// Order in every operation: staff actor -> IdentityPort.assertRole (its own x-permission; partners.party_id_number.read is privileged -> auth.mfa_required at aal1)
// -> If-Match -> request rules (domain/partyset.rules.ts, no SQL) -> tenant-bound row lookup (foreign / unknown = the same common.not_found) -> version
// -> rules that need the database -> ONE write. Every write is audited by app.tg_row_audit (the government ID columns are excluded there); nothing of a
// request body is logged. Offline (founder 2026-11-17 09:19 NPT): only getPartyCommercialSetting may be cached on a device; every other operation is online only.
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { LimsError } from '../../../core/errors.js';
import type { HandlerContext, HandlerResult } from '../../../core/module.js';
import { createAccountsService } from '../../billing/service/accounts.service.js';
import { ID_NUMBER_FIELDS } from '../domain/id-number.js';
import {
  Checker, DECISIONS, EVENT_STATUSES, MAX_PAISA, ONBOARDING_STATUSES, PARTY_KINDS, SETTING_DEFAULTS, CODE, ifMatch, invalid, isIsoDate, isObj, isUuid, settingPatch, type Obj,
} from '../domain/partyset.rules.js';
import * as repo from '../repository/partyset.repo.js';

const P = {
  settingRead: 'partners.party_setting.read', settingManage: 'partners.party_setting.manage', decide: 'partners.onboarding.decide',
  idRead: 'partners.party_id_number.read', penalty: 'partners.penalty.manage',
} as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_TZ = 'Asia/Kathmandu';
/** [CONV] payment_mode of the account ledger entry a penalty charge posts (no money moves: a debit on the party ledger) */
const PENALTY_PAYMENT_MODE = 'penalty';

type Req = { params?: unknown; query?: unknown; headers?: unknown; body?: unknown };
type Who = { tenantId: string; actorId: string };
const tx = (ctx: HandlerContext): repo.Q => ctx.tx as repo.Q;
const notFound = (): never => { throw new LimsError('common.not_found'); };
const accounts = createAccountsService();

async function authorize(ctx: HandlerContext, permission: string): Promise<Who> {
  if (ctx.actor?.type !== 'user' || !ctx.tenantId) throw new LimsError('auth.forbidden');   // staff operations only: nothing else reaches SQL
  await ctx.ports.IdentityPort.assertRole(ctx, { permission });
  return { tenantId: ctx.tenantId, actorId: ctx.actor.id };
}
const params = (req: Req): Obj => (isObj(req.params) ? req.params : {});
const param = (req: Req, k: string): string => { const v = params(req)[k]; return isUuid(v) ? v.toLowerCase() : notFound(); };
/** path party: a kind outside the enum or a malformed id cannot name a party = common.not_found */
function partyParam(req: Req): { kind: string; partyId: string } {
  const kind = params(req)['party_kind'];
  if (typeof kind !== 'string' || !(PARTY_KINDS as readonly string[]).includes(kind)) notFound();
  return { kind: kind as string, partyId: param(req, 'party_id') };
}
const queryOf = (req: Req): Obj => (isObj(req.query) ? req.query : {});

// ---- query values (the core coerces query strings; direct calls may pass strings or native values) ----
function qLimit(q: Obj, c: Checker): number {
  const v = q['limit'];
  if (v === undefined) return DEFAULT_LIMIT;
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d{1,4}$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) { c.bad('/limit'); return DEFAULT_LIMIT; }
  return n;
}
function qBool(q: Obj, k: string, c: Checker): boolean | undefined {
  const v = q[k];
  if (v === undefined) return undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return c.bad(`/${k}`);
}

// ---- cursor: base64url(JSON {v:1, s:<list>, k:<key>}); carries no authority (02-CV §4.3) ----
const encodeCursor = (s: string, k: unknown): string => Buffer.from(JSON.stringify({ v: 1, s, k })).toString('base64url');
function decodeCursor<T>(raw: unknown, s: string, check: (k: unknown) => k is T): T | undefined {
  if (raw === undefined) return undefined;
  const bad = (): never => { throw new LimsError('common.invalid_cursor'); };
  if (typeof raw !== 'string' || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) return bad();
  let o: unknown;
  try { o = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')); } catch { return bad(); }
  if (!isObj(o) || o['v'] !== 1 || o['s'] !== s || !check(o['k'])) return bad();
  return o['k'] as T;
}
function page<T>(rows: repo.Row[], limit: number, map: (r: repo.Row) => T, key: (r: repo.Row) => unknown, s: string): HandlerResult {
  const data = rows.slice(0, limit);
  const last = rows.length > limit ? data[data.length - 1] : undefined;
  return { status: 200, body: { data: data.map(map), page: { limit, ...(last ? { next_cursor: encodeCursor(s, key(last)) } : {}) } } };
}

async function tenantToday(ctx: HandlerContext): Promise<string> {
  let tz = DEFAULT_TZ;
  try {
    const t = (await (ctx.ports.IdentityPort as unknown as { getTenantSettings(c: unknown, i: { keys: string[] }): Promise<Obj | undefined> }).getTenantSettings(ctx, { keys: ['timezone'] }))?.['timezone'];
    if (typeof t === 'string' && t !== '') { new Intl.DateTimeFormat('en-CA', { timeZone: t }); tz = t; }
  } catch { /* default zone */ }
  const at = new Date((ctx as unknown as { now(): Date | string | number }).now());
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

// ================================================================ DTOs (explicit allow-lists, NULL optionals omitted)
const opt = (k: string, v: unknown): Obj => (v === null || v === undefined ? {} : { [k]: v });
function settingDto(kind: string, partyId: string, r: repo.Row | undefined): Obj {
  const src: Obj = r ?? SETTING_DEFAULTS;
  const out: Obj = { ...(r ? { id: r['id'] } : {}), party_kind: kind, party_id: partyId, is_default: r === undefined };
  for (const k of repo.SETTING_COLS) {
    const v = src[k];
    if (v === null || v === undefined) continue;
    out[k] = typeof SETTING_DEFAULTS[k] === 'number' ? Number(v) : v;
  }
  out['version'] = r ? Number(r['version']) : 1;
  return { ...out, ...opt('updated_at', r?.['updated_at']) };
}
const onboardingDto = (r: repo.Row): Obj => ({
  id: r['id'], party_kind: r['party_kind'], party_id: r['party_id'], ...opt('party_name', r['party_name']), status: r['status'],
  ...opt('reason', r['reason']), ...opt('decided_by', r['decided_by']), ...opt('decided_at', r['decided_at']), version: Number(r['version']), created_at: r['created_at'],
});
const penaltyDto = (r: repo.Row): Obj => ({
  id: r['id'], code: r['code'], name: r['name'], amount_paisa: Number(r['amount_paisa']), is_active: r['is_active'] === true, version: Number(r['version']),
  created_at: r['created_at'], updated_at: r['updated_at'],
});
const eventDto = (r: repo.Row): Obj => ({
  id: r['id'], party_kind: r['party_kind'], party_id: r['party_id'], penalty_id: r['penalty_id'], event_date: r['event_date'], amount_paisa: Number(r['amount_paisa']),
  ...opt('reason', r['reason']), status: r['status'], ...opt('ledger_entry_id', r['ledger_entry_id']), ...opt('decided_by', r['decided_by']),
  version: Number(r['version']), created_at: r['created_at'],
});

// ================================================================ commercial settings
export async function getSetting(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, P.settingRead);
  const { kind, partyId } = partyParam(req);
  if (!await repo.partyExists(tx(ctx), tenantId, kind, partyId)) notFound();
  return { status: 200, body: settingDto(kind, partyId, await repo.getSetting(tx(ctx), tenantId, kind, partyId)) };
}

/** first save creates the row (no If-Match, or "1" = the version the defaults answered); later saves need the current version */
export async function setSetting(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.settingManage);
  const expected = ifMatch(req.headers, false);
  const { kind, partyId } = partyParam(req);
  const patch = settingPatch(req.body);
  if (!await repo.partyExists(tx(ctx), tenantId, kind, partyId)) notFound();
  const cur = await repo.getSetting(tx(ctx), tenantId, kind, partyId, true);
  if (!cur) {
    if (expected !== undefined && expected !== 1) throw new LimsError('common.version_conflict');
    // a concurrent first save of the same party won (ON CONFLICT DO NOTHING waited for it): this request is stale
    if (!await repo.insertSetting(tx(ctx), tenantId, uuidv7(), kind, partyId, { ...SETTING_DEFAULTS, ...patch }, actorId)) throw new LimsError('common.version_conflict');
  } else {
    if (expected === undefined) throw new LimsError('common.precondition_required');
    if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
    if (!await repo.bump(tx(ctx), 'party_commercial_setting', tenantId, String(cur['id']), expected, patch, actorId)) throw new LimsError('common.version_conflict');
  }
  return { status: 200, body: settingDto(kind, partyId, await repo.getSetting(tx(ctx), tenantId, kind, partyId)) };
}

// ================================================================ onboarding
/** pending -> approved | held | rejected; held -> approved | rejected; approved and rejected are final */
const MOVES: Readonly<Record<string, readonly string[]>> = Object.freeze({ pending: ['approved', 'held', 'rejected'], held: ['approved', 'rejected'] });
const TARGET: Readonly<Record<string, string>> = Object.freeze({ approve: 'approved', hold: 'held', reject: 'rejected' });
const isCreatedKey = (k: unknown): k is { key: string; id: string } =>
  isObj(k) && typeof k['key'] === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(k['key']) && isUuid(k['id']);

export async function listOnboarding(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, P.decide);
  const q = queryOf(req);
  const c = new Checker(q);
  const f = { status: c.oneOf('status', ONBOARDING_STATUSES), kind: c.oneOf('party_kind', PARTY_KINDS), q: c.text('q', 64), limit: qLimit(q, c) };
  c.done();
  const after = decodeCursor(q['cursor'], 'onboarding', isCreatedKey);
  const rows = await repo.listOnboarding(tx(ctx), tenantId, { ...strip(f), ...(after ? { after } : {}) });
  return page(rows, f.limit, onboardingDto, (r) => ({ key: r['created_key'], id: r['id'] }), 'onboarding');
}

export async function decideOnboarding(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.decide);
  const expected = ifMatch(req.headers)!;
  const c = new Checker(req.body, ['decision', 'reason']);
  const decision = c.oneOf('decision', DECISIONS, true);
  const reason = c.text('reason', 500);
  if ((decision === 'hold' || decision === 'reject') && c.src['reason'] === undefined) c.bad('/reason');   // hold and reject need a reason
  c.done();
  const id = param(req, 'onboarding_id');
  const cur = (await repo.getOnboarding(tx(ctx), tenantId, id, true)) ?? notFound();
  // the decider is not the person who created the record (four eyes, by person not by role)
  if (cur['created_by'] === actorId) throw new LimsError('auth.forbidden');
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  const to = TARGET[decision!]!;
  if (!(MOVES[String(cur['status'])] ?? []).includes(to)) throw invalid('/decision');
  const done = await repo.decideOnboarding(tx(ctx), tenantId, id, expected, { status: to, reason: reason ?? null, actorId }).catch((e: { code?: string }) => {
    if (e?.code === '23514') throw invalid('/decision');   // DB transition guard: a concurrent decision won
    throw e;
  });
  if (!done) throw new LimsError('common.version_conflict');
  // the audit trail (decider, reason, new status) is the app.tg_row_audit row of partners.party_onboarding written by this UPDATE
  return { status: 200, body: onboardingDto((await repo.getOnboarding(tx(ctx), tenantId, id))!) };
}

// ================================================================ penalty catalogue
const isCodeKey = (k: unknown): k is { code: string; id: string } => isObj(k) && typeof k['code'] === 'string' && CODE.test(k['code']) && isUuid(k['id']);

export async function listPenalties(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, P.penalty);
  const q = queryOf(req);
  const c = new Checker(q);
  const f = { isActive: qBool(q, 'is_active', c), q: c.text('q', 64), limit: qLimit(q, c) };
  c.done();
  const after = decodeCursor(q['cursor'], 'penalties', isCodeKey);
  const rows = await repo.listPenalties(tx(ctx), tenantId, { ...strip(f), ...(after ? { after } : {}) });
  return page(rows, f.limit, penaltyDto, (r) => ({ code: r['code'], id: r['id'] }), 'penalties');
}

export async function createPenalty(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.penalty);
  const c = new Checker(req.body, ['code', 'name', 'amount_paisa']);
  const code = c.text('code', 20, true, CODE); const name = c.text('name', 120, true); const amount = c.int('amount_paisa', 0, MAX_PAISA, true);
  c.done();
  if (await repo.codeTaken(tx(ctx), tenantId, code!)) throw invalid('/code');
  const id = uuidv7();
  await repo.insertPenalty(tx(ctx), tenantId, { id, code: code!, name: name!.trim(), amount: amount!, actorId }).catch((e: { code?: string }) => {
    if (e?.code === '23505') throw invalid('/code');   // a concurrent create of the same code won
    throw e;
  });
  return { status: 201, body: penaltyDto((await repo.getPenalty(tx(ctx), tenantId, id))!) };
}

export async function updatePenalty(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.penalty);
  const expected = ifMatch(req.headers)!;
  const c = new Checker(req.body, ['name', 'amount_paisa']);
  const patch: Obj = {};
  const name = c.text('name', 120); if (name !== undefined) patch['name'] = name.trim();
  const amount = c.int('amount_paisa', 0, MAX_PAISA); if (amount !== undefined) patch['amount_paisa'] = amount;
  if (Object.keys(patch).length === 0 && c.errors.length === 0) c.bad('/');   // minProperties 1; the code never changes (unknown field)
  c.done();
  const id = param(req, 'penalty_id');
  const cur = (await repo.getPenalty(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  // events already raised keep their own amount (copied at raise)
  if (!await repo.bump(tx(ctx), 'non_compliance_penalty', tenantId, id, expected, patch, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: penaltyDto((await repo.getPenalty(tx(ctx), tenantId, id))!) };
}

export async function deactivatePenalty(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.penalty);
  const expected = ifMatch(req.headers)!;
  const id = param(req, 'penalty_id');
  const cur = (await repo.getPenalty(tx(ctx), tenantId, id, true)) ?? notFound();
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (cur['is_active'] !== true) return { status: 200, body: penaltyDto(cur) };   // already off: nothing to write
  if (!await repo.bump(tx(ctx), 'non_compliance_penalty', tenantId, id, expected, { is_active: false }, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: penaltyDto((await repo.getPenalty(tx(ctx), tenantId, id))!) };
}

// ================================================================ penalty events
const isEventKey = (k: unknown): k is { date: string; id: string } => isObj(k) && isIsoDate(k['date']) && isUuid(k['id']);

export async function listEvents(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, P.penalty);
  const q = queryOf(req);
  const c = new Checker(q);
  const f = {
    kind: c.oneOf('party_kind', PARTY_KINDS), partyId: c.uuid('party_id'), penaltyId: c.uuid('penalty_id'), status: c.oneOf('status', EVENT_STATUSES),
    from: c.date('from_date'), to: c.date('to_date'), limit: qLimit(q, c),
  };
  if (f.from !== undefined && f.to !== undefined && f.from > f.to) c.bad('/from_date');
  c.done();
  const after = decodeCursor(q['cursor'], 'penalty_events', isEventKey);
  const rows = await repo.listEvents(tx(ctx), tenantId, { ...strip(f), ...(after ? { after } : {}) });
  return page(rows, f.limit, eventDto, (r) => ({ date: r['event_date'], id: r['id'] }), 'penalty_events');
}

export async function raiseEvent(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.penalty);
  const c = new Checker(req.body, ['party_kind', 'party_id', 'penalty_id', 'event_date', 'amount_paisa', 'reason']);
  const kind = c.oneOf('party_kind', PARTY_KINDS, true); const partyId = c.uuid('party_id', true); const penaltyId = c.uuid('penalty_id', true);
  const date = c.date('event_date', true); const amount = c.int('amount_paisa', 0, MAX_PAISA); const reason = c.text('reason', 500);
  c.done();
  // unknown, foreign and inactive references answer the same field error (no existence leak across tenants)
  if (!await repo.partyExists(tx(ctx), tenantId, kind!, partyId!)) c.bad('/party_id');
  const pen = await repo.getPenalty(tx(ctx), tenantId, penaltyId!);
  if (!pen || pen['is_active'] !== true) c.bad('/penalty_id');
  c.done();
  const id = uuidv7();
  await repo.insertEvent(tx(ctx), tenantId, { id, kind: kind!, partyId: partyId!, penaltyId: penaltyId!, date: date!, amount: amount ?? Number(pen!['amount_paisa']), reason: reason ?? null, actorId });
  return { status: 201, body: eventDto((await repo.getEvent(tx(ctx), tenantId, id))!) };   // nothing is posted to the ledger until charged
}

export async function waiveEvent(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.penalty);
  const expected = ifMatch(req.headers)!;
  const c = new Checker(req.body, ['reason']);
  const reason = c.text('reason', 500, true);
  c.done();
  const id = param(req, 'event_id');
  const cur = (await repo.getEvent(tx(ctx), tenantId, id, true)) ?? notFound();   // a concurrent charge holds this lock: we see its result
  if (cur['status'] !== 'raised') throw invalid('/event_id');                      // waived and charged are final
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  if (!await repo.bump(tx(ctx), 'non_compliance_event', tenantId, id, expected, { status: 'waived', reason: reason!, decided_by: actorId }, actorId)) throw new LimsError('common.version_conflict');
  return { status: 200, body: eventDto((await repo.getEvent(tx(ctx), tenantId, id))!) };
}

/**
 * done_when (6): exactly ONE debit account ledger entry (billing accounts service of T0B-ACCT-1, same transaction) of the event amount on the credit party ledger
 * (a partner is charged on its credit party), its id stored on the event. The event row lock serialises every charge / waive of the event: a second charge sees
 * status charged and answers the first result (no post); a waived event is refused. Any failure of the ledger rolls the whole request back (event stays raised).
 */
export async function chargeEvent(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId, actorId } = await authorize(ctx, P.penalty);
  const expected = ifMatch(req.headers)!;
  const id = param(req, 'event_id');
  const cur = (await repo.getEvent(tx(ctx), tenantId, id, true)) ?? notFound();
  if (cur['status'] === 'charged') return { status: 200, body: eventDto(cur) };    // charged once: the repeat answers the first result and posts nothing
  if (cur['status'] !== 'raised') throw invalid('/event_id');                      // a waived event can never be charged
  if (Number(cur['version']) !== expected) throw new LimsError('common.version_conflict');
  const kind = String(cur['party_kind']);
  const ledgerParty = await repo.ledgerPartyOf(tx(ctx), tenantId, kind, String(cur['party_id']));
  if (!ledgerParty) throw invalid('/party_kind');                                   // doctor / referrer parties have no account ledger
  if (Number(cur['amount_paisa']) < 1) throw invalid('/amount_paisa');              // a zero amount cannot be a debit
  const particularId = await repo.penaltyParticular(tx(ctx), tenantId);
  if (!particularId) throw invalid('/event_id');                                    // no NON_COMPLIANCE_PENALTY particular configured (founder / accountant step)
  const centreId = (await repo.centreOfParty(tx(ctx), tenantId, kind === 'partner' ? 'partner' : 'credit_party', kind === 'partner' ? String(cur['party_id']) : ledgerParty))
    ?? (ctx as unknown as { centreId?: string }).centreId;
  if (!isUuid(centreId)) throw invalid('/event_id');
  const entry = await accounts.createEntry(ctx as never, {
    centre_id: centreId, party_kind: 'credit_party', party_id: ledgerParty, entry_date: await tenantToday(ctx), account_particular_id: particularId,
    entry_type: 'debit', amount_paisa: Number(cur['amount_paisa']), payment_mode: PENALTY_PAYMENT_MODE, comments: 'Non compliance penalty',
  });
  if (!await repo.bump(tx(ctx), 'non_compliance_event', tenantId, id, expected, { status: 'charged', ledger_entry_id: entry['id'], decided_by: actorId }, actorId)) {
    throw new LimsError('common.version_conflict');                                // cannot happen under the row lock; the throw rolls the entry back
  }
  return { status: 200, body: eventDto((await repo.getEvent(tx(ctx), tenantId, id))!) };
}

// ================================================================ government ID reveal
/**
 * done_when (5): the full value only here, to partners.party_id_number.read (privileged, aal2 via IdentityPort); every call writes ONE access audit event
 * naming who (the actor), the party and the field, never the value. The value is never logged. A party without the field answers common.not_found.
 */
export async function revealIdNumber(req: Req, ctx: HandlerContext): Promise<HandlerResult> {
  const { tenantId } = await authorize(ctx, P.idRead);
  const c = new Checker(req.body, ['field']);
  const field = c.oneOf('field', ID_NUMBER_FIELDS, true);
  c.done();
  const { kind, partyId } = partyParam(req);
  const audit = (ctx as unknown as { audit?: { access?(e: Obj): Promise<void> } }).audit;
  if (typeof audit?.access !== 'function') throw new LimsError('common.internal');   // never reveal without the audit row
  const r = await repo.idNumberOf(tx(ctx), tenantId, kind, partyId, field!);
  if (!r.exists || r.value === null) notFound();
  // CR .orchestra/cr/T0B-PARTYSET-1.md: the access action code is not in the registry yet (fails closed on the access_log FK until it is)
  await audit.access({ action: 'party_id_number.reveal', entityType: 'party_id_number', entityId: partyId, outcome: 'allowed', detail: { party_kind: kind, field: field! } });
  return { status: 200, body: { party_kind: kind, party_id: partyId, field, value: r.value } };
}

/** drop undefined keys (exactOptionalPropertyTypes) */
function strip<T extends Obj>(o: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as never;
}
