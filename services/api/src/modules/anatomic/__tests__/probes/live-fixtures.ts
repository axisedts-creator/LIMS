// C11 T-18 live fixtures: one synthetic "world" per (tenant, centre) with one row of every probed entity kind, inserted by the superuser with explicit column lists (column defaults apply;
// session_replication_role = replica via Harness.asSuperuser, so frontdesk/core FK parents are not needed). Reuses integration/setup.ts (gated on LIMS_TEST_DATABASE_URL + LIMS_TEST_APP_DATABASE_URL).
// Ids are 0190c418-0000-7000-8000-<world 1 digit><kind 2 digits><9 zeros>; world 1 = tenant A / centre A1, world 2 = tenant A / centre A2, world 3 = tenant B / centre B1. Every row is removed by wipe().
// Columns follow 05-SCHEMA §6/§7 (DDL read from spec/chunks/C11-specialty-pathology/05-SCHEMA.md). Not run in the authoring environment (no PG) — see .orchestra/notes/C11.T-18-tests.md.
import { CENTRE_A1, CENTRE_A2, CENTRE_B1, CLAIMS, SYS, TENANT_A, TENANT_B, type Harness } from '../integration/setup.js';

export const KINDS = ['case', 'part', 'block', 'slide', 'stainOrder', 'addendum', 'image', 'batch', 'template', 'stain', 'assay', 'textTemplate', 'caseItem', 'specimen', 'orderItem', 'membership', 'test', 'batchMember'] as const;
export type FxKind = (typeof KINDS)[number];
export type World = 1 | 2 | 3;
export const fx = (w: World, kind: string): string => {
  const i = KINDS.indexOf(kind as FxKind);
  if (i < 0) throw new Error(`unknown fixture kind ${kind}`);
  return `0190c418-0000-7000-8000-${w}${String(i + 1).padStart(2, '0')}000000000`;
};
export const WORLD = { 1: { tenant: TENANT_A, centre: CENTRE_A1, tag: 'A1' }, 2: { tenant: TENANT_A, centre: CENTRE_A2, tag: 'A2' }, 3: { tenant: TENANT_B, centre: CENTRE_B1, tag: 'B1' } } as const;
export const MEMB_FOR_ACTOR = { allA: '01a1a98a-ac40-7000-8000-00000000a500', a1Only: '01a1a98a-ac40-7000-8000-00000000a50a' } as const;
export const ANATOMIC_TABLES = [
  'batch_members', 'molecular_results', 'batches', 'item_submissions', 'report_versions', 'addenda', 'report_drafts', 'images', 'object_movements', 'slides', 'stain_orders', 'blocks', 'gross_records',
  'specimen_links', 'case_items', 'case_transitions', 'parts', 'cases', 'stains', 'assays', 'assay_targets', 'assay_target_values', 'test_profiles', 'synoptic_templates', 'text_templates', 'settings',
  'cs_cancel_reasons', 'cs_diagnoses', 'cs_cytology_adequacy', 'accession_counters',
] as const;
const PUB_VIEW = 'anatomic.v_pub_report_content';
export const PUBLISHED_VIEW = PUB_VIEW;

type Row = Record<string, unknown>;
async function insert(h: Harness, table: string, row: Row): Promise<void> {
  const cols = Object.keys(row);
  const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' && !Array.isArray(row[c]) ? JSON.stringify(row[c]) : row[c]));
  const ph = cols.map((c, i) => (row[c] !== null && typeof row[c] === 'object' && !Array.isArray(row[c]) ? `$${i + 1}::jsonb` : `$${i + 1}`));
  await h.asSuperuser(async (tx) => { await tx.query(`INSERT INTO anatomic.${table} (${cols.join(', ')}) VALUES (${ph.join(', ')})`, vals); });
}

