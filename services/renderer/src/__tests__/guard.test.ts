// C6-T05 — request guard + JS-off (AC-03.8, REQ-SEC-086, 02-TRD §5.1/§14 SSRF canaries, 07-SECURITY T8/A11/test 11).
// ASSUMED API (spec names no signatures) — writer must match or raise a dispute:
//   pool.ts:  createPool(opts?: { contexts?, recycleAfter?, timeoutMs?, maxPages?, memoryLimitBytes? }): Promise<Pool>
//             Pool.renderHtml(html: string): Promise<{ pdf: Uint8Array; pageCount: number }>
//             Pool.stats(): { contextsBusy: number; recycles: number; blockedRequests: number; rendered: number }
//             Pool.close(): Promise<void>
//   guard.ts is exercised only through the pool (every context gets the guard; blocked requests feed stats().blockedRequests).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../pool.js';
import { norm, pdfText } from './helpers/pdf-text.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

let pool: Awaited<ReturnType<typeof createPool>>;
let canary: http.Server;
let hits: string[] = [];
let base = '';

beforeAll(async () => {
  canary = http.createServer((req, res) => {
    hits.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'text/css' }).end('body{color:red}');
  });
  await new Promise<void>((r) => canary.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(canary.address() as AddressInfo).port}`;
  pool = await createPool({ contexts: 2 });
});
afterAll(async () => {
  await pool?.close();
  await new Promise((r) => canary.close(r));
});

const page = (body: string, head = '') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body><p>BODY-OK</p>${body}</body></html>`;

describe('AC-03.8 — only data: URLs pass; everything else is blocked, PDF still renders', () => {
  it('blocks metadata IP, loopback canary, file:, CSS @import, <link>, font-face, background, meta refresh', async () => {
    hits = [];
    const before = pool.stats().blockedRequests;
    const html = page(
      `<img src="http://169.254.169.254/latest/meta-data/">
       <img src="${base}/img.png">
       <img src="file:///etc/passwd">
       <img src="file:///C:/Windows/win.ini">
       <iframe src="${base}/frame.html"></iframe>
       <div style="background:url(${base}/bg.png)">bg</div>`,
      `<style>@import url("${base}/import.css"); @font-face{font-family:X;src:url(${base}/font.woff2)} p{font-family:X}</style>
       <link rel="stylesheet" href="${base}/link.css">
       <meta http-equiv="refresh" content="0;url=${base}/refresh">`,
    );
    const { pdf, pageCount } = await pool.renderHtml(html);
    expect(pageCount).toBeGreaterThanOrEqual(1);
    expect(norm(pdfText(pdf))).toContain('BODY-OK'); // renders without the blocked resources
    expect(hits).toEqual([]); // canary server never contacted
    expect(pool.stats().blockedRequests - before).toBeGreaterThanOrEqual(6);
  });

  it('a data: image is allowed and is not counted as blocked', async () => {
    const px = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const before = pool.stats().blockedRequests;
    const { pdf } = await pool.renderHtml(page(`<img src="${px}" width="10" height="10">`));
    expect(norm(pdfText(pdf))).toContain('BODY-OK');
    expect(pool.stats().blockedRequests).toBe(before);
  });

  it('a blocked request in one render does not break the next render on the same pool', async () => {
    await pool.renderHtml(page(`<img src="http://169.254.169.254/">`));
    const { pdf } = await pool.renderHtml(page(''));
    expect(norm(pdfText(pdf))).toContain('BODY-OK');
  });
});

describe('REQ-SEC-086 — JavaScript disabled in every context', () => {
  it('inline <script>, event handlers and <script src> do not run or fetch', async () => {
    hits = [];
    const html = page(
      `<div id="t">STATIC</div>
       <script>document.getElementById('t').textContent='JS-RAN'; fetch('${base}/xhr')</script>
       <script src="${base}/s.js"></script>
       <img src="x" onerror="document.getElementById('t').textContent='JS-RAN'">
       <noscript>NOSCRIPT-VISIBLE</noscript>`,
    );
    const t = norm(pdfText((await pool.renderHtml(html)).pdf));
    expect(t).toContain('STATIC');
    expect(t).not.toContain('JS-RAN');
    expect(t).toContain('NOSCRIPT-VISIBLE'); // <noscript> renders only when scripting is off
    expect(hits).toEqual([]);
  });

  it('holds for every context of the pool (4 concurrent renders)', async () => {
    const html = page(`<div id="t">STATIC</div><script>document.getElementById('t').textContent='JS-RAN'</script>`);
    const outs = await Promise.all([1, 2, 3, 4].map(() => pool.renderHtml(html)));
    for (const o of outs) expect(norm(pdfText(o.pdf))).not.toContain('JS-RAN');
  });
});
