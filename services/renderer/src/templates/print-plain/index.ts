// Page box + letterhead (AC-12.2, 04-UI-UX §3.1/§3.2 "Plain variant": header/footer images omitted, reserved space kept,
// everything else identical).
// [CONV] The letterhead bands sit in the page margin: @page margin = margin_mm + plain_reserve_*_mm in BOTH variants (so a
// letterhead print and a plain print of one snapshot paginate identically), and the letterhead variant paints the header /
// footer image into that band through @page margin boxes, which Chromium repeats on every page. Reason: Chromium repeats a
// <thead>/<tfoot> only while it is at most 1/4 of the page area (measured, Playwright 1.65.0), and a letterhead band plus the
// patient block exceeds that; position:fixed in the margin loses pages (DECISIONS.md).
import type { RenderInput } from '../contract.js';
import { dataImage, mm } from '../lab/shared.js';

export function pageRules(input: RenderInput): string {
  const { config, document: d, variant, assets } = input;
  const m = config.page?.margin_mm ?? ({} as Partial<RenderInput['config']['page']['margin_mm']>);
  const lh = config.letterhead ?? ({} as Partial<RenderInput['config']['letterhead']>);
  const size = config.page?.size === 'Letter' ? 'Letter' : 'A4';
  const [top, bottom, rt, rb] = [mm(m.top, 25), mm(m.bottom, 25), mm(lh.plain_reserve_top_mm), mm(lh.plain_reserve_bottom_mm)];
  let out = `@page{size:${size};margin:calc(${top} + ${rt}) ${mm(m.right, 10)} calc(${bottom} + ${rb}) ${mm(m.left, 10)}}\n`;
  if (variant !== 'letterhead') return out;
  const band = (box: 'top-center' | 'bottom-center', ref: Parameters<typeof assets.dataUri>[0] | undefined, pad: string) => {
    if (!ref) return '';
    const uri = dataImage(assets, ref);
    return `@${box}{content:"";width:100%;${box === 'top-center' ? 'padding-top' : 'padding-bottom'}:${pad};` +
      `background-image:url(${uri});background-size:contain;background-repeat:no-repeat;background-position:center;background-origin:content-box;background-clip:content-box}`;
  };
  const head = lh.header_asset === 'branding' ? band('top-center', d.lab.headerAssetRef ?? d.lab.logoAssetRef, top) : '';
  const foot = lh.footer_asset === 'branding' ? band('bottom-center', d.lab.footerAssetRef, bottom) : '';
  return head || foot ? `${out}@page{${head}${foot}}\n` : out;
}
