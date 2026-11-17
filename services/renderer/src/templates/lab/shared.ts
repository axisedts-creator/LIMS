// Shared print layout for lab-report and narrative-report (04-UI-UX §3.1/§3.2; technique: services/renderer/DECISIONS.md
// thead-tfoot for the repeated header/footer, position:fixed for the watermark). Output is static HTML: no script, no
// external URL, no @font-face (REQ-SEC-086; fonts are the bundled system fonts, 02-TRD §5.1).
import { formatAd, formatBs, instantToBs, type IsoUtc } from '../../../../../packages/shared-ts/src/bsdate/index.js';
import type { AssetRef, AssetResolver, ReportDocument, RenderInput, Signatory } from '../contract.js';
import { HEADER_FIELD_KEYS, type HeaderFieldKey } from '../contract.js';
import { pageRules } from '../print-plain/index.js';
import { qrDataUri } from './qr.js';

/** Escapes text for element content and attribute values. Beyond the HTML five, `= : / ( ) @ \` and backtick are entity-encoded so
 *  untrusted text can never read as an attribute, URL, CSS function or at-rule in the source (07-SECURITY T8). */
export const esc = (v: unknown): string =>
  String(v ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[&<>"'`=:/()@\\]/g, (c) => `&#${c.charCodeAt(0)};`);

const DATA_IMG = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
/** The resolver's data: URI is the only possible image source; anything else is a resolver bug and fails the render. */
export function dataImage(assets: AssetResolver, ref: AssetRef): string {
  const uri = assets.dataUri(ref);
  if (typeof uri !== 'string' || !DATA_IMG.test(uri)) throw new Error('asset resolver returned a non data: image URI');
  return uri;
}
export const img = (assets: AssetResolver, ref: AssetRef, cls: string) => `<img class="${cls}" src="${dataImage(assets, ref)}" alt="">`;

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const mm = (v: unknown, d = 0) => `${num(v, d)}mm`;

/** 04-UI-UX §3.2 "Dates" per calendarDisplay, in the document timezone (02-CV §13). */
export function fmtInstant(iso: string | undefined, doc: ReportDocument): string {
  if (!iso) return '';
  const tz = doc.timezone || 'Asia/Kathmandu';
  const ad = formatAd(iso as IsoUtc, tz); // DD/MM/YYYY hh:mm A
  if (doc.calendarDisplay === 'AD' || !doc.calendarDisplay) return ad;
  const date = ad.slice(0, 10), time = ad.slice(11);
  const bs = formatBs(instantToBs(iso as IsoUtc, tz), 'display');
  if (doc.calendarDisplay === 'AD_BS') return `${ad} (${bs})`;
  if (doc.calendarDisplay === 'BS') return `${bs} ${time}`;
  return `${bs} ${time} (${date})`;
}

function css(input: RenderInput): string {
  const config = input.config;
  const qr = mm(config.qr?.size_mm, 22);
  return `${pageRules(input)}*{box-sizing:border-box}
html,body{margin:0;padding:0}
body{font-family:"Noto Sans","Noto Sans Devanagari",sans-serif;font-size:${num(config.fonts?.base_pt, 9)}pt;line-height:1.2;color:#000;font-variant-numeric:tabular-nums}
table{border-collapse:collapse;width:100%}
td,th{padding:0.2mm 1mm;vertical-align:top;text-align:left;font-weight:normal;overflow-wrap:anywhere}
.frame>thead>tr>td,.frame>tfoot>tr>td{padding:0}
.sca{font-weight:bold;margin-top:1mm}
.pt{border:0.3mm solid #000;margin:1mm 0}
.pt td.k{width:16%;font-weight:bold}
.pt td.v{width:34%}
.colh th{font-weight:bold;border-bottom:0.3mm solid #000}
.pkg td{font-size:10pt;font-weight:bold;text-transform:uppercase;padding-top:2mm}
.dept td{font-size:10pt;font-weight:bold;padding-top:1.5mm}
.panel td{font-size:9.5pt;font-weight:bold}
.sub td{font-style:italic;padding-left:2mm}
.an td:first-child{padding-left:3mm}
.meth{font-size:7.5pt}
.cm td,.cmt{font-size:8pt}
.flag{font-weight:bold}
tr.an,tr.cm,tr.keep{break-inside:avoid;page-break-inside:avoid}
tr.hd{break-after:avoid;page-break-after:avoid}
tr.brk{break-before:page;page-break-before:always}
.box{border:0.4mm solid #000;padding:1.5mm;margin:1mm 0 2mm;break-inside:avoid}
.box .bt{font-weight:bold}
.foot{border-top:0.3mm solid #000;margin-top:2mm;padding-top:1mm}
.sig td{vertical-align:bottom}
.sigimg{height:12mm}
.sigimg img{max-width:30mm;max-height:12mm;object-fit:contain}
.sn{font-weight:bold}
.qrc{width:${qr};text-align:center}
img.qr{width:${qr};height:${qr};display:block}
.qcap{font-size:7pt;white-space:nowrap}
.disc{font-size:7pt}
.contact{font-size:7.5pt;padding-right:25mm}
.wm{position:fixed;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:48pt;font-weight:bold;white-space:nowrap;color:#000}
:is(td,th)+:is(td,th)::before{content:"\\a0"}
`;
}

/** 04-UI-UX §3.2 Watermark; LD-26 (A33-3): a training tenant adds "TRAINING - NOT A VALID REPORT" on every page, on top of any configured one. */
export function watermarks(input: RenderInput): string {
  const w = input.config.watermark;
  const training = input.trainingMode === true;
  let out = '';
  if (w && typeof w.text === 'string' && w.text) out += `<div class="wm" style="top:${training ? 35 : 50}%;opacity:${num(w.opacity, 0.1)}">${esc(w.text)}</div>`;
  // [CONV] 28 pt so the 29-character text stays inside the page box once rotated (48 pt runs off A4 and is clipped).
  if (training) out += `<div class="wm" style="top:${w ? 65 : 50}%;opacity:0.15;font-size:28pt">TRAINING - NOT A VALID REPORT</div>`;
  return out;
}

type FieldDef = [HeaderFieldKey, string, (d: ReportDocument) => string];
const FIELDS: FieldDef[] = [
  ['sample_collected_at', 'Sample Collected At', (d) => `${d.header.collectedAtCentre.code}-${d.header.collectedAtCentre.name}`],
  ['name', 'Name', (d) => d.header.patientName],
  ['reg_no', 'Reg No', (d) => d.header.regNo],
  ['age_gender', 'Age/Gender', (d) => d.header.ageGender],
  ['barcode_no', 'Barcode No', (d) => (d.header.barcodeNos ?? []).join(', ')],
  ['sample_coll_dt', 'Sample Coll Dt', (d) => fmtInstant(d.header.sampleCollectedAt, d)],
  ['reg_date', 'Reg Date', (d) => fmtInstant(d.header.registeredAt, d)],
  ['sample_rcv_dt', 'Sample Rcv Dt', (d) => fmtInstant(d.header.sampleReceivedAt, d)],
  ['reported_date', 'Reported Date', (d) => fmtInstant(d.header.reportedAt, d)],
  ['report_status', 'Report Status', (d) => d.statusLabel],
  ['referred_by', 'Referred By', (d) => d.header.referredBy],
];

/** "Sample Collected At" line + patient block (repeated on every page via <thead>; letterhead band: print-plain/). */
export function headerBlock(input: RenderInput): string {
  const d = input.document;
  const keys = Array.isArray(input.config.header_fields) ? input.config.header_fields : HEADER_FIELD_KEYS;
  const fields = keys.map((k) => FIELDS.find((f) => f[0] === k)).filter((f): f is FieldDef => !!f);
  let out = '';
  const sca = fields.find((f) => f[0] === 'sample_collected_at');
  if (sca) {
    out += `<div class="sca">Sample Collected At: ${esc(sca[2](d))}</div>`;
    if (d.header.collectedAtCentre.addressText) out += `<div>${esc(d.header.collectedAtCentre.addressText)}</div>`;
  }
  const rest = fields.filter((f) => f !== sca);
  let rows = '';
  for (let i = 0; i < rest.length; i += 2) {
    const cell = (f?: FieldDef) => (f ? `<td class="k">${esc(f[1])}</td><td class="v">: ${esc(f[2](d))}</td>` : '<td class="k"></td><td class="v"></td>');
    rows += `<tr>${cell(rest[i])}${cell(rest[i + 1])}</tr>`;
  }
  return out + (rows ? `<table class="pt">${rows}</table>` : '');
}

const COUNCILS = new Set(['NMC', 'NHPC']);
/** LD-27 (A33-4): "<council> No. <registration_no>"; no council -> name + title only. */
const sigLine = (s: Signatory) =>
  [s.displayTitle, s.council && COUNCILS.has(s.council) && s.registrationNo ? `${s.council} No. ${s.registrationNo}` : undefined].filter(Boolean).join(', ');

/** Footer (repeated on every page via <tfoot>): signatories, QR, disclaimers (<= 5), contact strip. */
export function footerBlock(input: RenderInput, signatories: readonly Signatory[]): string {
  const { config, document: d, assets } = input;
  const max = Number.isInteger(config.signatories?.max) ? config.signatories.max! : 2;
  const showImg = config.signatories?.show_signature_images !== false;
  const sigs = signatories.slice(0, max).map((s) => {
    const im = showImg && s.signatureAssetRef ? img(assets, s.signatureAssetRef, 'si') : '';
    const line = sigLine(s);
    return `<td><div class="sigimg">${im}</div><div class="sn">${esc(s.displayName)}</div>${line ? `<div>${esc(line)}</div>` : ''}</td>`;
  });
  let qr = '';
  if (config.qr?.enabled !== false && d.qr?.verifyUrl) {
    const caption = typeof config.qr?.caption === 'string' ? config.qr.caption : 'Scan to verify';
    qr = `<td class="qrc"><img class="qr" src="${qrDataUri(d.qr.verifyUrl)}" alt="">${caption ? `<div class="qcap">${esc(caption)}</div>` : ''}</td>`;
  }
  const disc = (d.disclaimers ?? []).slice(0, 5).map((x) => `<div>${esc(x)}</div>`).join('');
  const contact = [...(d.lab.contactStrip ?? []), d.lab.addressText, config.contact_strip_extra].filter((x): x is string => !!x).map(esc).join(' &#183; ');
  return `<div class="foot"><table class="sig"><tr>${sigs.join('')}${qr}</tr></table>${disc ? `<div class="disc">${disc}</div>` : ''}` +
    `${contact ? `<div class="contact">${contact}</div>` : ''}</div>`;
}

/** Full document: one outer table; header in <thead>, footer in <tfoot>, body rows in <tbody> (DECISIONS.md thead-tfoot). */
export function shell(input: RenderInput, o: { title: string; css?: string; cols: string; theadExtra?: string; body: string; footer: string; span: number }): string {
  const cell = (inner: string) => `<tr><td colspan="${o.span}">${inner}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(o.title)}</title><style>${css(input)}${o.css ?? ''}</style></head><body>` +
    `${watermarks(input)}<table class="frame">${o.cols}<thead>${cell(headerBlock(input))}${o.theadExtra ?? ''}</thead>` +
    `<tfoot>${cell(o.footer)}</tfoot><tbody>${o.body}</tbody></table></body></html>`;
}

/** 04-UI-UX §3.2 status boxes at the top of page 1 (Amended, Addendum, Preliminary). */
export function statusBox(d: ReportDocument): string {
  const n = d.amendmentNotes?.[0];
  // [CONV] "issued {date}": the snapshot carries no issue time of the replaced version; amendedAt is printed
  // until CR-C6-024 item 3 (.orchestra/cr/C6-T07.nonblocking.md) adds amendmentNotes[].previousIssuedAt; then print that.
  // [CONV] partial box pending CR-C6-024 item 4 (ReportDocument.pendingTestCount); reportKind 'partial' renders no box.
  const issued = n ? ` issued ${fmtInstant(n.amendedAt, d)}` : '';
  let lines: string[] = [];
  if (d.reportKind === 'amended' && n) {
    lines = [`AMENDED REPORT — replaces version ${n.previousVersionNo}${issued}.`, ...d.amendmentNotes.map((a) => `${a.analyteOrSection}: ${a.reasonText ?? a.reasonCode}`)];
  } else if (d.reportKind === 'addendum') {
    lines = [`ADDENDUM — supplementary report${n ? ` to version ${n.previousVersionNo}${issued}` : ''}. The original findings are not changed.`];
  } else if (d.reportKind === 'preliminary') {
    lines = ['PRELIMINARY REPORT — final results will follow.'];
  }
  if (!lines.length) return '';
  const [t, ...rest] = lines;
  return `<div class="box"><div class="bt">${esc(t)}</div>${rest.map((l) => `<div>${esc(l)}</div>`).join('')}</div>`;
}
