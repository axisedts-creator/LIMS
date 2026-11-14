// lab-report template (04-UI-UX §3.1/§3.2, Metro layout; AC-03.1–03.3, 03.5–03.7, AC-12.2). Pure: same input -> same HTML.
import type { Block, RenderInput, TemplateModule } from '../contract.js';
import { sanitizeHtml } from '../narrative/sanitize.js';
import { anatomicRows, microRows } from './modules.js';
import { esc, footerBlock, shell, statusBox } from './shared.js';

function body(input: RenderInput, span: number, units: boolean): string {
  const { document: d, config } = input;
  const r = config.results ?? ({} as RenderInput['config']['results']);
  const showMethod = r.show_method_line !== false;
  const byPackage = r.group_by_package !== false;
  const row = (cls: string, text: string) => `<tr class="${cls}"><td colspan="${span}">${esc(text)}</td></tr>`;
  let out = '';
  let lastPkg: string | undefined;
  let depts = 0;
  const pkgRow = (b: Block | undefined) => {
    if (!byPackage || !b?.packageName || b.packageName === lastPkg) return '';
    lastPkg = b.packageName;
    return row('pkg hd', b.packageName);
  };
  for (const s of d.sections ?? []) {
    if (s.kind === 'department') {
      let dept = pkgRow(s.blocks[0]) + row('dept hd', s.departmentName);
      if (r.page_break_before_department === true && depts > 0) dept = dept.replace('<tr class="', '<tr class="brk ');
      depts++;
      out += dept;
      for (const b of s.blocks) {
        out += pkgRow(b) + row('panel hd', b.panelName);
        for (const g of b.subgroups) {
          if (g.subheading) out += row('sub hd', g.subheading);
          for (const l of g.lines) {
            const value = l.valueBold ? `<b>${esc(l.valueText)}</b>` : esc(l.valueText);
            out += `<tr class="an"><td>${esc(l.name)}${showMethod && l.methodLine ? `<div class="meth">${esc(l.methodLine)}</div>` : ''}</td>` +
              `<td>${l.flagLabel ? `<span class="flag">${esc(l.flagLabel)}</span> ` : ''}${value}</td><td>${esc(l.refRangeText)}</td>` +
              `${units ? `<td>${esc(l.unitText)}</td>` : ''}</tr>`;
            if (l.comment) out += row('cm', l.comment);
          }
        }
        for (const c of b.comments ?? []) out += row('cm', c);
        if (b.specimenLine) out += row('keep', `Specimen: ${b.specimenLine}`);
      }
      if (r.show_department_approved_by !== false && s.approvedBy?.length) out += row('keep', `Approved by: ${s.approvedBy.join(', ')}`);
    } else if (s.kind === 'outsourced_index' && s.items.length) {
      out += row('dept hd', 'Tests performed by external laboratories');
      for (const it of s.items) out += row('keep', `${it.testName} — ${it.externalLabName} — attached report follows`);
    } else if (s.kind === 'micro') out += microRows(s, span);
    else if (s.kind === 'anatomic') out += anatomicRows(s, span, input.assets);
    // narrative sections are not drawn by lab-report (narrative-report draws them).
  }
  if (input.smart && d.smart) {
    const frag = input.smart.renderSections({ summary: d.smart.payload, calendarDisplay: d.calendarDisplay, timezone: d.timezone });
    out += `<tr><td colspan="${span}">${sanitizeHtml(frag)}</td></tr>`;
  }
  return out;
}

export const labReportTemplate: TemplateModule = {
  templateId: 'lab-report',
  render(input) {
    const units = input.config.results?.show_units_column !== false;
    const span = units ? 4 : 3;
    const cols = units
      ? '<colgroup><col style="width:44%"><col style="width:18%"><col style="width:26%"><col style="width:12%"></colgroup>'
      : '<colgroup><col style="width:50%"><col style="width:20%"><col style="width:30%"></colgroup>';
    const colh = `<tr class="colh"><th>Tests</th><th>Results</th><th>Biological Ref Range</th>${units ? '<th>Units</th>' : ''}</tr>`;
    const box = statusBox(input.document);
    return shell(input, {
      title: 'Laboratory report', cols, span, theadExtra: colh,
      body: (box ? `<tr><td colspan="${span}">${box}</td></tr>` : '') + body(input, span, units),
      footer: footerBlock(input, input.document.signatories ?? []),
    });
  },
};
