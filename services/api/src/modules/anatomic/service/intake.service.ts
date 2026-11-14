// Intake — consumer logic of lab.specimen.status_changed.v1 (02-TRD §4.1, 4.1.1, 4.1.2; AC-01.1…01.10).
// Runs inside the worker consumer wrapper's transaction (inbox insert + envelope validation are the wrapper's, never here). Repositories only, no raw SQL.
// Every port call happens before the first write, so a port failure leaves nothing behind and the job retries. Every specimen_links write carries an explicit link_kind.
import { LimsError } from '../../../core/errors.js';
import { uuidv7 } from '../../../../../../packages/shared-ts/src/uuidv7/index.js';
import type { CaseKind } from '../domain/case.js';
import { partLetter } from '../domain/labels.js';
import { getCase, insertCase, insertCaseItem, insertCaseTransition, listCasesByOrder, updateCase } from '../repository/cases.repo.js';
import { getSettings, getTestProfileByTestId } from '../repository/config.repo.js';
import { getPart, insertPart, listParts, updatePart } from '../repository/parts.repo.js';
import { getSpecimenLinkBySpecimen, insertSpecimenLink, updateSpecimenLink } from '../repository/specimenLinks.repo.js';
import type { Row } from '../repository/_sql.js';
import { allocateAccessionNumber, type AnatomicCtx } from './numbering.service.js';

type Obj = Record<string, any>;
type LinkKind = 'part' | 'addon' | 'aliquot_ignored' | 'not_anatomic';
interface Target { kind: LinkKind; caseId: string | null; partId: string | null }

/** Worker JobContext (now() is an ISO string) + the ports/metrics the consumer needs. */
export type IntakeCtx = Omit<AnatomicCtx, 'now' | 'ports'> & {
  now(): string;
  readonly metrics?: { inc?(name: string, labels?: Record<string, string>): void };
  readonly ports: AnatomicCtx['ports'] & {
    readonly FrontdeskPort: { getOrderSummary(ctx: unknown, i: { orderId: string }): Promise<{ items: ReadonlyArray<Obj> }> };
    readonly CatalogPort: { getTest(ctx: unknown, i: { testId: string }): Promise<{ workflowType?: string }> };
  };
};

const CLOSED = ['signed_out', 'cancelled'];
const MAX_PARTS = 52;
const isOpen = (c: Row): boolean => !CLOSED.includes(c['status']);
const metric = (ctx: IntakeCtx, reason: string): void => ctx.metrics?.inc?.('lims_anatomic_consumer_ignored_total', { reason });

export async function onSpecimenStatusChanged(ctx: IntakeCtx, env: Obj): Promise<void> {
  const tenantId = ctx.tenantId;
  if (!tenantId || env['tenant_id'] !== tenantId) throw new LimsError('common.internal', 'event tenant does not match the job tenant');
  const p: Obj = env['payload'];
  const seq = Number(env['aggregate'].seq);
  const specimenId: string = p['specimen_id'];
  const toStatus: string = p['to_status'];
  const tx = ctx.tx;
  const actorId = ctx.actor.id;

  const link = await getSpecimenLinkBySpecimen(tx, { tenantId, specimenId, forUpdate: true });
  if (link && seq <= Number(link['last_seq'])) { metric(ctx, 'stale'); return; } // AC-01.5 (also covers a replay of the same seq)

  let target: Target = { kind: (link?.['link_kind'] as LinkKind | undefined) ?? 'not_anatomic', caseId: link?.['case_id'] ?? null, partId: link?.['part_id'] ?? null };

  if (toStatus === 'received') {
    target = await onReceived(ctx, p, link);
  } else if (toStatus === 'rejected' && link?.['link_kind'] === 'part' && link['part_id']) { // AC-01.9
    const part = await getPart(tx, { tenantId, id: link['part_id'] });
    if (part && part['specimen_state'] !== 'rejected') {
      if (!(await updatePart(tx, { tenantId, id: part['id'], expectedVersion: Number(part['version']), actorId, patch: { specimen_state: 'rejected' } }))) throw new LimsError('common.version_conflict');
    }
  }

  const fields = { link_kind: target.kind, case_id: target.caseId, part_id: target.partId, last_seq: seq, last_status: toStatus };
  if (link) {
    if (!(await updateSpecimenLink(tx, { tenantId, id: link['id'], expectedVersion: Number(link['version']), actorId, patch: fields }))) throw new LimsError('common.version_conflict');
  } else {
    await insertSpecimenLink(tx, { id: uuidv7(), tenant_id: tenantId, centre_id: p['centre_id'], specimen_id: specimenId, ...fields, created_by: actorId, updated_by: actorId });
  }
}

