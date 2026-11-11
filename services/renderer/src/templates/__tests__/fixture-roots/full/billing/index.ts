// C6-T36 fixture standing in for C4's services/renderer/templates/billing/index.ts (billing.invoice / credit_note / register). Synthetic data only.
// Exports the module list both as `templates` and as default (spec §5.3 says only "exports DataTemplateModule[]").
const page = (body: string) => `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}</body></html>`;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
export const templates = [
  { templateKey: 'billing.invoice' as const, render: ({ data }: any) => page(`<h1>FIXTURE-INVOICE</h1><p>No ${esc(data.invoiceNo)}</p><p>${esc(data.patientDisplayName)}</p><p>Total ${esc(data.totalText)}</p>`) },
  { templateKey: 'billing.credit_note' as const, render: ({ data }: any) => page(`<h1>FIXTURE-CREDIT-NOTE</h1><p>No ${esc(data.creditNoteNo)}</p>`) },
  // register: hostile body — script and external fetches must be neutralised by the renderer guard (REQ-SEC-086)
  { templateKey: 'billing.register' as const, render: ({ data }: any) =>
      page(`<h1>FIXTURE-REGISTER ${esc(data.title)}</h1><script>document.body.insertAdjacentHTML('beforeend','<p>SCRIPT-RAN</p>')</script><img src="http://127.0.0.1:9/x.png"><link rel="stylesheet" href="http://127.0.0.1:9/x.css">`) },
];
export default templates;
