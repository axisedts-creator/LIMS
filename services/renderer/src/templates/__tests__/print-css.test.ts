// C6-T36 — shared print stylesheet carries the smart-* classes of CR-C14-007 (02-TRD §5.3: smart fragments may use only classes from this stylesheet).
// Static test of services/renderer/src/templates/print.css. Class list copied verbatim from spec/chunks/C14-smart-report/02-TRD.md CR-C14-007.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const css = readFileSync(fileURLToPath(new URL('../print.css', import.meta.url)), 'utf8');
const CLASSES = ['smart-section', 'smart-title', 'smart-notice', 'smart-score', 'smart-score-value', 'smart-score-band', 'smart-tiles', 'smart-tile', 'smart-tile-name',
  'smart-tile-status', 'smart-status-in_range', 'smart-status-borderline', 'smart-status-out_of_range', 'smart-status-critical', 'smart-subtitle', 'smart-list',
  'smart-trends', 'smart-disclaimer', 'smart-meta'];
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const selectors = stripComments(css).split('{').slice(0, -1).map((chunk) => chunk.split('}').pop()!).join(',');

describe('print.css — smart-* classes (CR-C14-007)', () => {
  it.each(CLASSES)('has a rule for .%s', (c) => { expect(selectors).toMatch(new RegExp(`\\.${c}(?![\\w-])`)); });
  it('every smart-* class used in a selector is one of the 19 agreed classes (no invented names)', () => {
    const used = new Set([...selectors.matchAll(/\.(smart-[\w-]+)/g)].map((m) => m[1]));
    for (const u of used) expect(CLASSES, u).toContain(u);
  });
  it('status is never colour alone: each .smart-status-* rule also sets a non-colour cue (border, font-weight, text-decoration or content)', () => {
    for (const s of ['in_range', 'borderline', 'out_of_range', 'critical']) {
      const m = stripComments(css).match(new RegExp(`\\.smart-status-${s}(?![\\w-])[^{]*\\{([^}]*)\\}`));
      expect(m, s).not.toBeNull();
      expect(m![1], s).toMatch(/border|font-weight|text-decoration|content/);
    }
  });
  it('REQ-SEC-086: no @import, no url() other than data: URIs', () => {
    const c = stripComments(css);
    expect(c).not.toMatch(/@import/i);
    for (const m of c.matchAll(/url\(\s*['"]?([^)'"]*)/gi)) expect(m[1], m[0]).toMatch(/^data:/i);
  });
});
