// C6-T07 test fixtures (tester). SYNTHETIC data only. Not a test file.
// API ASSUMED (spec gives the TemplateModule contract, 02-TRD §5.3, not file/export names):
//   ../lab/index.ts        exports labReportTemplate      : TemplateModule ('lab-report')
//   ../narrative/index.ts  exports narrativeReportTemplate: TemplateModule ('narrative-report')
//   ../preview-sample.ts   exports previewSampleDocument(): ReportDocument
//   render() input may carry `trainingMode?: boolean` (LD-26; the spec lists no other way for a template to learn the flag).
//   A config without `header_fields` prints all 11 header fields in canonical order (field-key names are not in the spec).
import { pdfPages, norm } from '../../__tests__/helpers/pdf-text.js';

/** 1x1 PNG. */
export const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

export type Ref = { source: string; id: string; sha256: string; mimeType?: string };
export const ref = (source: Ref['source'], id: string): Ref => ({ source, id, sha256: 'a'.repeat(64), mimeType: 'image/png' });

export function makeAssets() {
  const calls: Ref[] = [];
  return {
    calls,
    assets: {
      dataUri(r: Ref): string {
        calls.push(r);
        return `data:image/png;base64,${PNG_B64}`;
      },
    },
  };
}

export const FIELD_LABELS = [
  'Name', 'Age/Gender', 'Reg No', 'Barcode No', 'Sample Coll Dt', 'Sample Rcv Dt',
  'Reg Date', 'Reported Date', 'Report Status', 'Referred By', 'Sample Collected At',
] as const;

export const SIG_A = {
  membershipId: '018f0000-0000-7000-8000-00000000000a', displayName: 'Dr. Synthetic Signatory A', displayTitle: 'MD Pathology',
  registrationNo: 'NMC-SYN-0001', council: 'NMC', signatureAssetRef: ref('signature', 'sigA'), role: 'approver',
};
export const SIG_B = {
  membershipId: '018f0000-0000-7000-8000-00000000000b', displayName: 'Dr. Synthetic Signatory B', displayTitle: 'Consultant Pathologist',
  registrationNo: 'NHPC-SYN-0002', council: 'NHPC', signatureAssetRef: ref('signature', 'sigB'), role: 'approver',
};

export const line = (n: number, over: Record<string, unknown> = {}) => ({
  analyteId: `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`, resultId: `018f0000-0000-7000-9000-${String(n).padStart(12, '0')}`,
  versionNo: 1, name: `Analyte ${String(n).padStart(3, '0')}`, valueText: String(10 + n), valueBold: false,
  refRangeText: '1 - 99', unitText: 'u/L', images: [], ...over,
});

export const HB = line(1, {
  name: 'Haemoglobin', valueText: '17.9', flagLabel: 'High', valueBold: true, refRangeText: '13.0 - 17.0', unitText: 'g/dL',
  methodLine: 'METHOD : Synthetic Photometric Method',
});
export const RBC = line(2, { name: 'RBC count', valueText: '4.8', refRangeText: '4.5 - 5.9', unitText: 'x10^12/L' });
export const WBC = line(3, { name: 'WBC count', valueText: '7.1', refRangeText: '4.0 - 11.0', unitText: 'x10^9/L' });

export const cbcBlock = () => ({
  packageName: 'SYNTHETIC HEALTH PACKAGE (BASIC) (MALE)', panelName: 'CBC (Synthetic panel)',
  subgroups: [
    { subheading: 'RBC parameters', lines: [HB, RBC] },
    { subheading: 'WBC parameters', lines: [WBC] },
  ],
  specimenLine: 'EDTA WHOLE BLOOD', comments: [],
});
export const dept = (name: string, blocks: unknown[], approvedBy = ['Dr. Synthetic Signatory A']) => ({
  kind: 'department', departmentId: `018f0000-0000-7000-a000-${String(name.length).padStart(12, '0')}`, departmentName: name, approvedBy, blocks,
});
/** n plain analyte lines in one panel -> forces several A4 pages. */
export const bulkBlock = (n: number, panelName = 'BULK PANEL (SYNTHETIC)') => ({
  panelName, subgroups: [{ lines: Array.from({ length: n }, (_, i) => line(100 + i)) }], comments: [],
});

