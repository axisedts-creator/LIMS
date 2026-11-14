// C14.T29 — structure/security of the LLM panel source (REQ-SEC-088/089: text nodes only, no dangerouslySetInnerHTML; 04-UI-UX: composed only from @lims/ui).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = () => readFileSync(new URL('../components/LlmPanel.tsx', import.meta.url), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('LlmPanel source', () => {
  it('exists and exports LlmPanel', () => { expect(src()).toMatch(/export\s+(function|const)\s+LlmPanel\b/); });
  it('never injects HTML', () => { expect(strip(src())).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write/); });
  it('uses only @lims/ui for chrome: Badge for "Kept original", Card (or TextDiff once shipped); no raw colours', () => {
    const s = strip(src());
    expect(s).toMatch(/from '@lims\/ui\/components\/Badge'/);
    expect(s).toMatch(/from '@lims\/ui\/components\/(Card|TextDiff)'/);
    expect(s).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgb\(/);
  });
  it('makes no network call itself (data arrives as props)', () => { expect(strip(src())).not.toMatch(/\bfetch\(|XMLHttpRequest|axios/); });
});
