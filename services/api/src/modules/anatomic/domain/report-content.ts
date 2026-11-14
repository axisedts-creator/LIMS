// Report content snapshot (02-TRD §4.7; 05-SCHEMA §5 jsonb shapes; 01-PRD AC-09.1, AC-09.8, AC-09.10). PURE: no DB, no ports, no clock.
// Input rows are pre-resolved by the service; every output element carries exactly the 05-SCHEMA §5 keys (optional keys omitted when empty).
import { renderSynopticDisplay, type SynopticDisplay } from './synoptic.js';

type Obj = Record<string, unknown>;
type In = Readonly<Record<string, any>>;

export interface ContentInput {
  scope: 'full' | 'addendum_only';
  clinical_history_text?: string | null;
  draft: { gross_text?: string; microscopy_text?: string; impression_text?: string; comment_text?: string; flag?: string | null; is_critical?: boolean };
  parts: readonly In[];
  synoptic: readonly { template_key: string; template_version: number; definition: unknown; values: unknown }[];
  images: readonly In[];
  slides: readonly In[];
  ancillary: readonly In[];
  molecular: readonly In[];
  addenda: readonly In[];
  diagnosis_codes: readonly In[];
}

export interface ReportContent {
  clinical_history_text: string; gross_text: string; microscopy_text: string; impression_text: string; comment_text: string;
  flag: string | null; is_critical: boolean;
  synoptic: SynopticDisplay[]; images: Obj[]; specimen_parts: Obj[]; slides: Obj[]; ancillary: Obj[]; molecular: Obj[]; addenda: Obj[]; diagnosis_codes: Obj[];
}

const SUMMARY_MAX = 4000, SUMMARY_CUT = 3990, MARKER = ' […]';

/** 02-TRD §4.7.3: ≤ 4000 → as is; else the first 3,990 chars + " […]". A cut inside a surrogate pair drops the lone high half. */
export function summarise(text: string): string {
  if (text.length <= SUMMARY_MAX) return text;
  let cut = text.slice(0, SUMMARY_CUT);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return cut + MARKER;
}

const opt = (o: Obj, k: string, v: unknown): void => { if (v !== undefined && v !== null && v !== '') o[k] = v; };
const pick = (r: In, req: readonly string[], optional: readonly string[]): Obj => {
  const o: Obj = {};
  for (const k of req) o[k] = r[k];
  for (const k of optional) opt(o, k, r[k]);
  return o;
};
const isoUtc = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);
/** parts letter order: A…Z, then AA… (length first) */
const byLetter = (a: In, b: In) => String(a['letter']).length - String(b['letter']).length || (String(a['letter']) < String(b['letter']) ? -1 : String(a['letter']) > String(b['letter']) ? 1 : 0);

const MOLECULAR_REQ = ['assay_code', 'assay_display', 'target_code', 'target_display', 'result_code', 'result_display', 'is_abnormal'] as const;
const MOLECULAR_OPT = ['value_decimal', 'unit_code', 'method_text', 'kit_name', 'kit_lot', 'kit_expiry_on', 'batch_no', 'comment_text'] as const;

export function buildContent(i: ContentInput): ReportContent {
  const only = i.scope === 'addendum_only'; // §4.7.2: header + addenda + their ancillary only
  const d = i.draft;
  return {
    clinical_history_text: i.clinical_history_text ?? '',
    gross_text: only ? '' : d.gross_text ?? '',
    microscopy_text: only ? '' : d.microscopy_text ?? '',
    impression_text: only ? '' : d.impression_text ?? '',
    comment_text: only ? '' : d.comment_text ?? '',
    flag: d.flag ?? null,
    is_critical: d.is_critical === true,
    synoptic: only ? [] : i.synoptic.map((s) => renderSynopticDisplay(s)),
    images: only ? [] : i.images.map((m) => pick(m, [], ['bucket', 'object_path', 'sha256', 'caption'])),
    specimen_parts: [...i.parts].sort(byLetter).map((p) => pick(p, ['letter', 'site_text'], ['description_text'])),
    slides: only ? [] : i.slides.filter((s) => s['include_in_report'] === true).map((s) => pick(s, ['label', 'stain_display'], ['adequacy_display', 'finding_text'])),
    ancillary: i.ancillary.map((a) => { const o = pick(a, ['stain_kind', 'stain_code', 'stain_display'], ['block_label']); o['result_text'] = a['result_text']; return o; }),
    molecular: only ? [] : i.molecular.map((m) => pick(m, MOLECULAR_REQ, MOLECULAR_OPT)),
    addenda: [...i.addenda].sort((a, b) => Number(a['seq']) - Number(b['seq']))
      .map((a) => ({ seq: a['seq'], kind: a['kind'], text: a['text'], signed_by_membership_id: a['signed_by_membership_id'], signed_at: isoUtc(a['signed_at']) })),
    diagnosis_codes: i.diagnosis_codes.map((c) => pick(c, ['code', 'display', 'system'], ['system_version'])),
  };
}