export function makeDoc(over: Record<string, unknown> = {}): any {
  return {
    schemaVersion: 1, family: 'laboratory', reportKind: 'final', statusLabel: 'Final',
    lab: {
      displayName: 'Synthetic Metro Labs', legalName: 'Synthetic Metro Labs Pvt. Ltd.', addressText: 'Synthetic Road 1, Kathmandu',
      contactStrip: ['labmail@synthetic.example', 'Tel: +977-1-0000000', 'www.synthetic.example'],
      headerAssetRef: ref('branding', 'hdr'), footerAssetRef: ref('branding', 'ftr'), logoAssetRef: ref('branding', 'logo'),
    },
    header: {
      patientName: 'Test Patient 0042', ageGender: '43 Years/MALE', regNo: '0001SY000001', barcodeNos: ['E2600000042'],
      sampleCollectedAt: '2026-11-05T02:25:00Z', sampleReceivedAt: '2026-11-05T02:55:00Z', registeredAt: '2026-11-05T02:17:00Z',
      reportedAt: '2026-11-05T04:45:00Z', referredBy: 'SELF',
      collectedAtCentre: { code: 'C000000099', name: 'SYNTHETIC CENTRE NINETY-NINE', addressText: 'Synthetic Centre Lane 99' },
    },
    calendarDisplay: 'AD', timezone: 'Asia/Kathmandu',
    sections: [dept('HAEMATOLOGY', [cbcBlock()])],
    amendmentNotes: [],
    signatories: [SIG_A, SIG_B],
    disclaimers: ['Synthetic disclaimer line one.', 'Synthetic disclaimer line two.'],
    qr: { verifyUrl: 'https://portal.example.invalid/v/AbCdEfGhIjKlMnOpQrStUv' },
    outsourcedAttachments: [], instrumentPdfAttachments: [],
    ...over,
  };
}

/** Full TemplateConfig (02-TRD §6.5, snake_case) without header_fields. */
export function makeConfig(over: Record<string, any> = {}): any {
  const base = {
    page: { size: 'A4', margin_mm: { top: 25, bottom: 25, left: 10, right: 10 } },
    letterhead: { header_asset: 'branding', footer_asset: 'branding', plain_reserve_top_mm: 30, plain_reserve_bottom_mm: 20 },
    results: { show_method_line: true, show_units_column: true, group_by_package: true, page_break_before_department: false, show_department_approved_by: true },
    signatories: { mode: 'approvers', max: 2, show_signature_images: true },
    qr: { enabled: true, size_mm: 22, caption: 'Scan to verify' },
    disclaimers: [],
    fonts: { base_pt: 9 },
    narrative: { show_images_grid_columns: 2 },
  };
  const out: any = structuredClone(base);
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === 'object' && !Array.isArray(v) && out[k] ? { ...out[k], ...v } : v;
  return out;
}

export function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
}

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
/** "<label> [:] <value>" in extracted text (label/value cell order, separator-tolerant). */
export const hasField = (text: string, label: string, value: string) => new RegExp(`${esc(label)}\\s*:?\\s*${esc(value)}`).test(text);

export type Module = { templateId: string; render(input: any): string };

export async function renderPdf(pool: any, mod: Module, input: { document: any; config?: any; variant?: 'letterhead' | 'plain'; assets?: any; [k: string]: unknown }) {
  const { assets } = input.assets ? { assets: input.assets } : makeAssets();
  const html = mod.render({ config: makeConfig(), variant: 'letterhead', ...input, assets });
  const { pdf, pageCount } = await pool.renderHtml(html);
  const pages = pdfPages(pdf).map(norm);
  return { html, pdf, pageCount: pageCount as number, pages };
}

/** Everything that could reach the network or run code must be absent from template output (REQ-SEC-086). */
export function externalRefs(html: string): string[] {
  const noData = html.replace(/data:[^"')\s>]*/gi, 'DATA');
  const found: string[] = [];
  for (const re of [/<script/i, /<link\b/i, /<iframe/i, /<object/i, /<embed/i, /@import/i, /@font-face/i, /\bon[a-z]+\s*=/i, /javascript:/i,
    /\b(?:src|href|action|poster|srcset)\s*=\s*["']?\s*(?!DATA|#)[^"'\s>]/i, /url\(\s*["']?(?!DATA)/i, /https?:\/\//i])
    if (re.test(noData)) found.push(String(re));
  return found;
}
