// T0D-13 done_when "stories + axe": every batch-2 component has a component file that exports it and a CSF3 story file with >=1 story
// (the axe scan over them is stories-axe.test.tsx, which globs every *.stories.tsx - AC-0D-8.6), plus source-level guards:
// REQ-SEC-088 (no dangerouslySetInnerHTML / innerHTML), REQ-SEC-081 (kit never serialises rows), 07-SECURITY:181 (BarcodeInput/useScanCapture never log or persist),
// REQ-SEC-141 / AC-0D-8.7 (no foreign touchpoint in charts), REQ-SEC-085 (FileUpload never previews).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const COMPONENTS = fileURLToPath(new URL('..', import.meta.url));
const BATCH2 = [
  'DataTable', 'FilterBar', 'Combobox', 'DatePicker', 'DateTimePicker', 'DateRangePicker', 'DateText', 'BarcodeInput', 'FileUpload',
  'Timeline', 'StatTile', 'TimeSeriesChart', 'BarChart', 'KeyboardShortcutsDialog',
];
const read = (n: string, ext: 'tsx' | 'stories.tsx' = 'tsx') => readFileSync(join(COMPONENTS, n, `${n}.${ext}`), 'utf8');

describe('batch-2 component set is present with stories', () => {
  it.each(BATCH2)('%s: component exports it; a story file exists with >=1 story', (n) => {
    const comp = join(COMPONENTS, n, `${n}.tsx`);
    const story = join(COMPONENTS, n, `${n}.stories.tsx`);
    expect(existsSync(comp), `missing ${comp}`).toBe(true);
    expect(existsSync(story), `missing ${story}`).toBe(true);
    expect(read(n)).toMatch(new RegExp(`export (function|const) ${n}\\b`));
    expect(read(n, 'stories.tsx')).toMatch(/export default/);
    expect(read(n, 'stories.tsx')).toMatch(/export const \w+/);
  });

  it('BarcodeInput.tsx also exports useScanCapture (package exports map is one .tsx per folder)', () => {
    expect(read('BarcodeInput')).toMatch(/export (function|const) useScanCapture\b/);
  });

  it('stories for the date components show a B.S. variant (AC-0D-8.5 is checkable in the story set)', () => {
    expect(read('DatePicker', 'stories.tsx')).toMatch(/calendar[=:]\s*['"{]+\s*BS/);
  });
});

describe('source guards over the batch-2 components', () => {
  const present = BATCH2.filter((n) => existsSync(join(COMPONENTS, n, `${n}.tsx`)));

  it('every batch-2 component file exists (guards below need them)', () => {
    expect(present).toEqual(BATCH2);
  });

  it.each(BATCH2)('%s: no dangerouslySetInnerHTML / innerHTML / outerHTML / insertAdjacentHTML / document.write (REQ-SEC-088)', (n) => {
    expect(read(n)).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write/);
  });

  it.each(BATCH2)('%s: no fetch/XHR/beacon/WebSocket/EventSource and no hard-coded remote URL (REQ-SEC-141)', (n) => {
    const src = read(n);
    expect(src).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|new WebSocket|new EventSource/);
    expect(src).not.toMatch(/['"`]https?:\/\//);
  });

  it.each(['BarcodeInput'])('%s: never logs, persists or URL-encodes a scanned value (07-SECURITY:181, REQ-SEC-098)', (n) => {
    expect(read(n)).not.toMatch(/console\.|localStorage|sessionStorage|indexedDB|document\.cookie|history\.(push|replace)State|location\.(href|search|hash|assign|replace)|BroadcastChannel/);
  });

  it('DataTable never serialises rows (REQ-SEC-081)', () => {
    expect(read('DataTable')).not.toMatch(/JSON\.stringify|structuredClone|toString\(\)\s*\)\s*\.join/);
  });

  it.each(['TimeSeriesChart', 'BarChart'])('%s: pure SVG, no foreignObject, no charting library import', (n) => {
    const src = read(n);
    expect(src).not.toMatch(/foreignObject/);
    expect(src).not.toMatch(/from ['"](chart\.js|recharts|d3[^'"]*|victory[^'"]*|nivo[^'"]*|echarts|highcharts|apexcharts|plotly[^'"]*)['"]/);
  });

  it('TimeSeriesChart draws values as given: no curve interpolation primitives (04-UI-UX §2.5)', () => {
    expect(read('TimeSeriesChart')).not.toMatch(/curveMonotone|curveBasis|curveCardinal|bezier|catmull|spline|smooth/i);
  });

  it('FileUpload never previews or reads untrusted files (REQ-SEC-085)', () => {
    expect(read('FileUpload')).not.toMatch(/createObjectURL|FileReader|readAs(DataURL|Text|ArrayBuffer)|<img|<iframe|<embed|<object/);
  });

  it('B.S. conversion goes only through @lims/shared-ts/bsdate; no raw library in the kit (04 D13, AC-0A-3.4)', () => {
    for (const n of ['DatePicker', 'DateTimePicker', 'DateRangePicker', 'DateText']) {
      expect(read(n)).not.toMatch(/nepali-date-converter|nepali_utils|bikram-sambat/);
    }
  });
});
