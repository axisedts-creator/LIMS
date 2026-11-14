// C6-T05 — AC-03.4: Devanagari round-trip (synthetic name), Noto Sans Devanagari embedded, text extraction == NFC input.
// API assumed as in guard.test.ts. Fonts must come from services/renderer/fonts/ (bundled), not from the host.
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../pool.js';
import { norm, pdfFontNames, pdfText } from './helpers/pdf-text.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let pool: Awaited<ReturnType<typeof createPool>>;
beforeAll(async () => {
  pool = await createPool({ contexts: 2 });
});
afterAll(async () => {
  await pool?.close();
});

// 02-TRD §5.1: fonts live in the image's fontconfig only (no @font-face). Image-only check: skipped (with a logged reason) solely when
// fontconfig on this host has no Noto Sans Devanagari; run the suite inside Dockerfile.renderer to exercise it.
const hostHasFont = (() => {
  try {
    return /Noto Sans Devanagari/i.test(execFileSync('fc-list', [':family=Noto Sans Devanagari'], { encoding: 'utf8' }));
  } catch {
    return false;
  }
})();
if (!hostHasFont) console.warn('[C6-T05] SKIP "embeds Noto Sans Devanagari": not in host fontconfig (fc-list); run in the Dockerfile.renderer image');

const NAME = 'परीक्षण बिरामी'; // synthetic
const html = (body: string) =>
  `<!doctype html><html lang="ne"><head><meta charset="utf-8"><style>body{font-family:'Noto Sans Devanagari','Noto Sans',sans-serif;font-size:14pt}</style></head><body>${body}</body></html>`;

describe('AC-03.4', () => {
  it.skipIf(!hostHasFont)('embeds Noto Sans Devanagari', async () => {
    const { pdf } = await pool.renderHtml(html(`<p>${NAME}</p>`));
    expect(pdfFontNames(pdf).some((n) => /NotoSansDevanagari/i.test(n.replace(/[-_ ]/g, '')))).toBe(true);
  });

  it('text extraction returns the same Unicode string (NFC)', async () => {
    const { pdf } = await pool.renderHtml(html(`<p>Name: ${NAME}</p>`));
    expect(norm(pdfText(pdf))).toContain(NAME.normalize('NFC'));
  });

  it('NFD input still extracts as the NFC string', async () => {
    const nfd = NAME.normalize('NFD');
    const { pdf } = await pool.renderHtml(html(`<p>${nfd}</p>`));
    expect(norm(pdfText(pdf))).toContain(NAME.normalize('NFC'));
  });

  it('mixed Latin + Devanagari + digits in one line round-trips', async () => {
    const line = `Reg No 12345 · ${NAME} · Kathmandu`;
    const { pdf } = await pool.renderHtml(html(`<p>${line}</p>`));
    expect(norm(pdfText(pdf))).toContain(norm(line));
  });

  it('user text is data, not markup: escaped HTML renders literally', async () => {
    const evil = '&lt;b&gt;X&lt;/b&gt; परीक्षण';
    const { pdf } = await pool.renderHtml(html(`<p>${evil}</p>`));
    expect(norm(pdfText(pdf))).toContain('<b>X</b> परीक्षण');
  });
});
