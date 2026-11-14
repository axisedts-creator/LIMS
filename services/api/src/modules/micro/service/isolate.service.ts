// M7 createIsolate, M8 identifyIsolate, M9 describeIsolate, M10 withdrawIsolate (02-TRD §5, §12, §13; 03-APP-FLOW §2.1 C3, §2.2 I1–I4; PRD AC-05.1–05.5; 08 A17 P-22; 07-SECURITY S-01, S-03, S-05).
// Same shape as T-08: the object is loaded FIRST (RLS + tenant; absent = 404, same as another tenant's), THEN IdentityPort.assertRole(micro.culture.work, object.centre_id) (02-CV §10.1).
// M7 locks the culture FOR UPDATE and numbers with the single counter upsert (isolates.repo nextIsolateSeq); M8–M10 read the isolate unlocked, then lock its culture, then re-read the isolate FOR UPDATE (same order as M4–M7: no 40P01 with M4 source_isolate_id), and take If-Match "<isolate version>".
// Every refusal throws before or instead of a partial write (the request transaction rolls back, counter bump included). Error bodies are fixed text; nothing submitted is logged.
// [CONV] ETag "<isolate version>" on M7–M10; an instrument-sourced identification re-identified by hand becomes organism_source 'manual'; counter past 99 = 400 common.validation_failed;
// isolates of a cancelled culture = 409 micro.culture_invalid_transition (assertCultureChildEditable); unknown/inactive withdraw reason = 400 /reason_code.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import { assertCultureChildEditable, nextCultureStatus, type CultureStatus } from '../domain/culture.state.js';
import { initialIsolateStatus, nextIsolateStatus, type IsolateStatus } from '../domain/isolate.state.js';
import * as dto from '../mappers/culture.dto.js';
import * as sets from '../repository/codedsets.repo.js';
import * as cultureRepo from '../repository/cultures.repo.js';
import * as repo from '../repository/isolates.repo.js';
import * as obsRepo from '../repository/observations.repo.js';
import { bad, code, conflict, guarded, isObj, loadForWork, needVersion, nowOf, sameCulture, str, strictKeys, uuid, WORK, type WriteCtx } from './culture.service.js';

type Obj = Record<string, any>;
type Out = { body: Obj; version?: number };

/** Active organism of the resolved set (tenant over global) or 422 micro.organism_code_unknown (AC-05.2). */
async function organism(tx: any, tenantId: string, organismCode: string): Promise<string> {
  const r = (await sets.codeRows(tx, { view: 'organisms', tenantId, codes: [organismCode] })).get(organismCode);
  if (r?.['is_active'] !== true) throw new LimsError('micro.organism_code_unknown');
  return String(r['display']);
}

/** IsolateDto of a stored isolate row: organism_display + the isolate's AST rows (read-only here; M8–M10 never change them). */
export async function answer(c: WriteCtx, tx: any, tenantId: string, row: Obj, display: string | undefined, withAst: boolean): Promise<Out> {
  let ast: Obj[] = [];
  let panel: Obj | undefined;
  if (withAst) {
    const mine = (await cultureRepo.listAst(tx, { tenantId, cultureId: row['culture_id'] })).filter((a) => a['isolate_id'] === row['id']);
    const names = await cultureRepo.antibioticDisplays(tx, tenantId, [...new Set(mine.map((a) => a['antibiotic_code']).filter((x): x is string => typeof x === 'string'))]);
    ast = mine.map((a) => dto.astDto(a, names.get(a['antibiotic_code']) ?? a['antibiotic_code']));
    if (row['ast_panel_id']) panel = (await cultureRepo.astPanels(tx, tenantId, [row['ast_panel_id']]))[0];
    if (display === undefined && row['organism_code']) display = (await sets.codeRows(tx, { view: 'organisms', tenantId, codes: [row['organism_code']] })).get(row['organism_code'])?.['display'];
  }
  return { body: dto.isolateDto(row, display, panel, ast), version: Number(row['version']) };
}

