// C5 T-10 label renderer (02-TRD §4.6; PRD AC-02.4). Phase 1 = html_svg: an HTML string of print-ready labels, sized from the #14 response (print CSS is never a constant).
// LD-109: the Code 128 symbol is the kit BarcodeSymbol (C0-0D). Module width = label width / code128Modules(value) (quiet zones included); below 0.25 mm the label shows the
// warning instead of a degraded symbol (TRD §4.6). BarcodeSymbol throws on a value it cannot encode (message never holds the value): that error is NOT caught here, so a label
// that cannot be encoded is never printed blank, truncated or guessed — the caller shows it as an error.
// All text goes through React (escaped); the only raw HTML is the stylesheet, built from validated numbers and constants.
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { BarcodeSymbol, code128Modules } from '@lims/ui/components/BarcodeSymbol';

export interface LabelData {
  specimenId: string; barcode: string; patientName: string; ageSex: string; registrationNo: string;
  specimenTypeCode: string; containerCode?: string; collectedOn?: string; testCodes: readonly string[];
  moreTests: number; urgent: boolean; copies: number;
}
export interface LabelRenderer { readonly format: 'html_svg' | 'zpl'; render(labels: readonly LabelData[], size: { widthMm: number; heightMm: number }): string }

export const MIN_MODULE_MM = 0.25;        // TRD §4.6
const MIN_BAR_MM = 8;                     // [CONV] minimum bar height
const NAME_MAX = 24;                      // [CONV] AC-02.4
const COPIES_MAX = 5;                     // lab.yaml printSpecimenLabels copies 1..5
export const TOO_SMALL = 'Label too small for this barcode — increase label size in Lab settings.';

/** Module width in mm when the symbol (quiet zones included) spans the full label width. */
export const moduleWidthFor = (barcode: string, widthMm: number): number => widthMm / code128Modules(barcode);
export const barcodeFits = (barcode: string, widthMm: number): boolean => moduleWidthFor(barcode, widthMm) >= MIN_MODULE_MM;

const dmy = (iso: string): string => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${m[3]}/${m[2]}/${m[1]}` : iso; };

function css(w: number, hgt: number): string {
  return `@page{size:${w}mm ${hgt}mm;margin:0}
.lbl{width:${w}mm;height:${hgt}mm;box-sizing:border-box;overflow:hidden;padding:0.6mm 0;break-after:page;page-break-after:always;font-family:Arial,Helvetica,sans-serif;font-size:6.5pt;line-height:1.15;color:black;background:white}
.lbl:last-child{break-after:auto;page-break-after:auto}
.lbl-l{padding:0 1mm;white-space:nowrap;overflow:hidden}
.lbl-bc{padding:0 1mm;text-align:center;font-family:monospace;font-weight:bold;white-space:nowrap;overflow:hidden}
.lbl-warn{padding:0 1mm;font-weight:bold}
.lbl-urg{padding:0 1mm;font-weight:bold}
.lbl svg{display:block}
@media screen{.lbl{border:1px dashed gray;margin:0 0 4px 0;break-after:auto;page-break-after:auto}}`;
}

function label(l: LabelData, key: string, w: number, hgt: number): ReactElement {
  const fits = barcodeFits(l.barcode, w);   // throws (value-free message) when the barcode cannot be encoded
  const tests = [...l.testCodes.map(String), ...(l.moreTests > 0 ? [`+${l.moreTests}`] : [])].join(' ');
  const line2 = [l.registrationNo, l.specimenTypeCode, ...(l.containerCode ? [l.containerCode] : [])].join(' ');
  return h('div', { key, className: 'lbl', 'data-testid': 'label' },
    h('div', { className: 'lbl-l' }, `${l.patientName.slice(0, NAME_MAX)} ${l.ageSex}`),
    fits
      ? h(BarcodeSymbol, { value: l.barcode, moduleWidthMm: moduleWidthFor(l.barcode, w), heightMm: Math.max(MIN_BAR_MM, hgt * 0.32), showText: false })
      : h('div', { className: 'lbl-warn' }, TOO_SMALL),
    h('div', { className: 'lbl-bc' }, l.barcode),
    h('div', { className: 'lbl-l' }, line2),
    ...(tests ? [h('div', { className: 'lbl-l', key: 't' }, tests)] : []),
    ...(l.collectedOn ? [h('div', { className: 'lbl-l', key: 'c' }, `Coll: ${dmy(l.collectedOn)}`)] : []),
    ...(l.urgent ? [h('div', { className: 'lbl-urg', key: 'u' }, '★ URGENT')] : []),
  );
}

export const htmlSvgRenderer: LabelRenderer = {
  format: 'html_svg',
  render(labels, size) {
    const w = size.widthMm, hgt = size.heightMm;
    if (!Number.isFinite(w) || !Number.isFinite(hgt) || w <= 0 || w > 1000 || hgt <= 0 || hgt > 1000) throw new RangeError('Invalid label size');
    const out: ReactElement[] = [];
    labels.forEach((l, i) => {
      const copies = Math.min(COPIES_MAX, Math.max(1, Math.trunc(l.copies) || 1));
      for (let c = 0; c < copies; c++) out.push(label(l, `${i}-${c}`, w, hgt));
    });
    return renderToStaticMarkup(h('div', null, h('style', { dangerouslySetInnerHTML: { __html: css(w, hgt) } }), ...out));
  },
};
