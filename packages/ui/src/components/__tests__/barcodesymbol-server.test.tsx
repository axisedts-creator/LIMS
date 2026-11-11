// @vitest-environment node
// T0D-12c / LD-107: BarcodeSymbol must work in react-dom/server renderToStaticMarkup with NO DOM (label PDFs / print are rendered server-side by C5).
// Node environment on purpose: any document/window/effect use throws here.
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { BarcodeSymbol, code128Modules } from '../BarcodeSymbol/BarcodeSymbol';

describe('server render (no DOM available)', () => {
  it('this file really runs without a DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });

  it('renders a static <svg> with viewBox in modules, role=img, aria-label and crispEdges', () => {
    const v = 'LAB-2026-000123';
    const m = renderToStaticMarkup(<BarcodeSymbol value={v} />);
    expect(m.startsWith('<svg')).toBe(true);
    const vb = m.match(/viewBox="0 0 (\d+) (\d+)"/);
    expect(vb, 'viewBox="0 0 W H"').not.toBeNull();
    expect(Number(vb![1])).toBe(code128Modules(v));
    expect(Number(vb![2])).toBeGreaterThan(0);
    expect(m).toMatch(/role="img"/);
    expect(m).toMatch(/aria-label="[^"]*LAB-2026-000123[^"]*"/);
    expect(m).toMatch(/shape-rendering="crispEdges"/);
    expect(m).not.toMatch(/<(script|style|foreignObject|image|use)\b|\son[a-z]+=|dangerouslySetInnerHTML/i);
  });

  it('draws black bars on a white background, literal colours (scanner contrast whatever the theme)', () => {
    const m = renderToStaticMarkup(<BarcodeSymbol value="AB-12" />);
    expect(m).toMatch(/fill="(#fff|#ffffff|white)"/i);
    expect(m).toMatch(/fill="(#000|#000000|black)"/i);
    expect(m).not.toMatch(/currentColor|var\(--|hsl|oklch/i);
  });

  it('is deterministic (same input, same markup) and has no per-render ids', () => {
    const a = renderToStaticMarkup(<BarcodeSymbol value="AB-12" showText />);
    const b = renderToStaticMarkup(<BarcodeSymbol value="AB-12" showText />);
    expect(a).toBe(b);
    expect(a).not.toMatch(/id="/);
  });

  it('moduleWidthMm sets the svg width in mm', () => {
    const m = renderToStaticMarkup(<BarcodeSymbol value="A" moduleWidthMm={0.33} />);
    const w = m.match(/<svg[^>]*\swidth="([\d.]+)mm"/);
    expect(w, 'width="<n>mm"').not.toBeNull();
    expect(parseFloat(w![1])).toBeCloseTo(code128Modules('A') * 0.33, 3);
  });

  it('invalid value throws on the server too, with no value in the message', () => {
    const v = 'zq-secret-77';
    let err: Error | undefined;
    try { renderToStaticMarkup(<BarcodeSymbol value={v} />); } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).not.toContain(v);
  });
});
