// T0B-PRINTCFG-1 done_when (4) PLAIN BILL (founder 2026-11-17 08:39 NPT "one plain bill option without header or footer like PAN bill black and white"; LD-316).
// Real Chromium through the real server with the DEFAULT registry (templates/billing/index.ts does not exist yet: the writer creates it, the fixture-roots copy is only a test double).
// PINNED (spec silent; a change needs a ruling, see .orchestra/notes/T0B-PRINTCFG-1-tests.md):
//   * data templates `billing.invoice` and `billing.credit_note` (DataTemplateModule, templates/billing/index.ts) take
//       data = { style: 'full' | 'plain_bw', document: InvoicePrint.document | CreditNotePrint.document (billing.yaml, snake_case), copy_mark?, patient?: { name, age_text, sex },
//                seller_pan?: string, print_profile?: { paper_mode, header_text, footer_text, reserve_top_mm, reserve_bottom_mm, show_logo, show_seller_pan, grayscale, font_size_pt } }
//     The seller PAN is document.seller.pan (invoice) or data.seller_pan (credit note has no seller); it prints only when print_profile.show_seller_pan !== false.
//     GAP for the lead: InvoicePrint.document has no patient age / sex (buyer is a Party: name, pan, address) -> `patient` is a data key the API fills; needs a contract ruling (see notes).
//   * style plain_bw: black on white only: no colour operator, NO image object of any kind (no logo, no letterhead, no QR), no shading, no header_text / footer_text, even when branding images and a
//     print_profile with typed text are supplied. The body keeps: lab name, address, seller PAN (when set and shown), bill number, date, patient name / age / sex, item lines, totals, discount, paid, due.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../../pool.js';
import { startServer } from '../../server.js';
import { loadRegistry } from '../registry.js';
import { contentStreams, imageAndShadingObjects, nonGrayColourOps } from '../../__tests__/helpers/pdf-geometry.js';
import { norm, pdfPages } from '../../__tests__/helpers/pdf-text.js';
import { PNG_B64 } from './fixtures.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const TOKEN = 'synthetic-renderer-token-0123456789abcdef';
let pool: Awaited<ReturnType<typeof createPool>>; let srv: Awaited<ReturnType<typeof startServer>>;
beforeAll(async () => { pool = await createPool({ contexts: 2 }); srv = await startServer({ pool, token: TOKEN, port: 0, host: '127.0.0.1', registry: await loadRegistry() }); });
afterAll(async () => { await srv?.close(); await pool?.close(); });
const post = (body: unknown) => fetch(`${srv.url}/internal/render`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

const money = (p: number) => ({ amount_paisa: p, currency: 'NPR' });
const uuid = (n: number) => `0193c4a0-0000-7000-8000-${String(n).padStart(12, '0')}`;
const branding = { legal_name: 'Synthetic Diagnostics Pvt Ltd (T0BPC)', address_lines: ['Synthetic Marg 7', 'Kathmandu'], phones: ['01-5550000'], receipt_footer_note: 'Thank you (T0BPC)',
  images: [{ kind: 'logo', mime_type: 'image/png', base64: PNG_B64 }, { kind: 'letterhead_header', mime_type: 'image/png', base64: PNG_B64 }, { kind: 'letterhead_footer', mime_type: 'image/png', base64: PNG_B64 }] };
const line = (n: number, name: string, net: number) => ({ id: uuid(n), line_no: n, line_kind: 'test', code: `T${n}`, name, quantity: 1, unit_price: money(net), gross: money(net), discount: money(0), exempt: money(net), taxable: money(0), vat: money(0), other_tax: money(0), net: money(net), credited: money(0) });
const invoiceDoc = (over: Record<string, unknown> = {}) => ({
  id: uuid(1), invoice_no: '083/84-000042', invoice_seq: 42, series: 'INV', fiscal_year_bs: '2083/84', invoice_kind: 'tax_invoice', status: 'issued', is_active: true, issued_at: '2026-11-08T05:00:00.000Z',
  invoice_date_bs: '2083-07-22', branch_id: uuid(2), is_periodic_credit_bill: false, buyer: { name: 'Test Patient 0042 (SYNTHETIC)' }, seller: { name: 'Synthetic Diagnostics Pvt Ltd (T0BPC)', pan: '123456789', address: 'Synthetic Marg 7, Kathmandu' },
  lines: [line(1, 'Haemoglobin (SYNTHETIC)', 30000), line(2, 'Blood Sugar Fasting (SYNTHETIC)', 83000)],
  totals: { gross: money(113000), discount: money(13000), exempt: money(100000), taxable: money(0), vat: money(0), other_tax: money(0), net: money(100000) }, credited_total: money(0), print_count: 1, cbms_state: 'pending', version: 1,
  branding, dates: { bs: '2083-07-22', ad: '2026-11-08' }, payment_block: { paid: money(40000), balance_due: money(60000) }, print_no: 1, ...over });
const creditDoc = () => ({
  id: uuid(9), credit_note_no: 'CN-083/84-000007', credit_note_seq: 7, kind: 'partial', invoice_id: uuid(1), invoice_no: '083/84-000042', fiscal_year_bs: '2083/84', issued_at: '2026-11-08T06:00:00.000Z', credit_note_date_bs: '2083-07-22',
  reason_code: 'billing_error', lines: [{ invoice_line_id: uuid(1), amount: money(30000) }], totals: { exempt: money(30000), taxable: money(0), vat: money(0), other_tax: money(0), net: money(30000) },
  print_count: 1, cbms_state: 'pending', version: 1, branding, dates: { bs: '2083-07-22', ad: '2026-11-08' }, payment_block: { paid: money(0), balance_due: money(0) }, print_no: 1 });
const patient = { name: 'Test Patient 0042 (SYNTHETIC)', age_text: '43 Years', sex: 'MALE' };
const typed = { paper_mode: 'typed_header_footer', header_text: 'TYPED-HEADER-T0BPC', footer_text: 'TYPED-FOOTER-T0BPC', reserve_top_mm: 0, reserve_bottom_mm: 0, show_logo: true, show_seller_pan: true, grayscale: false, font_size_pt: 10 };
const bill = async (key: 'billing.invoice' | 'billing.credit_note', data: Record<string, unknown>) => {
  const r = await post({ template_id: key, data, assets: {} });
  expect(r.status, `${key} status`).toBe(200); expect(r.headers.get('content-type')).toBe('application/pdf');
  const pdf = new Uint8Array(await r.arrayBuffer()); return { pdf, text: pdfPages(pdf).map(norm).join('\n') };
};
const inv = (style: 'full' | 'plain_bw', o: Record<string, unknown> = {}) => bill('billing.invoice', { style, document: invoiceDoc(), patient, ...o });

describe('plain_bw invoice: black on white, nothing decorative', () => {
  it('no colour operator, no image of any kind, no shading, even with branding images and a typed header / footer profile supplied', async () => {
    const { pdf } = await inv('plain_bw', { print_profile: typed });
    expect(nonGrayColourOps(pdf)).toEqual([]);
    expect(imageAndShadingObjects(pdf)).toEqual([]);
    expect(contentStreams(pdf).join('\n')).not.toMatch(/(?<![\w/])sh(?![\w])/);   // no shading operator
  });
  it('no header text, no footer text, no letterhead text from the profile; no receipt footer note of the branding either', async () => {
    const { text } = await inv('plain_bw', { print_profile: typed });
    expect(text).not.toContain('TYPED-HEADER-T0BPC'); expect(text).not.toContain('TYPED-FOOTER-T0BPC');
  });
  it('keeps the lines a tax bill needs: lab name, address, seller PAN, bill number, date, patient name / age / sex, items, totals, discount, paid, due', async () => {
    const { text } = await inv('plain_bw');
    for (const s of ['Synthetic Diagnostics Pvt Ltd (T0BPC)', 'Synthetic Marg 7', '123456789', '083/84-000042', '2083-07-22', 'Test Patient 0042 (SYNTHETIC)', '43 Years', 'MALE',
      'Haemoglobin (SYNTHETIC)', 'Blood Sugar Fasting (SYNTHETIC)']) expect(text, s).toContain(s);
    // money shown as rupees: net 1,000.00, discount 130.00, paid 400.00, due 600.00 (formatting of the separator is not pinned)
    for (const re of [/1,?000\.00/, /130\.00/, /400\.00/, /600\.00/]) expect(text, String(re)).toMatch(re);
  });
  it('PAN is printed only when show_seller_pan is true and the tenant has one: false hides it, an unset PAN prints no PAN label or placeholder', async () => {
    expect((await inv('plain_bw', { print_profile: { ...typed, show_seller_pan: false } })).text).not.toContain('123456789');
    const noPan = (await inv('plain_bw', { document: invoiceDoc({ seller: { name: 'Synthetic Diagnostics Pvt Ltd (T0BPC)', address: 'Synthetic Marg 7' } }) })).text;
    expect(noPan).not.toMatch(/PAN\s*:?\s*(?:N\/A|-|null|undefined|\b)\s*$/m); expect(noPan).not.toMatch(/undefined|null|NaN/);
  });
  it('a reprint prints the copy mark; the plain bill is a normal bill otherwise', async () => {
    const { text } = await inv('plain_bw', { copy_mark: 'Copy of Original / प्रतिलिपि', document: invoiceDoc({ print_no: 2, copy_mark: 'Copy of Original / प्रतिलिपि' }) });
    expect(text).toContain('Copy of Original');
  });
  it('a cancelled invoice keeps its banner in plain black and white', async () => {
    const { pdf, text } = await inv('plain_bw', { document: invoiceDoc({ status: 'cancelled', is_active: false, cancelled_banner: 'CANCELLED' }) });
    expect(text).toContain('CANCELLED'); expect(nonGrayColourOps(pdf)).toEqual([]);
  });
  it('hostile text in names is escaped (angle brackets and ampersands print literally)', async () => {
    const { text } = await inv('plain_bw', { patient: { ...patient, name: 'A <b>B</b> & C' } });
    expect(text).toContain('A <b>B</b> & C');
  });
  it('the full style is still available and may carry the branding (the plain option is an option, not a replacement)', async () => {
    const { pdf } = await inv('full', { print_profile: { ...typed, paper_mode: 'letterhead_image' } });
    expect(Buffer.from(pdf.slice(0, 5)).toString()).toBe('%PDF-');
  });
});

describe('plain_bw credit note', () => {
  it('black on white, no image, no header / footer text; lab name, address, note number, original invoice number, date, items amount, totals', async () => {
    const { pdf, text } = await bill('billing.credit_note', { style: 'plain_bw', document: creditDoc(), patient, seller_pan: '123456789', print_profile: typed });
    expect(nonGrayColourOps(pdf)).toEqual([]); expect(imageAndShadingObjects(pdf)).toEqual([]);
    expect(text).not.toContain('TYPED-HEADER-T0BPC'); expect(text).not.toContain('TYPED-FOOTER-T0BPC');
    for (const s of ['Synthetic Diagnostics Pvt Ltd (T0BPC)', 'Synthetic Marg 7', '123456789', 'CN-083/84-000007', '083/84-000042', '2083-07-22', 'Test Patient 0042 (SYNTHETIC)']) expect(text, s).toContain(s);
    expect(text).toMatch(/300\.00/);
  });
  it('show_seller_pan false hides the PAN on a credit note too', async () => {
    expect((await bill('billing.credit_note', { style: 'plain_bw', document: creditDoc(), seller_pan: '123456789', print_profile: { ...typed, show_seller_pan: false } })).text).not.toContain('123456789');
  });
});

describe('registry and request shape', () => {
  it('the default registry resolves billing.invoice and billing.credit_note to data templates', async () => {
    const reg = await loadRegistry();
    for (const k of ['billing.invoice', 'billing.credit_note']) expect((reg.get(k) as { templateKey?: string } | undefined)?.templateKey, k).toBe(k);
  });
  it.each([[{ style: 'sepia', document: invoiceDoc() }], [{ style: 'plain_bw' }], [{ style: 'plain_bw', document: 'x' }]])('malformed data %j is a 4xx, never a 500', async (data) => {
    expect([400, 422]).toContain((await post({ template_id: 'billing.invoice', data, assets: {} })).status);
  });
});
