// narrative-report template (04-UI-UX §3.3 + §3.2 "Narrative section"): same header/footer as lab-report; footer signatory =
// the narrative signer. Narrative HTML is re-sanitised here (REQ-SEC-088).
import type { NarrativeSection, RenderInput, Signatory, TemplateModule } from '../contract.js';
import { esc, footerBlock, img, shell, statusBox } from '../lab/shared.js';
import { sanitizeHtml } from './sanitize.js';

function section(input: RenderInput, s: NarrativeSection): string {
  const cols = Math.min(3, Math.max(1, Math.trunc(Number(input.config.narrative?.show_images_grid_columns) || 2)));
  let out = `<div class="nt">${esc(`${String(s.templateKind ?? '').replace(/_/g, ' ').toUpperCase()} REPORT`)}</div><div class="ntn">${esc(s.testName)}</div>`;
  for (const sub of s.sections ?? []) out += `<div class="nh">${esc(sub.heading)}</div><div class="nb">${sanitizeHtml(sub.html)}</div>`;
  if (s.images?.length) {
    out += `<div class="ng" style="grid-template-columns:repeat(${cols},1fr)">` +
      s.images.map((i) => `<div class="ni">${img(input.assets, i.ref, 'nimg')}${i.caption ? `<div class="cap">${esc(i.caption)}</div>` : ''}</div>`).join('') + '</div>';
  }
  return out + `<div class="signed">Signed by: ${esc(s.signedBy?.displayName)}</div>`;
}

const NARRATIVE_CSS = '.nt{font-size:11pt;font-weight:bold;text-align:center;margin-top:2mm}.ntn{font-weight:bold;text-align:center;margin-bottom:2mm}' +
  '.nh{font-weight:bold;margin-top:2mm;break-after:avoid}.ng{display:grid;gap:2mm;margin-top:2mm}.ni{break-inside:avoid;text-align:center}' +
  '.nimg{max-width:100%;max-height:80mm;object-fit:contain}.cap{font-size:8pt}.signed{margin-top:3mm;font-weight:bold}';

export const narrativeReportTemplate: TemplateModule = {
  templateId: 'narrative-report',
  render(input) {
    const ns = (input.document.sections ?? []).filter((s): s is NarrativeSection => s.kind === 'narrative');
    const signers = new Map<string, Signatory>();
    for (const s of ns) if (s.signedBy) signers.set(s.signedBy.membershipId, s.signedBy);
    const box = statusBox(input.document);
    return shell(input, {
      title: 'Narrative report', css: NARRATIVE_CSS, cols: '', span: 1,
      body: `<tr><td>${box}${ns.map((s) => section(input, s)).join('')}</td></tr>`,
      footer: footerBlock(input, signers.size ? [...signers.values()] : input.document.signatories ?? []),
    });
  },
};