// ---------------------------------------------------------------- M7
export async function createIsolate(c: WriteCtx, input: { params: unknown; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row } = await loadForWork(c, input.params);   // culture FOR UPDATE, then micro.culture.work
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['plate_id', 'colony_description', 'quantity_text', 'organism_code']);   // S-05: no isolate_seq / status / organism_source / ids
  const plateId = b['plate_id'] === undefined ? null : uuid(b['plate_id'], '/plate_id');
  const colony = b['colony_description'] === undefined ? null : str(b['colony_description'], '/colony_description', 500);
  const quantity = b['quantity_text'] === undefined ? null : str(b['quantity_text'], '/quantity_text', 80);
  const organismCode = b['organism_code'] === undefined ? null : code(b['organism_code'], '/organism_code');

  const status = row['status'] as CultureStatus;
  const isolateStatus = initialIsolateStatus({ cultureStatus: status, organismId: organismCode });   // I1: final -> report_final_locked; awaiting_setup / cancelled -> culture_invalid_transition
  const display = organismCode === null ? undefined : await organism(tx, tenantId, organismCode);
  const cultureId = row['id'] as string;
  if (plateId !== null) sameCulture(await obsRepo.ownerOfPlate(tx, { tenantId, id: plateId }), cultureId);   // 404 / 400 common.id_mismatch (S-03)

  const now = nowOf(c);
  const membershipId = c.actor.membershipId ?? null;
  const made = await guarded(async () => {
    let seq: number;
    try { seq = await repo.nextIsolateSeq(tx, { tenantId, specimenId: row['specimen_id'], userId }); } catch (e) {
      if ((e as { code?: unknown } | null)?.code === '23514') bad('/');   // specimen_isolate_counters__seq__ck: 99 isolates per specimen
      throw e;
    }
    const isolate = await repo.insertIsolate(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, specimenId: row['specimen_id'], seq, plateId, status: isolateStatus,
      organismCode, identifiedAt: organismCode === null ? null : now, membershipId, colony, quantity, userId });
    if (status === 'incubating') {                                                                  // C3: first isolate = growth_detected
      const to = nextCultureStatus(status, 'growth');
      await cultureRepo.updateAfterRead(tx, { tenantId, id: cultureId, status: to, nextReadDueAt: row['next_read_due_at'] == null ? null : new Date(row['next_read_due_at']), userId });
      await cultureRepo.insertTransition(tx, { id: uuidv7(), tenantId, centreId: row['centre_id'], cultureId, from: status, to, reason: null, occurredAt: now.toISOString(), userId });
    }
    return isolate;
  });
  return answer(c, tx, tenantId, made, display, false);
}

// ---------------------------------------------------------------- M8–M10 shared: isolate first, then permission, then culture state
async function loadIsolate(c: WriteCtx, params: unknown, ifMatch: number | undefined): Promise<{ tx: any; tenantId: string; userId: string; row: Obj; expected: number }> {
  if (typeof c?.tenantId !== 'string' || typeof c.actor?.id !== 'string' || !c.tx) throw new LimsError('auth.unauthenticated');
  const id = uuid(isObj(params) ? params['isolate_id'] : undefined, '/isolate_id').toLowerCase();
  const row = await repo.getIsolate(c.tx as any, { tenantId: c.tenantId, id });   // unlocked: culture is locked first (review T-09 #1)
  if (!row) throw new LimsError('common.not_found');
  const identity = c.ports?.IdentityPort;
  if (!identity) throw new LimsError('auth.forbidden');   // fail closed
  await identity.assertRole(c, { permission: WORK, centreId: row['centre_id'] });
  return { tx: c.tx, tenantId: c.tenantId, userId: c.actor.id, row, expected: needVersion(ifMatch) };
}