async function onReceived(ctx: IntakeCtx, p: Obj, link: Row | undefined): Promise<Target> {
  const tenantId = ctx.tenantId as string;
  const tx = ctx.tx;

  // 3a. aliquot of an already-linked specimen: ignored (DECISION §4.1.1)
  if (p['parent_specimen_id'] && (await getSpecimenLinkBySpecimen(tx, { tenantId, specimenId: p['parent_specimen_id'] }))) {
    metric(ctx, 'aliquot');
    return { kind: 'aliquot_ignored', caseId: null, partId: null };
  }

  // 3b-d. candidate items, anatomic/molecular only (all port calls, no writes yet)
  const order = await ctx.ports.FrontdeskPort.getOrderSummary(ctx, { orderId: p['order_id'] });
  const wanted: readonly string[] | undefined = Array.isArray(p['order_item_ids']) ? p['order_item_ids'] : undefined;
  const workflow = new Map<string, string | undefined>();
  const kept: Array<{ item: Obj; testId: string; profile: Row | undefined; caseKind: CaseKind }> = [];
  for (const item of order.items) {
    if (item['status'] !== 'active' || (wanted && !wanted.includes(item['orderItemId']))) continue;
    for (const testId of item['testIds'] as string[]) {
      if (!workflow.has(testId)) workflow.set(testId, (await ctx.ports.CatalogPort.getTest(ctx, { testId })).workflowType);
      const wf = workflow.get(testId);
      if (wf !== 'anatomic' && wf !== 'molecular') continue;
      const profile = await getTestProfileByTestId(tx, { tenantId, testId }); // 3e
      kept.push({ item, testId, profile, caseKind: (profile?.['case_kind'] ?? (wf === 'molecular' ? 'molecular' : 'histology')) as CaseKind });
      break; // one case_items row per order item (unique tenant + order_item_id): the first anatomic test of a panel decides [CONV]
    }
  }
  if (kept.length === 0) { // AC-01.4
    metric(ctx, 'no_anatomic_items');
    // 02-TRD §4.1 3d: none kept → kind := 'not_anatomic' (parts.specimen_id keeps the part→specimen mapping)
    return { kind: 'not_anatomic', caseId: null, partId: null };
  }

  const groups = new Map<CaseKind, typeof kept>();
  for (const k of kept) groups.set(k.caseKind, [...(groups.get(k.caseKind) ?? []), k]);

  let settings: Row | undefined, settingsRead = false;
  let result: Target | undefined;
  for (const [caseKind, entries] of groups) {
    const t = await applyGroup(ctx, p, caseKind, entries, async () => { if (!settingsRead) { settings = await getSettings(tx, { tenantId }); settingsRead = true; } return settings; });
    if (!result || (result.kind === 'addon' && t.kind === 'part')) result = t; // the link points to the first part; an addon link only when no part was set
  }
  return result as Target;
}