export async function seedWorld(h: Harness, w: World, opts: { tenantLevel: boolean }): Promise<void> {
  const { tenant, centre, tag } = WORLD[w];
  const who = { created_by: SYS, updated_by: SYS };
  const base = { tenant_id: tenant, centre_id: centre };
  const caseId = fx(w, 'case');
  await insert(h, 'cases', { id: caseId, ...base, order_id: fx(w, 'orderItem'), patient_id: fx(w, 'specimen'), case_kind: 'histology', status: 'received', received_at: '2026-11-10T04:00:00.000Z', ...who });
  await insert(h, 'case_items', { id: fx(w, 'caseItem'), ...base, case_id: caseId, order_item_id: fx(w, 'orderItem'), test_id: fx(w, 'test'), ...who });
  await insert(h, 'parts', { id: fx(w, 'part'), ...base, case_id: caseId, letter: 'A', letter_seq: 1, ...who });
  await insert(h, 'blocks', { id: fx(w, 'block'), ...base, case_id: caseId, part_id: fx(w, 'part'), seq: 1, label: `PRB-${tag}`, ...who });
  if (opts.tenantLevel) {
    await insert(h, 'stains', { id: fx(w, 'stain'), tenant_id: tenant, code: `PROBE_${tag}`, display: `Probe stain ${tag} (SYNTHETIC)`, kind: 'special', ...who });
    await insert(h, 'assays', { id: fx(w, 'assay'), tenant_id: tenant, code: `PROBE_${tag}`, display: `Probe assay ${tag} (SYNTHETIC)`, ...who });
    await insert(h, 'synoptic_templates', { id: fx(w, 'template'), tenant_id: tenant, template_key: 'probe_tpl', version_no: 1, status: 'draft', title: `Probe template ${tag}`, applies_to_case_kinds: ['histology'], definition: { schema_version: 1 }, ...who });
    await insert(h, 'text_templates', { id: fx(w, 'textTemplate'), tenant_id: tenant, short_code: 'probe', section: 'gross', title: `Probe text ${tag}`, body: 'Synthetic text template body', ...who });
    await insert(h, 'test_profiles', { id: fx(w, 'test'), tenant_id: tenant, test_id: fx(w, 'test'), case_kind: 'histology', ...who });
    await insert(h, 'batches', { id: fx(w, 'batch'), tenant_id: tenant, batch_no: `PRBATCH-${tag}`, assay_id: fx(w, 'assay'), ...who });
  }
  const stainTenantWorld: World = tenant === TENANT_A ? 1 : 3; // world 2 shares tenant A's stain (world 1)
  await insert(h, 'slides', { id: fx(w, 'slide'), ...base, case_id: caseId, part_id: fx(w, 'part'), block_id: fx(w, 'block'), seq: 1, label: `PRS-${tag}`, stain_id: fx(stainTenantWorld, 'stain'), stain_code: `PROBE_${WORLD[stainTenantWorld].tag}`, ...who });
  await insert(h, 'stain_orders', {
    id: fx(w, 'stainOrder'), ...base, case_id: caseId, stain_id: fx(stainTenantWorld, 'stain'), stain_code: `PROBE_${WORLD[stainTenantWorld].tag}`, stain_kind: 'special', block_id: fx(w, 'block'),
    requested_at: '2026-11-10T05:00:00.000Z', requested_by_membership_id: fx(w, 'membership'), ...who,
  });
  await insert(h, 'addenda', { id: fx(w, 'addendum'), ...base, case_id: caseId, seq: 1, kind: 'other', text: 'Synthetic addendum text', ...who });
  await insert(h, 'images', { id: fx(w, 'image'), ...base, case_id: caseId, part_id: fx(w, 'part'), kind: 'gross', object_path: `${tenant}/2026/11/${fx(w, 'image')}.png`, scan_state: 'pending', ...who });
  if (opts.tenantLevel) await insert(h, 'batch_members', { id: fx(w, 'batchMember'), tenant_id: tenant, batch_id: fx(w, 'batch'), case_id: caseId, position: 1, ...who });
}

/** a SIGNED addendum for AB-10 (immutable_row) in world 1 */
export async function seedSignedAddendum(h: Harness): Promise<string> {
  const id = '0190c418-0000-7000-8000-190000000001';
  await insert(h, 'addenda', {
    id, tenant_id: TENANT_A, centre_id: CENTRE_A1, case_id: fx(1, 'case'), seq: 2, kind: 'other', text: 'Synthetic signed addendum', status: 'signed', signed_at: '2026-11-11T05:00:00.000Z',
    signed_by_membership_id: MEMB_FOR_ACTOR.allA, report_version_no: 1, created_by: SYS, updated_by: SYS,
  });
  return id;
}

export const wipe = (h: Harness) => h.asSuperuser(async (tx) => {
  for (const t of ANATOMIC_TABLES) {
    await tx.query(`DELETE FROM anatomic.${t} WHERE ${t === 'accession_counters' || t === 'settings' || t === 'assay_targets' || t === 'assay_target_values' ? 'false' : `id::text LIKE '0190c418-0000-7000-8000-%'`}`);
  }
  // rows a probe may legitimately create for tenant A itself (key-addressed upserts with tenant B's keys)
  await tx.query(`DELETE FROM anatomic.test_profiles WHERE test_id::text LIKE '0190c418-0000-7000-8000-%'`);
});

/** content hash of everything tenant B owns in the anatomic schema: a probe that changes ONE column of ONE B row changes this */
export async function snapshot(h: Harness, tenant = TENANT_B): Promise<Record<string, string>> {
  return h.asSuperuser(async (tx) => {
    const out: Record<string, string> = {};
    for (const t of ANATOMIC_TABLES) {
      const r = await tx.query(`SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM anatomic.${t} x WHERE tenant_id = $1`, [tenant]);
      out[t] = r.rows[0].h;
    }
    return out;
  });
}

export { CLAIMS, CENTRE_A1, CENTRE_A2, TENANT_A, TENANT_B };
