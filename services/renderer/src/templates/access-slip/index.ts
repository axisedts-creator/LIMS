// partners.access_slip DataTemplateModule (08 Addendum A5.1, CR-C13-014; 02-TRD §7.4). One printed page: names, order ref, validity, QR of portalUrl.
// Pure: same data -> same HTML. QR via the report encoder (lab/qr.ts, C6-T07), embedded as a data: URI; portalUrl is never printed, linked, logged or stored.
import type { DataTemplateModule } from '../contract.js';
import { qrDataUri } from '../lab/qr.js';

const ENT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Element-content escape only (every dynamic value below lands in element content, never in an attribute). */
const esc = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/[&<>"']/g, (c) => ENT[c]!);

const CSS = `@page{size:A4;margin:20mm}body{font-family:Arial,Helvetica,sans-serif;font-size:11pt;color:#000}h1{font-size:16pt;margin:0 0 2mm}` +
  `.sub{margin:0 0 8mm;font-size:12pt}table{border-collapse:collapse}td{padding:1.5mm 6mm 1.5mm 0;vertical-align:top}td.k{color:#444}` +
  `.qr{margin:10mm 0 3mm}.qr img{width:50mm;height:50mm}.note{font-size:9pt;color:#444}`;
const ROWS = [['Partner', 'partnerName'], ['Patient', 'patientDisplayName'], ['Order', 'orderRef'], ['Issued', 'issuedAtLocal'], ['Valid until', 'expiresAtLocal']] as const;

export const accessSlipTemplate: DataTemplateModule = {
  templateKey: 'partners.access_slip',
  render({ data, qr }) {
    const url = data['portalUrl'];
    if (typeof url !== 'string' || url.length === 0) throw new Error('partners.access_slip: portalUrl required');   // message carries no data -> 422
    const rows = ROWS.map(([k, f]) => `<tr><td class="k">${k}</td><td>${esc(data[f])}</td></tr>`).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><title>Access slip</title><style>${CSS}</style></head><body>` +
      `<h1>${esc(data['tenantDisplayName'])}</h1><p class="sub">Report access slip</p><table>${rows}</table>` +
      `<div class="qr"><img src="${(qr ?? qrDataUri)(url)}" alt=""></div><div class="note">Scan the code to open the report.</div></body></html>`;
  },
};
