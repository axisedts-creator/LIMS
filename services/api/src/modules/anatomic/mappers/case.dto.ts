// CaseSummary / CaseDetail mappers (02-TRD §5.7: mappers emit exactly these field lists). Pure: no I/O, the input row is never mutated.
// Allowlist, not denylist: only the named keys are copied, so tenant_id / audit columns / cancel_reason_text / accession_series never reach the wire.
// Optional fields are omitted (never null / ''). `patient` only when the caller supplies it (REQ-SEC-081: frontdesk.patient.read holders only).
import type { Row } from '../repository/_sql.js';

type Obj = Record<string, unknown>;
export interface PatientLine { display_name: string; sex: string; age_text: string; patient_code: string }
export interface Assignee { membership_id: string; display_name: string }

export const iso = (v: unknown): string | undefined => (v instanceof Date ? v.toISOString() : typeof v === 'string' && v !== '' ? v : undefined);
const put = (o: Obj, k: string, v: unknown): void => { if (v !== null && v !== undefined && v !== '') o[k] = v; };
const num = (v: unknown): number => Number(v ?? 0);

export function toCaseSummary(r: Row, patient?: PatientLine, assignee?: Assignee): Obj {
  const o: Obj = { id: r['id'] };
  put(o, 'accession_no', r['accession_no']);
  Object.assign(o, { case_kind: r['case_kind'], status: r['status'], priority: r['priority'], centre_id: r['centre_id'], order_id: r['order_id'], patient_id: r['patient_id'] });
  if (patient) o['patient'] = { display_name: patient.display_name, sex: patient.sex, age_text: patient.age_text, patient_code: patient.patient_code };
  o['test_names'] = Array.isArray(r['test_names']) ? [...r['test_names']] : [];
  o['part_count'] = num(r['part_count']);
  put(o, 'received_at', iso(r['received_at'])); put(o, 'accessioned_at', iso(r['accessioned_at'])); put(o, 'signed_out_at', iso(r['signed_out_at']));
  if (assignee) o['assigned_pathologist'] = { membership_id: assignee.membership_id, display_name: assignee.display_name };
  o['flags'] = {
    profile_missing: !!r['profile_missing'], specimen_rejected: !!r['specimen_rejected'], open_change: !!r['open_change'],
    pending_stain_orders: num(r['pending_stain_orders']), parts_missing_site: !!r['parts_missing_site'],
  };
  o['version'] = num(r['version']);
  return o;
}

/** FrontdeskPort demographics -> CaseSummary.patient; only these four fields leave (phone, email, birth date, consents never do). */
export function toPatientLine(d: Row): PatientLine {
  const a = (d['ageAtOrder'] ?? {}) as Row;
  const age = num(a['years']) > 0 ? `${num(a['years'])}y` : num(a['months']) > 0 ? `${num(a['months'])}m` : `${num(a['days'])}d`;
  return { display_name: String(d['fullName'] ?? ''), sex: String(d['sex'] ?? ''), age_text: age, patient_code: String(d['patientCode'] ?? '') };
}