/** The culture decides first (final -> report_final_locked, cancelled -> culture_invalid_transition), then the isolate's own state, then the version. */
async function assertEditable(tx: any, tenantId: string, read: Obj, expected: number, action: 'identify' | 'describe' | 'withdraw'): Promise<void> {
  const culture = await cultureRepo.lockCulture(tx, { tenantId, id: read['culture_id'] });   // culture FOR UPDATE first, then the isolate (lock order of every culture write)
  if (!culture) throw new LimsError('common.not_found');
  const row = await repo.getIsolateForUpdate(tx, { tenantId, id: read['id'] });
  if (!row) throw new LimsError('common.not_found');
  assertCultureChildEditable(culture['status'] as CultureStatus);
  if (Number(row['version']) !== expected) conflict();                                       // AC-05.3 / If-Match
  if (action === 'describe') { if (row['status'] === 'withdrawn') nextIsolateStatus('withdrawn', 'identify'); }   // withdrawn is terminal: throws micro.isolate_invalid_transition
  else nextIsolateStatus(row['status'] as IsolateStatus, action);
}

// ---------------------------------------------------------------- M8
export async function identifyIsolate(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row, expected } = await loadIsolate(c, input.params, input.ifMatch);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['organism_code']);
  const organismCode = code(b['organism_code'], '/organism_code');
  await assertEditable(tx, tenantId, row, expected, 'identify');
  const display = await organism(tx, tenantId, organismCode);
  const done = await guarded(() => repo.identify(tx, { tenantId, id: row['id'], expectedVersion: expected, organismCode, at: nowOf(c), membershipId: c.actor.membershipId ?? null, userId }));
  if (!done) return conflict();
  return answer(c, tx, tenantId, done, display, true);                                        // AC-05.3: the audit old/new is the DB trigger
}

// ---------------------------------------------------------------- M9
export async function describeIsolate(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row, expected } = await loadIsolate(c, input.params, input.ifMatch);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['colony_description', 'quantity_text', 'is_reportable', 'plate_id']);
  const isReportable = typeof b['is_reportable'] === 'boolean' ? b['is_reportable'] : bad('/is_reportable');
  const colony = b['colony_description'] === undefined ? null : str(b['colony_description'], '/colony_description', 500);   // full replace: omitted = cleared
  const quantity = b['quantity_text'] === undefined ? null : str(b['quantity_text'], '/quantity_text', 80);
  const plateId = b['plate_id'] === undefined ? null : uuid(b['plate_id'], '/plate_id');
  await assertEditable(tx, tenantId, row, expected, 'describe');
  if (plateId !== null) sameCulture(await obsRepo.ownerOfPlate(tx, { tenantId, id: plateId }), row['culture_id'] as string);   // 404 / 400 common.id_mismatch (S-03)
  const done = await guarded(() => repo.describe(tx, { tenantId, id: row['id'], expectedVersion: expected, colony, quantity, isReportable, plateId, userId }));
  if (!done) return conflict();
  return answer(c, tx, tenantId, done, undefined, true);
}

// ---------------------------------------------------------------- M10
export async function withdrawIsolate(c: WriteCtx, input: { params: unknown; ifMatch: number | undefined; body: unknown }): Promise<Out> {
  const { tx, tenantId, userId, row, expected } = await loadIsolate(c, input.params, input.ifMatch);
  const b = isObj(input.body) ? input.body : bad('/');
  strictKeys(b, ['reason_code', 'comment']);
  const reasonCode = code(b['reason_code'], '/reason_code');
  const comment = b['comment'] === undefined ? null : str(b['comment'], '/comment', 500);
  await assertEditable(tx, tenantId, row, expected, 'withdraw');
  if ((await sets.codeRows(tx, { view: 'isolate_withdraw_reasons', tenantId, codes: [reasonCode] })).get(reasonCode)?.['is_active'] !== true) bad('/reason_code');
  const done = await guarded(() => repo.withdraw(tx, { tenantId, id: row['id'], expectedVersion: expected, reasonCode, comment, userId }));
  if (!done) return conflict();
  return answer(c, tx, tenantId, done, undefined, true);                                      // AST rows stay; snapshots exclude withdrawn isolates by status
}
