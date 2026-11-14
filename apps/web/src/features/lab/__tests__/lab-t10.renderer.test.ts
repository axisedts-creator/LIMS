// @vitest-environment jsdom
// C5 T-10 — htmlSvgRenderer (02-TRD §4.6 interface; PRD AC-02.4; 04-UI-UX §3.1 label layout + copy). done_when: "print CSS sized from the #14 response".
// Module under test: apps/web/src/features/lab/components/labels/LabelRenderer.ts  exporting `htmlSvgRenderer: LabelRenderer` and type `LabelData` (camelCase, exactly the TRD §4.6 interface).
// render(labels, { widthMm, heightMm }) -> HTML string. ASSUMED seams (spec silent): every PHYSICAL label (one per copy) is an element with data-testid="label"; the barcode is a Code 128 <svg>
// produced by @lims/ui BarcodeSymbol (C0-0D); the print CSS is a <style> in the string containing `@page { size: <w>mm <h>mm }` and the label box width/height in mm.
import { describe, expect, it } from 'vitest';

type Renderer = { format: string; render(l: readonly any[], size: { widthMm: number; heightMm: number }): string };
const modName = 'LabelRenderer'; // variable path: a missing module fails each test, not the whole file at collection
const load = async () => (await import(/* @vite-ignore */ `../components/labels/${modName}`)) as { htmlSvgRenderer: Renderer };
const base = { specimenId: '01a1a98a-ac40-7000-8000-000000000001', barcode: 'E2600000042', patientName: 'TEST PATIENT 0042', ageSex: '43Y/M', registrationNo: '0001SY000001', specimenTypeCode: 'WB',
  containerCode: 'EDTA', collectedOn: '2026-06-15', testCodes: ['CBC', 'ESR', 'HBA1C'], moreTests: 2, urgent: false, copies: 1 };
const html = async (labels: any[], size = { widthMm: 50, heightMm: 25 }) => {
  const { htmlSvgRenderer } = await load();
  const raw = htmlSvgRenderer.render(labels, size);
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${raw}</body>`, 'text/html');
  return { doc, text: (doc.body.textContent ?? '').replace(/\s+/g, ' '), raw };
};
const labelsIn = (doc: Document) => [...doc.querySelectorAll('[data-testid="label"]')];

describe('htmlSvgRenderer', () => {
  it('is the Phase-1 html_svg renderer', async () => {
    expect((await load()).htmlSvgRenderer.format).toBe('html_svg');
  });

  it('AC-02.4: every field — Code 128 barcode <svg>, human-readable barcode, name, age/sex, reg no, type, container, collection date, test codes, "+n"', async () => {
    const { doc, text } = await html([base]);
    const [label] = labelsIn(doc);
    expect(label, 'one data-testid="label" element').toBeTruthy();
    expect(label!.querySelector('svg')).not.toBeNull();
    for (const s of ['E2600000042', 'TEST PATIENT 0042', '43Y/M', '0001SY000001', 'WB', 'EDTA', 'CBC', 'ESR', 'HBA1C', '+2']) expect(text, s).toContain(s);
    expect(text).toMatch(/15\/06\/2026|2026-06-15/); // collection date shown (format is the writer's; 04-UI-UX sample uses dd/mm/yyyy)
    expect(text).not.toContain('URGENT');
  });

  it('★ URGENT only when urgent', async () => {
    expect((await html([{ ...base, urgent: true }])).text).toContain('★ URGENT');
    expect((await html([{ ...base, urgent: false }])).text).not.toContain('★');
  });

  it('collection date appears only if collected; container optional; no "+n" when moreTests = 0', async () => {
    const { text } = await html([{ ...base, collectedOn: undefined, containerCode: undefined, moreTests: 0 }]);
    expect(text).not.toMatch(/2026|15\/06/);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('+');
  });

  it('patient name is truncated to 24 characters [CONV]', async () => {
    const name = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123';
    const { text } = await html([{ ...base, patientName: name }]);
    expect(text).toContain(name.slice(0, 24));
    expect(text).not.toContain(name.slice(0, 25));
  });

  it('copies: one label element per copy; several specimens keep their own copies', async () => {
    const { doc } = await html([{ ...base, copies: 3 }, { ...base, specimenId: '01a1a98a-ac40-7000-8000-000000000002', barcode: 'E2600000043', copies: 2 }]);
    expect(labelsIn(doc)).toHaveLength(5);
    expect(labelsIn(doc).filter((l) => (l.textContent ?? '').includes('E2600000043'))).toHaveLength(2);
  });

  it('print CSS is sized from the size argument (the #14 response), not a constant: @page size + label box in mm', async () => {
    for (const [w, h] of [[60, 30], [50, 25], [100, 60]] as const) {
      const { raw } = await html([base], { widthMm: w, heightMm: h });
      expect(raw, `${w}x${h}`).toMatch(new RegExp(`@page[^}]*size:\\s*${w}mm\\s+${h}mm`));
      expect(raw).toMatch(new RegExp(`width:\\s*${w}mm`));
      expect(raw).toMatch(new RegExp(`height:\\s*${h}mm`));
    }
  });

  it('a barcode that cannot fit at >= 0.25 mm module width renders the warning instead of a degraded symbol (TRD §4.6)', async () => {
    const small = await html([base], { widthMm: 20, heightMm: 10 });
    expect(small.text).toContain('Label too small for this barcode');
    expect(labelsIn(small.doc)[0]?.querySelector('svg') ?? null).toBeNull();
    const fits = await html([base], { widthMm: 50, heightMm: 25 });
    expect(fits.text).not.toContain('Label too small');
    expect(labelsIn(fits.doc)[0]!.querySelector('svg')).not.toBeNull();
  });

  it('attack: HTML in patient / test / type fields is escaped — no element injected, no handler attribute', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const { doc } = await html([{ ...base, patientName: evil, ageSex: evil, testCodes: [evil], specimenTypeCode: evil, containerCode: evil, registrationNo: evil }]);
    expect(doc.querySelector('img')).toBeNull();
    expect(doc.querySelector('[onerror]')).toBeNull();
    expect(doc.body.textContent).toContain('onerror'); // shown as text
  });

  it('empty list renders no label and does not throw', async () => {
    expect(labelsIn((await html([])).doc)).toHaveLength(0);
  });
});
