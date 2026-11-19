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
  const pp = input.printProfile;
  const [top, bottom] = [mm(m.top, 25), mm(m.bottom, 25)];
  // T0B-PRINTCFG-1 (LD-316): with a profile, paper_mode decides. preprinted_paper: the margin IS the profile reserve (the lab own pad prints there;
  // [CONV] at least 5 mm, the printer's unprintable edge); typed_header_footer / plain: the template margin only; letterhead_image: as the letterhead variant.
  let [t, b] = [`calc(${top} + ${mm(lh.plain_reserve_top_mm)})`, `calc(${bottom} + ${mm(lh.plain_reserve_bottom_mm)})`];
  if (pp?.paper_mode === 'preprinted_paper') [t, b] = [mm(Math.max(pp.reserve_top_mm, 5)), mm(Math.max(pp.reserve_bottom_mm, 5))];
  else if (pp && pp.paper_mode !== 'letterhead_image') [t, b] = [top, bottom];
  const out = `@page{size:${size};margin:${t} ${mm(m.right, 10)} ${b} ${mm(m.left, 10)}}\n`;
  if (pp ? pp.paper_mode !== 'letterhead_image' : variant !== 'letterhead') return out;
  const band = (box: 'top-center' | 'bottom-center', ref: Parameters<typeof assets.dataUri>[0] | undefined, pad: string) => {
    if (!ref) return '';
    let uri = dataImage(assets, ref);
    // T0B-PRINTCFG-1 grayscale: a margin box background ignores CSS filter, so the (already validated) image is wrapped in an SVG with a desaturate filter.
    if (pp?.grayscale) {
      uri = `"data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100%" height="100%">` +
        `<filter id="g"><feColorMatrix type="saturate" values="0"/></filter><image width="100%" height="100%" filter="url(#g)" xlink:href="${uri}"/></svg>`).toString('base64')}"`;
    }
    return `@${box}{content:"";width:100%;${box === 'top-center' ? 'padding-top' : 'padding-bottom'}:${pad};` +
      `background-image:url(${uri});background-size:contain;background-repeat:no-repeat;background-position:center;background-origin:content-box;background-clip:content-box}`;
  };
  const head = pp || lh.header_asset === 'branding' ? band('top-center', d.lab.headerAssetRef ?? d.lab.logoAssetRef, top) : '';
  const foot = pp || lh.footer_asset === 'branding' ? band('bottom-center', d.lab.footerAssetRef, bottom) : '';
  return head || foot ? `${out}@page{${head}${foot}}\n` : out;
}