async function applyGroup(
  ctx: IntakeCtx, p: Obj, caseKind: CaseKind,
  entries: Array<{ item: Obj; testId: string; profile: Row | undefined }>, loadSettings: () => Promise<Row | undefined>,
): Promise<Target> {
  const tenantId = ctx.tenantId as string;
  const tx = ctx.tx;
  const actorId = ctx.actor.id;
  const orderId: string = p['order_id'];
  const openCase = (rows: Row[]): Row | undefined => rows.find((r) => r['case_kind'] === caseKind && isOpen(r));
  const roleOf = (e: { profile: Row | undefined }) => (e.profile?.['is_addon'] === true ? 'addon' : 'primary');
  const addItems = async (caseRow: Row): Promise<void> => {
    for (const e of entries) {
      await insertCaseItem(tx, { id: uuidv7(), tenant_id: tenantId, centre_id: caseRow['centre_id'], case_id: caseRow['id'], order_item_id: e.item['orderItemId'], test_id: e.testId, role: roleOf(e), created_by: actorId, updated_by: actorId });
    }
  };

  let existing = openCase(await listCasesByOrder(tx, { tenantId, orderId }));

  // 3f. add-on items received as their own specimen join the open case without a part
  if (existing && entries.every((e) => roleOf(e) === 'addon')) {
    await addItems(existing);
    return { kind: 'addon', caseId: existing['id'], partId: null };
  }

  // find-or-create the open case; the case row lock serialises concurrent specimens of one order (part letters, one accession number)
  let cs: Row | undefined;
  for (let n = 0; !cs && n < 3; n++) {
    if (existing) {
      const locked = await getCase(tx, { tenantId, caseId: existing['id'], forUpdate: true });
      if (locked && isOpen(locked)) cs = locked;
      existing = undefined;
    }
    cs ??= await insertCase(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: p['centre_id'], branch_id: p['processing_branch_id'] ?? null, order_id: orderId, patient_id: p['patient_id'], case_kind: caseKind,
      status: 'received', priority: entries.some((e) => e.item['priority'] === 'urgent') ? 'urgent' : 'routine', profile_missing: entries.some((e) => !e.profile),
      received_at: ctx.now(), created_by: actorId, updated_by: actorId,
    });
    if (!cs) existing = openCase(await listCasesByOrder(tx, { tenantId, orderId })); // lost the insert race: re-select, lock on the next pass
  }
  if (!cs) throw new LimsError('common.internal');

  // part: reuse this specimen's part, else take over the rejected specimen's part (AC-01.10), else the next letter (AC-01.3)
  const parts = await listParts(tx, { tenantId, caseId: cs['id'] });
  const state = { specimen_state: 'received' };
  let part = parts.find((x) => x['specimen_id'] === p['specimen_id']);
  const old = part ? undefined : p['replaces_specimen_id'] ? parts.find((x) => x['specimen_id'] === p['replaces_specimen_id']) : undefined;
  if (part && part['specimen_state'] !== 'received') {
    part = await updatePart(tx, { tenantId, id: part['id'], expectedVersion: Number(part['version']), actorId, patch: state });
    if (!part) throw new LimsError('common.version_conflict');
  } else if (old) {
    part = await updatePart(tx, { tenantId, id: old['id'], expectedVersion: Number(old['version']), actorId, patch: { specimen_id: p['specimen_id'], ...(p['specimen_type_code'] ? { specimen_type_code: p['specimen_type_code'] } : {}), ...state } });
    if (!part) throw new LimsError('common.version_conflict');
  } else if (!part) {
    const letterSeq = parts.reduce((m, x) => Math.max(m, Number(x['letter_seq'])), 0) + 1;
    if (letterSeq > MAX_PARTS) throw new LimsError('common.internal');
    part = await insertPart(tx, {
      id: uuidv7(), tenant_id: tenantId, centre_id: cs['centre_id'], case_id: cs['id'], letter: partLetter(letterSeq), letter_seq: letterSeq, specimen_id: p['specimen_id'],
      specimen_type_code: p['specimen_type_code'] ?? null, ...state, created_by: actorId, updated_by: actorId,
    });
  }

  await addItems(cs);

  // 3f. auto accession in the same transaction; a case another specimen already accessioned keeps its number (AC-01.8)
  if (cs['status'] === 'received' && (await loadSettings())?.['auto_accession_on_receipt'] === true) {
    const nctx = { ...ctx, now: () => new Date(ctx.now()) } as unknown as AnatomicCtx;
    const no = await allocateAccessionNumber(nctx, { caseKind, branchId: cs['branch_id'] ?? null });
    const updated = await updateCase(tx, {
      tenantId, id: cs['id'], expectedVersion: Number(cs['version']), actorId,
      patch: { accession_no: no.accessionNo, accession_series: no.seriesKey, accession_year: no.yearAd, status: 'accessioned', accessioned_at: ctx.now(), accessioned_by: actorId },
    });
    if (!updated) throw new LimsError('common.version_conflict');
    await insertCaseTransition(tx, { id: uuidv7(), tenant_id: tenantId, centre_id: cs['centre_id'], case_id: cs['id'], from_status: 'received', to_status: 'accessioned', created_by: actorId });
  }
  return { kind: 'part', caseId: cs['id'], partId: (part as Row)['id'] };
}
