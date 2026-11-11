// micro / anatomic sections of lab-report (02-TRD §3.2: `content` = a row of micro./anatomic.v_pub_report_content, 03-IC §6.8;
// jsonb shapes: C10 05-SCHEMA §6, C11 05-SCHEMA §5). Pure. All values are plain text and go through esc(); images only via assets.dataUri().
import type { AssetResolver, Section } from '../contract.js';
import { dataImage, esc } from './shared.js';

type Row = Record<string, unknown>;
type MicroSection = Extract<Section, { kind: 'micro' }>;
type AnatomicSection = Extract<Section, { kind: 'anatomic' }>;

const rec = (v: unknown): Row => (v && typeof v === 'object' ? (v as Row) : {});
const list = (v: unknown): Row[] => (Array.isArray(v) ? v.map(rec) : []);
const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const UNIT: Record<string, string> = { mic: 'µg/mL', zone_diameter: 'mm' };
const CASE_KIND: Record<string, string> = { histology: 'Histology', cytology: 'Cytology', ihc: 'IHC', molecular: 'Molecular' };

const row = (cls: string, span: number, text: string) => `<tr class="${cls}"><td colspan="${span}">${esc(text)}</td></tr>`;
const para = (span: number, label: string, text: unknown) => (str(text).trim()
  ? `<tr class="keep"><td colspan="${span}"><b>${esc(label)}</b><div style="white-space:pre-wrap">${esc(text)}</div></td></tr>` : '');

/** Isolates by seq, then the AST table per isolate (antibiotic | raw value + unit by method | category), then the standard(s) used. */
export function microRows(s: MicroSection, span: number): string {
  const c = rec(s.content);
  const wide = Math.max(span - 2, 1);
  let out = row('dept hd', span, s.phase === 'preliminary' ? `${s.testName} — Preliminary` : s.testName);
  out += para(span, 'Culture', c['culture_summary_text']);
  const isolates = list(c['isolates']).sort((a, b) => Number(a['seq']) - Number(b['seq']));
  const ast = list(c['ast']);
  for (const iso of isolates) {
    out += row('panel hd', span, [str(iso['organism_display']), str(iso['growth_text'])].filter(Boolean).join(' — '));
  }
  for (const iso of isolates) {
    const mine = ast.filter((a) => a['isolate_seq'] === iso['seq']);
    if (!mine.length) continue;
    out += row('sub hd', span, `Antibiotic susceptibility — ${str(iso['organism_display'])}`);
    for (const a of mine) {
      const unit = UNIT[str(a['method'])];
      out += `<tr class="an"><td>${esc(a['antibiotic_display'])}</td><td>${esc(a['raw_value'])}${unit ? ` ${esc(unit)}` : ''}</td><td colspan="${wide}">${esc(a['category_code'])} <span class="cmt">${esc([str(a['standard']), str(a['standard_version'])].filter(Boolean).join(' '))}</span></td></tr>`;
    }
  }
  return out + para(span, 'Comments', c['comments_text']);
}

/** Clinical history, specimen parts, gross, microscopy, slides, ancillary, molecular, synoptic, impression, diagnosis codes, comment, images, addenda (oldest first). */
export function anatomicRows(s: AnatomicSection, span: number, assets: AssetResolver): string {
  const c = rec(s.content);
  const kind = str(c['case_kind']);
  let out = row('dept hd', span, s.testName) + row('keep', span, [`Accession: ${str(c['accession_no'])}`, CASE_KIND[kind] ?? kind].filter(Boolean).join(' — '));
  out += para(span, 'Clinical history', c['clinical_history_text']);
  for (const p of list(c['specimen_parts'])) out += row('keep', span, `Part ${str(p['letter'])}: ${[str(p['site_text']), str(p['description_text'])].filter(Boolean).join(' — ')}`);
  out += para(span, 'Gross', c['gross_text']) + para(span, 'Microscopy', c['microscopy_text']);
  for (const sl of list(c['slides'])) out += row('cm', span, `Slide ${str(sl['label'])}: ${[str(sl['stain_display']), str(sl['adequacy_display']), str(sl['finding_text'])].filter(Boolean).join(' — ')}`);
  for (const an of list(c['ancillary'])) out += row('cm', span, `${str(an['stain_display'])}${an['block_label'] ? ` (block ${str(an['block_label'])})` : ''}: ${str(an['result_text'])}`);
  for (const m of list(c['molecular'])) {
    const value = [str(m['value_decimal']), str(m['unit_code'])].filter(Boolean).join(' ');
    out += row('cm', span, `${str(m['assay_display'])} / ${str(m['target_display'])}: ${str(m['result_display'])}${value ? ` (${value})` : ''}${m['is_abnormal'] === true ? ' — abnormal' : ''}${m['comment_text'] ? ` — ${str(m['comment_text'])}` : ''}`);
  }
  for (const syn of list(c['synoptic'])) {
    out += row('sub hd', span, str(syn['title']));
    for (const sec of list(syn['sections'])) {
      out += row('keep', span, str(sec['heading']));
      for (const it of list(sec['items'])) out += row('cm', span, `${str(it['label'])}: ${str(it['value'])}`);
    }
  }
  out += para(span, 'Impression', c['impression_text']);
  for (const d of list(c['diagnosis_codes'])) out += row('cm', span, `${str(d['display'])} (${str(d['code'])})`);
  out += para(span, 'Comment', c['comment_text']);
  for (const im of list(c['images'])) {
    const sha = str(im['sha256']);
    out += `<tr class="keep"><td colspan="${span}"><img src="${dataImage(assets, { source: 'module_image', id: sha, sha256: sha })}" alt="" style="max-width:70mm;max-height:50mm;object-fit:contain">` +
      `${im['caption'] ? `<div class="cmt">${esc(im['caption'])}</div>` : ''}</td></tr>`;
  }
  for (const a of list(c['addenda']).sort((x, y) => Number(x['seq']) - Number(y['seq']))) out += para(span, `Addendum ${str(a['seq'])} (${str(a['kind'])})`, a['text']);
  return out;
}
