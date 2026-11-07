// C6-T05 — done_when: "spike decision recorded in services/renderer/DECISIONS.md"; fonts bundled; Dockerfile.renderer hardening (REQ-SEC-129/130).
// DECISIONS.md contract (assumed format, same style as db/meta/decisions/SP-*.md): a line "Technique: <one of>" where <one of> is
//   page.pdf-header-footer | thead-tfoot | fixed-position
// plus evidence (a code block) and the sentence that "Page N Of M" is stamped by the sandbox, not Chromium (02-TRD §5.1).
// The technique test below renders a 3-page document with the RECORDED technique and checks header+footer text on EVERY page (AC-03.2 gate, text-extraction only).
// For page.pdf-header-footer the pool must accept renderHtml(html, { pdf: { displayHeaderFooter, headerTemplate, footerTemplate, margin } }).
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../pool.js';
import { norm, pdfPages } from './helpers/pdf-text.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const read = (p: string) => {
  expect(existsSync(root(p)), `${p} must exist`).toBe(true);
  return readFileSync(root(p), 'utf8');
};

const TECHNIQUES = ['page.pdf-header-footer', 'thead-tfoot', 'fixed-position'] as const;
const technique = () => {
  const m = /^\s*[-*]?\s*\**Technique\**\s*:\**\s*`?([a-z.\-]+)`?/im.exec(read('DECISIONS.md'));
  return m?.[1] as (typeof TECHNIQUES)[number] | undefined;
};

describe('DECISIONS.md (spike record)', () => {
  it('records exactly one chosen technique from the three candidates', () => {
    expect(TECHNIQUES).toContain(technique());
  });
  it('names all three candidates as considered, with a reason for the choice', () => {
    const t = read('DECISIONS.md');
    expect(t).toMatch(/page\.pdf/i);
    expect(t).toMatch(/thead|tfoot/i);
    expect(t).toMatch(/fixed/i);
    expect(t).toMatch(/\b(because|reason|why|rejected)\b/i);
  });
  it('has evidence in a code block and pins the Playwright version used', () => {
    const t = read('DECISIONS.md');
    expect(t).toMatch(/```/);
    expect(t).toMatch(/playwright[^\n]*\d+\.\d+\.\d+/i);
  });
  it('records the watermark technique and its per-page result (04-UI-UX §Watermark: confirmed per page by spike C6-T05)', () => {
    expect(read('DECISIONS.md')).toMatch(/watermark/i);
  });
  it('states "Page N Of M" is stamped by the sandbox, not Chromium', () => {
    expect(read('DECISIONS.md')).toMatch(/sandbox/i);
    expect(read('DECISIONS.md')).toMatch(/Page N Of M/);
  });
});

describe('bundled fonts (02-TRD §1 Fonts, OFL-1.1)', () => {
  const files = () => {
    expect(existsSync(root('fonts')), 'fonts/ must exist').toBe(true);
    return readdirSync(root('fonts'));
  };
  it('has Noto Sans Devanagari, a Latin Noto Sans and Noto Sans Mono font files', () => {
    const f = files().filter((n) => /\.(ttf|otf)$/i.test(n));
    expect(f.some((n) => /NotoSansDevanagari/i.test(n))).toBe(true);
    expect(f.some((n) => /^NotoSans-/i.test(n) || /^NotoSans\[/i.test(n))).toBe(true);
    expect(f.some((n) => /NotoSansMono/i.test(n))).toBe(true);
  });
  it('ships the licence alongside (OFL)', () => {
    expect(files().some((n) => /OFL|LICENSE|LICENCE/i.test(n))).toBe(true);
  });
});

describe('Dockerfile.renderer (REQ-SEC-129/130)', () => {
  it('runs as a non-root user, installs the bundled fonts into fontconfig, uses Playwright-managed Chromium', () => {
    const d = read('Dockerfile.renderer');
    const users = [...d.matchAll(/^\s*USER\s+(\S+)/gim)].map((m) => m[1]!.toLowerCase());
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).not.toMatch(/^(root|0)(:|$)/);
    expect(d).toMatch(/COPY[^\n]*fonts/i);
    expect(d).toMatch(/fc-cache|fontconfig/i);
    expect(d).toMatch(/playwright/i);
  });
  it('contains no secrets and no database/storage credentials', () => {
    const d = read('Dockerfile.renderer');
    expect(d).not.toMatch(/(PASSWORD|SECRET|API_KEY|DATABASE_URL|SERVICE_ROLE)/i);
  });
});

describe('repeated header/footer technique (AC-03.2 gate, text extraction)', () => {
  let pool: Awaited<ReturnType<typeof createPool>>;
  beforeAll(async () => {
    pool = await createPool({ contexts: 2 });
  });
  afterAll(async () => {
    await pool?.close();
  });

  const body = Array.from({ length: 3 }, (_, i) => `<div style="height:230mm">BODY-${i + 1}</div>`).join('');
  const HDR = 'HDR-Name Age/Gender RegNo';
  const FTR = 'FTR-Signatories Disclaimer Contact';

  const build = (t: (typeof TECHNIQUES)[number]) => {
    const head = `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:25mm 10mm 25mm 10mm}</style>`;
    if (t === 'thead-tfoot')
      return { html: `${head}<table><thead><tr><td>${HDR}</td></tr></thead><tfoot><tr><td>${FTR}</td></tr></tfoot><tbody><tr><td>${body}</td></tr></tbody></table>` };
    if (t === 'fixed-position')
      return { html: `${head}<div style="position:fixed;top:-20mm;left:0">${HDR}</div><div style="position:fixed;bottom:-20mm;left:0">${FTR}</div>${body}` };
    return {
      html: `${head}${body}`,
      opts: {
        pdf: {
          displayHeaderFooter: true,
          headerTemplate: `<div style="font-size:9px">${HDR}</div>`,
          footerTemplate: `<div style="font-size:9px">${FTR}</div>`,
          margin: { top: '25mm', bottom: '25mm' },
        },
      },
    };
  };

  it('the recorded technique prints the patient header and the footer on every page', async () => {
    const t = technique();
    expect(TECHNIQUES).toContain(t);
    const { html, opts } = build(t!);
    const { pdf, pageCount } = await pool.renderHtml(html, opts as never);
    const pages = pdfPages(pdf).map(norm);
    expect(pageCount).toBeGreaterThanOrEqual(3);
    expect(pages).toHaveLength(pageCount);
    for (const [i, p] of pages.entries()) {
      expect(p, `page ${i + 1} header`).toContain(HDR);
      expect(p, `page ${i + 1} footer`).toContain(FTR);
    }
  });

  // 04-UI-UX §Watermark: `position: fixed` centred, rotated −30°, 48 pt, opacity; must appear on EVERY page.
  it('a fixed, centred, rotated watermark is extracted on every page of a 3-page document', async () => {
    const WM = 'WMARKTEXT';
    const html =
      `<!doctype html><meta charset="utf-8"><style>@page{size:A4;margin:25mm 10mm}</style>` +
      `<div style="position:fixed;top:50%;left:50%;transform:translate(-50%,-50%) rotate(-30deg);font-size:48pt;opacity:.08">${WM}</div>` +
      body;
    const { pdf, pageCount } = await pool.renderHtml(html);
    const pages = pdfPages(pdf).map(norm);
    expect(pageCount).toBeGreaterThanOrEqual(3);
    for (const [i, p] of pages.entries()) expect(p, `page ${i + 1} watermark`).toContain(WM);
  });
});