// ---- CaseDetail sections (§5.7) ----
export function toGross(g: Row, byName: string | undefined): Obj {
  const o: Obj = { part_id: g['part_id'], gross_text: g['gross_text'] ?? '', is_complete: !!g['is_complete'], grossed_by_display_name: byName ?? '', version: num(g['version']) };
  put(o, 'pieces_count', g['pieces_count']); put(o, 'dimensions_mm', g['dimensions_mm']); put(o, 'weight_g', g['weight_g']);
  put(o, 'completed_at', iso(g['completed_at'])); put(o, 'updated_at', iso(g['updated_at']));
  return o;
}
export function toPart(p: Row, gross?: Obj): Obj {
  const o: Obj = { id: p['id'], letter: p['letter'] };
  put(o, 'site_text', p['site_text']); put(o, 'description_text', p['description_text']); put(o, 'specimen_id', p['specimen_id']); put(o, 'specimen_type_code', p['specimen_type_code']);
  o['specimen_state'] = p['specimen_state'] ?? 'none';
  if (gross) o['gross'] = gross;
  o['version'] = num(p['version']);
  return o;
}
export function toBlock(b: Row, slideCount: number): Obj {
  const o: Obj = { id: b['id'], part_id: b['part_id'], label: b['label'], seq: num(b['seq']), location_status: b['location_status'], slide_count: slideCount, version: num(b['version']) };
  put(o, 'note', b['note']); put(o, 'location_text', b['location_text']);
  return o;
}
export function toSlide(s: Row, stainDisplay: string | undefined): Obj {
  const o: Obj = {
    id: s['id'], label: s['label'], part_id: s['part_id'], stain_code: s['stain_code'], stain_display: stainDisplay ?? s['stain_code'], status: s['status'],
    location_status: s['location_status'], include_in_report: !!s['include_in_report'], version: num(s['version']),
  };
  put(o, 'block_id', s['block_id']); put(o, 'location_text', s['location_text']); put(o, 'stain_order_id', s['stain_order_id']);
  put(o, 'adequacy_code', s['adequacy_code']); put(o, 'finding_text', s['finding_text']);
  return o;
}
export function toStainOrder(s: Row, stainDisplay: string | undefined, blockLabel: string | undefined, byName: string | undefined): Obj {
  const o: Obj = {
    id: s['id'], stain_code: s['stain_code'], stain_display: stainDisplay ?? s['stain_code'], stain_kind: s['stain_kind'], status: s['status'],
    requested_at: iso(s['requested_at']), requested_by_display_name: byName ?? '', version: num(s['version']),
  };
  put(o, 'block_id', s['block_id']); put(o, 'block_label', blockLabel); put(o, 'part_id', s['part_id']); put(o, 'note', s['note']); put(o, 'reagent_lot', s['reagent_lot']);
  put(o, 'addon_order_item_id', s['addon_order_item_id']); put(o, 'completed_at', iso(s['completed_at']));
  return o;
}
export function toImage(i: Row): Obj {
  const o: Obj = { id: i['id'], kind: i['kind'], state: i['state'], is_active: !!i['is_active'], version: num(i['version']) };
  put(o, 'part_id', i['part_id']); put(o, 'caption', i['caption']); put(o, 'mime_type', i['mime_type']); put(o, 'width_px', i['width_px']); put(o, 'height_px', i['height_px']);
  put(o, 'created_at', iso(i['created_at']));
  return o;
}
export function toAddendum(a: Row, signedBy: string | undefined): Obj {
  const o: Obj = { id: a['id'], kind: a['kind'], text: a['text'] ?? '', stain_order_ids: Array.isArray(a['stain_order_ids']) ? [...a['stain_order_ids']] : [], status: a['status'], version: num(a['version']) };
  put(o, 'addon_case_item_id', a['addon_case_item_id']); put(o, 'signed_at', iso(a['signed_at'])); put(o, 'signed_by_display_name', signedBy); put(o, 'report_version_no', a['report_version_no']);
  return o;
}
export interface LabStatus { status: string; versionNo: number }
export function toItem(it: Row, testName: string | undefined, lab: LabStatus | undefined, lastSubmitted: number | undefined): Obj {
  const o: Obj = { case_item_id: it['id'], order_item_id: it['order_item_id'], test_id: it['test_id'], test_name: testName ?? '', role: it['role'], is_active: !!it['is_active'] };
  if (lab) { o['lab_status'] = lab.status; o['lab_version_no'] = lab.versionNo; } // absent without lab.result.read or without a module result
  if (lastSubmitted !== undefined) o['last_submitted_version_no'] = lastSubmitted;
  return o;
}
export function toTransition(t: Row, byName: string): Obj {
  const o: Obj = {};
  put(o, 'from_status', t['from_status']);
  Object.assign(o, { to_status: t['to_status'], at: iso(t['created_at']), by_display_name: byName });
  return o;
}
/** open draft summary: kind, version, updated_at only — never draft text */
export const toOpenDraft = (d: Row): Obj => ({ kind: d['kind'], version: num(d['version']), updated_at: iso(d['updated_at']) });
