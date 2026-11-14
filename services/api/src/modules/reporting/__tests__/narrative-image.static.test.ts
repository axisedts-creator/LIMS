// C6-T11 — static guards for the narrative-image path (07-SECURITY T9, REQ-SEC-083/085): SVG is never on an allow list, images are never
// processed by a shell/Chromium, and the N6 upload goes through ctx.uploads with the re-encode option (not a hand-rolled copy).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const API = join(here, '..');
const WORKER = join(here, '../../../../../worker/src/jobs/reporting');
function sources(dir: string): Array<{ file: string; text: string }> {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n); if (n === '__tests__') return [];
    return statSync(p).isDirectory() ? sources(p) : /\.ts$/.test(n) ? [{ file: p, text: readFileSync(p, 'utf8') }] : [];
  });
}
const all = [...sources(API), ...sources(WORKER)];

describe('reporting sources (non-test)', () => {
  it('scanned a meaningful number of files', () => expect(all.length).toBeGreaterThan(8));
  it('image/svg is never named (no allow-list entry, no content type)', () => { for (const s of all) expect(s.text, s.file).not.toMatch(/image\/svg|\.svg\b|\bsvg\+xml/i); });
  it('no shell / child process / Chromium anywhere in the intake path', () => { for (const s of all) expect(s.text, s.file).not.toMatch(/child_process|\bexecSync\b|\bspawn(Sync)?\(|puppeteer|playwright|chromium/i); });
  it('the narrative image handler uses ctx.uploads.accept with images.reencode and an allow list of exactly png + jpeg', () => {
    const svc = all.filter((s) => /narrative/i.test(s.file) && !/\.test\./.test(s.file) && /uploads\.accept/.test(s.text));
    expect(svc.length, 'a narrative upload service must call ctx.uploads.accept').toBeGreaterThan(0);
    for (const s of svc) {
      expect(s.text, s.file).toMatch(/images\s*:\s*\{[^}]*reencode\s*:\s*true/); expect(s.text, s.file).toMatch(/stripMetadata\s*:\s*true/);
      const allow = /allow\s*:\s*\[([^\]]*)\]/.exec(s.text)?.[1] ?? ''; expect(allow.match(/image\/(png|jpeg)/g)?.sort()).toEqual(['image/jpeg', 'image/png']); expect(allow).not.toMatch(/pdf|svg|gif|webp/i);
    }
  });
  it('SQL on narrative_image rows is static: no template-literal interpolation into reporting.input_files statements', () => {
    for (const s of all.filter((x) => /repository/.test(x.file))) expect(s.text, s.file).not.toMatch(/`[^`]*\$\{[^}]*\}[^`]*\breporting\.input_files\b|\breporting\.input_files\b[^`]*\$\{/);
  });
});
