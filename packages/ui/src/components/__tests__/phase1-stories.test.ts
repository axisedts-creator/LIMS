// T0D-12b done_when "stories": every Phase-1 consumer component (C2, C3, C4, C6, C7, C8) has a story file with >=1 story
// (the axe scan over them is stories-axe.test.tsx, which globs every *.stories.tsx — AC-0D-8.6), a module that exports the component,
// and QrCode is NOT built (CR-C13-013 withdrawn, 04-UI-UX:244). C9/C13/C14/C16-only components are out of the Phase-1 set.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS = fileURLToPath(new URL('..', import.meta.url));
const PHASE1 = [
  'CodeField', 'FormulaEditor', 'OtpInput', 'RichTextEditor', 'KeyValueListEditor', 'PeriodPicker', // 2.2
  'EditableGrid', 'DiffTable', 'PermissionMatrix', 'DataUriImage', 'StatusStepper', 'CodeBlock', 'SecretRevealOnce', // 2.5
  'ImageThumbnailGrid', 'PdfFileCard', 'DurationText', 'FreshnessBadge', // 2.5
  'PrintFrame', // 2.6
];
const read = (p: string) => readFileSync(p, 'utf8');

describe('Phase-1 consumer component set is present', () => {
  it.each(PHASE1)('%s: component file exports it and a story file exists with >=1 story', (n) => {
    const comp = join(COMPONENTS, n, `${n}.tsx`);
    const story = join(COMPONENTS, n, `${n}.stories.tsx`);
    expect(existsSync(comp), `missing ${comp}`).toBe(true);
    expect(existsSync(story), `missing ${story}`).toBe(true);
    expect(read(comp)).toMatch(new RegExp(`export (function|const) ${n}\\b`));
    expect(read(story)).toMatch(/export default/);
    expect(read(story)).toMatch(/export const \w+/);
  });
  it('RichTextEditor module also exports SafeHtml (C6 04-UI-UX:137, no dangerouslySetInnerHTML in feature code)', () => {
    expect(read(join(COMPONENTS, 'RichTextEditor', 'RichTextEditor.tsx'))).toMatch(/export (function|const) SafeHtml\b/);
  });
  it('QrCode is not built (CR-C13-013 withdrawn)', () => {
    expect(existsSync(join(COMPONENTS, 'QrCode'))).toBe(false);
  });
  it('C16-only WeekdayTimeRangeEditor, C9 ControlChart, C14 TextDiff, C16 QueueBoard/TokenSlip are not part of the Phase-1 set (later wave)', () => {
    // documentation test: they may exist later, but must not be required now; nothing to assert beyond the set above being complete.
    expect(PHASE1).not.toContain('QrCode');
  });
});

describe('REQ-SEC-088 / DataUriImage: no inline-SVG path', () => {
  it('DataUriImage source does not parse or inject SVG markup', () => {
    const f = join(COMPONENTS, 'DataUriImage', 'DataUriImage.tsx');
    expect(existsSync(f), `missing ${f}`).toBe(true);
    expect(read(f)).not.toMatch(/DOMParser|atob\(|<svg|createElementNS|insertAdjacent/);
  });
});
