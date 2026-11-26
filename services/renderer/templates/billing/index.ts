// billing.invoice / billing.credit_note data templates (T0B-PRINTCFG-1, LD-316; founder 2026-11-17 08:39 NPT "one plain bill option without header or footer like PAN bill black and white").
// data = { style: 'full' | 'plain_bw', document: InvoicePrint.document | CreditNotePrint.document (billing.yaml, snake_case), copy_mark?, patient?: { name, age_text, sex },
//          seller_pan? (credit note: it has no seller block), print_profile?: contract PrintProfile }.
// plain_bw: black on white only, no image of any kind, no colour, no shading, no header / footer text and no footer note; the body keeps the lines a tax bill needs
// (lab name, address, seller PAN when set and shown, bill number, date, patient, items, totals, discount, paid, due). Pure: same data -> same HTML. Every value is escaped.
import type { DataTemplateModule } from '../../src/templates/contract.js';

type Rec = Record<string, unknown>;
const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Element-content escape only (every dynamic value lands in element content, never in an attribute). */
const esc = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[&<>"']/g, (c) => ENT[c]!);
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const rec = (v: unknown): Rec => (isRec(v) ? v : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const DATA_IMG = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Money { amount_paisa } -> "1,000.00" (no currency symbol, [CONV] western grouping). Anything else -> ''. */
export function rupees(m: unknown): string {
  const p = rec(m)['amount_paisa'];
  if (typeof p !== 'number' || !Number.isSafeInteger(p)) return '';
  const abs = Math.abs(p); const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${p < 0 ? '-' : ''}${whole}.${String(abs % 100).padStart(2, '0')}`;
}

const CSS = (pt: number, top: number, bottom: number) => `@page{size:A4;margin:${top}mm 12mm ${bottom}mm 12mm}*{box-sizing:border-box}html,body{margin:0;padding:0}` +
  `body{font-family:"Noto Sans","Noto Sans Devanagari",sans-serif;font-size:${pt}pt;color:#000;background:#fff;line-height:1.25;font-variant-ligatures:no-common-ligatures}` +
  `h1{font-size:${pt + 4}pt;margin:0}h2{font-size:${pt + 2}pt;margin:2mm 0;text-align:center}.c{text-align:center}.r{text-align:right}.b{font-weight:bold}` +
  `table{border-collapse:collapse;width:100%}td,th{padding:0.8mm 1.2mm;text-align:left;vertical-align:top;font-weight:normal}` +
  `.items th{font-weight:bold;border-top:0.3mm solid #000;border-bottom:0.3mm solid #000}.items td.n,.items th.n{text-align:right}` +
  `.tot td{padding:0.4mm 1.2mm}.tot{width:60%;margin-left:40%;border-top:0.3mm solid #000;margin-top:1mm}.typed{white-space:pre-wrap}` +
  `.banner{font-weight:bold;font-size:${pt + 4}pt;text-align:center;border:0.4mm solid #000;margin:2mm 0;padding:1mm}.lh img{width:100%;max-height:35mm;object-fit:contain}` +
  `.logo img{max-height:18mm;max-width:40mm}`;

function head(o: { name: string; address: string[]; phones: string[]; pan: string; title: string }): string {
  return `<div class="c"><h1>${esc(o.name)}</h1>${o.address.map((a) => `<div>${esc(a)}</div>`).join('')}` +
    `${o.phones.length ? `<div>Phone: ${esc(o.phones.join(', '))}</div>` : ''}${o.pan ? `<div class="b">PAN: ${esc(o.pan)}</div>` : ''}</div><h2>${esc(o.title)}</h2>`;
}
const kv = (rows: Array<[string, string]>) => `<table class="kv">${rows.filter(([, v]) => v !== '').map(([k, v]) => `<tr><td class="b" style="width:28%">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>`;
const totals = (rows: Array<[string, string]>) => `<table class="tot">${rows.filter(([, v]) => v !== '').map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r">${esc(v)}</td></tr>`).join('')}</table>`;
const typedBlock = (t: unknown) => (str(t).trim() ? `<div class="typed">${esc(str(t))}</div>` : '');

function image(branding: Rec, kind: string): string {
  // branding.images carries the bytes inline (billing print document); never a URL.
  const im = (Array.isArray(branding['images']) ? branding['images'] : []).map(rec).find((i) => i['kind'] === kind);
  if (!im) return '';
  const uri = `data:${str(im['mime_type'])};base64,${str(im['base64'])}`;
  return DATA_IMG.test(uri) ? `<img src="${uri}" alt="">` : '';
}

function bill(kind: 'invoice' | 'credit_note', data: Readonly<Rec>): string {
  const style = data['style'];
  if (style !== 'full' && style !== 'plain_bw') throw new Error('bad style');   // message carries no data -> 422
  const d = data['document'];
  if (!isRec(d) || typeof d[kind === 'invoice' ? 'invoice_no' : 'credit_note_no'] !== 'string') throw new Error('bad document');
  const plain = style === 'plain_bw';
  const pp = rec(data['print_profile']);
  const mode = plain ? 'plain' : str(pp['paper_mode']) || 'letterhead_image';
  const pt = Number.isInteger(pp['font_size_pt']) && (pp['font_size_pt'] as number) >= 8 && (pp['font_size_pt'] as number) <= 12 ? (pp['font_size_pt'] as number) : 10;
  const reserve = (k: string, max: number) => (Number.isInteger(pp[k]) ? Math.min(Math.max(pp[k] as number, 5), max) : 10);
  const [top, bottom] = mode === 'preprinted_paper' ? [reserve('reserve_top_mm', 80), reserve('reserve_bottom_mm', 60)] : [10, 10];
  const branding = rec(d['branding']);
  const seller = rec(d['seller']);
  const name = str(branding['legal_name']) || str(seller['name']);
  const addr = Array.isArray(branding['address_lines']) ? (branding['address_lines'] as unknown[]).map(str).filter(Boolean) : [];
  const address = addr.length ? addr : [str(seller['address'])].filter(Boolean);
  const phones = Array.isArray(branding['phones']) ? (branding['phones'] as unknown[]).map(str).filter(Boolean) : [];
  const pan = pp['show_seller_pan'] === false ? '' : str(kind === 'invoice' ? seller['pan'] : data['seller_pan']) || str(data['seller_pan']);
  const patient = rec(data['patient']);
  const copy = str(data['copy_mark']) || str(d['copy_mark']);
  const dates = rec(d['dates']);
  const pay = rec(d['payment_block']);
  const t = rec(d['totals']);
  const ageSex = [str(patient['age_text']), str(patient['sex'])].filter(Boolean).join(' / ');

  let top_ = ''; let foot = '';
  if (!plain) {   // full: the print profile decides (no profile = the lab letterhead images as before)
    if (mode === 'letterhead_image') { const h = image(branding, 'letterhead_header'); if (h) top_ += `<div class="lh">${h}</div>`; const f = image(branding, 'letterhead_footer'); if (f) foot += `<div class="lh">${f}</div>`; }
    if (mode === 'typed_header_footer') { top_ += typedBlock(pp['header_text']); foot += typedBlock(pp['footer_text']); }
    if (pp['show_logo'] === true || !isRec(data['print_profile'])) { const l = image(branding, 'logo'); if (l && mode !== 'preprinted_paper') top_ += `<div class="logo c">${l}</div>`; }
    if (str(branding['receipt_footer_note'])) foot = `<div class="c">${esc(str(branding['receipt_footer_note']))}</div>${foot}`;
  }
  let body: string;
  if (kind === 'invoice') {
    const buyer = rec(d['buyer']);
    const lines = (Array.isArray(d['lines']) ? d['lines'] : []).map(rec);
    body = kv([['Bill No', str(d['invoice_no'])], ['Date (BS)', str(d['invoice_date_bs']) || str(dates['bs'])], ['Date (AD)', str(dates['ad'])],
      ['Patient', str(patient['name']) || str(buyer['name'])], ['Age / Sex', ageSex], ['Buyer', str(patient['name']) && str(buyer['name']) !== str(patient['name']) ? str(buyer['name']) : ''],
      ['Buyer PAN', str(buyer['pan'])], ['Buyer address', str(buyer['address'])]]) +
      `<table class="items"><tr><th>#</th><th>Code</th><th>Description</th><th class="n">Qty</th><th class="n">Amount</th></tr>` +
      lines.map((l) => `<tr><td>${esc(str(l['line_no']))}</td><td>${esc(str(l['code']))}</td><td>${esc(str(l['name']))}</td><td class="n">${esc(str(l['quantity']))}</td><td class="n">${esc(rupees(l['gross']))}</td></tr>`).join('') +
      `</table>` + totals([['Gross', rupees(t['gross'])], ['Discount', rupees(t['discount'])], ['Exempt', rupees(t['exempt'])], ['Taxable', rupees(t['taxable'])],
        ['VAT', rupees(t['vat'])], ['Other tax', rupees(t['other_tax'])], ['Net total', rupees(t['net'])], ['Paid', rupees(pay['paid'])], ['Due', rupees(pay['balance_due'])]]);
  } else {
    const lines = (Array.isArray(d['lines']) ? d['lines'] : []).map(rec);
    body = kv([['Credit note No', str(d['credit_note_no'])], ['Against bill No', str(d['invoice_no'])], ['Date (BS)', str(d['credit_note_date_bs']) || str(dates['bs'])],
      ['Date (AD)', str(dates['ad'])], ['Patient', str(patient['name'])], ['Age / Sex', ageSex], ['Reason', str(d['reason_code'])]]) +
      `<table class="items"><tr><th>#</th><th>Item</th><th class="n">Amount</th></tr>` +
      lines.map((l, i) => `<tr><td>${i + 1}</td><td>Bill line</td><td class="n">${esc(rupees(l['amount']))}</td></tr>`).join('') +
      `</table>` + totals([['Exempt', rupees(t['exempt'])], ['Taxable', rupees(t['taxable'])], ['VAT', rupees(t['vat'])], ['Other tax', rupees(t['other_tax'])], ['Net credit', rupees(t['net'])]]);
  }
  const title = kind === 'credit_note' ? 'CREDIT NOTE' : str(d['invoice_kind']) === 'abbreviated_tax_invoice' ? 'ABBREVIATED TAX INVOICE' : 'TAX INVOICE';
  const gray = !plain && pp['grayscale'] === true ? 'img{filter:grayscale(1)}' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS(pt, top, bottom)}${gray}</style></head><body>` +
    top_ + head({ name, address, phones, pan, title }) +
    (copy ? `<div class="c b">${esc(copy)}</div>` : '') + (str(d['cancelled_banner']) ? `<div class="banner">${esc(str(d['cancelled_banner']))}</div>` : '') +
    body + foot + `</body></html>`;
}

export const templates: DataTemplateModule[] = [
  { templateKey: 'billing.invoice', render: ({ data }) => bill('invoice', data) },
  { templateKey: 'billing.credit_note', render: ({ data }) => bill('credit_note', data) },
];
export default templates;
