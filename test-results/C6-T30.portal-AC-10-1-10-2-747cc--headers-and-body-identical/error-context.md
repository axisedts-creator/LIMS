# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: C6-T30.portal.spec.ts >> AC-10.1 / 10.2 / 10.3 QR verify >> unknown / revoked / unreleased / malformed: status, headers and body identical
- Location: ..\..\tests\portal-e2e\C6-T30.portal.spec.ts:317:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 4
```

# Test source

```ts
  224 |     await expect(page).toHaveURL(new RegExp(`/r/${T('ok')}(/code)?$`));
  225 |     await expect(page.getByText('Complete Blood Count')).toHaveCount(0);
  226 |   });
  227 | 
  228 |   test('Sign out ends the session (P6) and clears the cookie', async ({ page, context }) => {
  229 |     await login(page, 'ok');
  230 |     const out = page.getByRole('button', { name: 'Sign out' });
  231 |     if (await out.count()) await out.click(); else await page.getByRole('link', { name: 'Sign out' }).click();
  232 |     await expect.poll(async () => (await apiLog()).some((r) => r.url === '/v1/reporting/portal/sessions/end' && r.method === 'POST')).toBe(true);
  233 |     expect((await context.cookies(PORTAL)).find((x) => x.name === COOKIE)).toBeUndefined();
  234 |   });
  235 | });
  236 | 
  237 | test.describe('AC-11.9 headers on /r/ and /v/ pages (REQ-SEC-089/090)', () => {
  238 |   for (const path of [`/r/${T('ok')}`, `/r/${T('ok')}/code`, `/r/${T('ok')}/report`, `/v/${T('qrok')}`, `/v/${T('qrunk')}`]) {
  239 |     test(`headers ${path.replace(/0{4,}/, '…')}`, async ({ request }) => {
  240 |       const h = (await request.get(path, { maxRedirects: 0 })).headers();
  241 |       expect(h['referrer-policy']).toBe('no-referrer');
  242 |       expect(h['cache-control']).toContain('no-store');
  243 |       expect(h['x-content-type-options']).toBe('nosniff');
  244 |       expect(h['strict-transport-security']).toMatch(/max-age=63072000/);
  245 |       const csp = h['content-security-policy'] ?? h['content-security-policy-report-only'];
  246 |       expect(csp, 'CSP header').toBeTruthy();
  247 |       expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);
  248 |       expect(csp).toContain("object-src 'none'");
  249 |       expect(csp).toContain("frame-ancestors 'none'");
  250 |       expect(csp).toMatch(/form-action 'self'/);
  251 |       expect(csp).toMatch(/default-src 'self'/);
  252 |     });
  253 |   }
  254 |   test('no third-party requests (all sub-requests stay on the portal origin)', async ({ page }) => {
  255 |     const origins = new Set<string>();
  256 |     page.on('request', (r) => { origins.add(new URL(r.url()).origin); });
  257 |     await page.goto(`/r/${T('ok')}`);
  258 |     await page.goto(`/v/${T('qrok')}`);
  259 |     expect([...origins]).toEqual([PORTAL]);
  260 |   });
  261 |   test('client IP: X-Forwarded-For is forwarded as received with the portal BFF key (D-32)', async ({ request }) => {
  262 |     await request.get(`/v/${T('qrok')}`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  263 |     const q = (await apiLog()).find((r) => r.url === '/v1/reporting/verifications');
  264 |     expect(q.xff).toBe('203.0.113.7');
  265 |     expect(q.bffKey).toBe(BFF_KEY);
  266 |     expect(JSON.stringify(q)).not.toMatch(/\?/); // token in body, not URL
  267 |     expect(q.body).toEqual({ qr_token: T('qrok') });
  268 |   });
  269 |   test('state changes are POST only with an Origin check (REQ-SEC-091/092)', async ({ request }) => {
  270 |     expect((await request.get(`/r/${T('exp')}/reissue`, { maxRedirects: 0 })).status()).toBe(405);
  271 |     const bad = await request.post(`/r/${T('exp')}/reissue`, { headers: { origin: 'https://evil.example' }, maxRedirects: 0 });
  272 |     expect(bad.status()).toBe(403);
  273 |     expect((await apiLog()).some((r) => r.url === '/v1/reporting/portal/link-reissues')).toBe(false);
  274 |   });
  275 | });
  276 | 
  277 | test.describe('AC-11.11 Health summary', () => {
  278 |   test('NULL snapshot: no heading, no placeholder', async ({ page }) => {
  279 |     await login(page, 'ok');
  280 |     await expect(page.getByText(/health summary/i)).toHaveCount(0);
  281 |   });
  282 |   test('set snapshot: read-only section with N1 + disclaimerText, no controls, no links', async ({ page }) => {
  283 |     await login(page, 'smart');
  284 |     const sec = page.locator('section', { has: page.getByRole('heading', { name: 'Health summary' }) });
  285 |     await expect(sec).toBeVisible();
  286 |     await expect(sec).toContainText("This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor.");
  287 |     await expect(sec).toContainText('SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS');
  288 |     await expect(sec).toContainText('Serum Ferritin');
  289 |     expect(await sec.locator('input, button, select, textarea, a').count()).toBe(0);
  290 |     const calls = (await apiLog()).map((r) => r.url);
  291 |     expect(calls.every((u) => u.startsWith('/v1/reporting/'))).toBe(true); // zero SmartReport calls on the request path
  292 |   });
  293 |   test('unrenderable snapshot: error copy; rest of the page and Download unaffected', async ({ page }) => {
  294 |     await login(page, 'badsmart');
  295 |     await expect(page.getByRole('heading', { name: 'Health summary' })).toBeVisible();
  296 |     await expect(page.getByText('Your health summary cannot be shown right now. Your full report is available to download above.')).toBeVisible();
  297 |     await expect(page.getByRole('link', { name: 'Download PDF' }).or(page.getByRole('button', { name: 'Download PDF' }))).toBeVisible();
  298 |   });
  299 | });
  300 | 
  301 | test.describe('AC-10.1 / 10.2 / 10.3 QR verify', () => {
  302 |   test('valid: genuine banner + only the allowed fields', async ({ page }) => {
  303 |     await page.goto(`/v/${T('qrok')}`);
  304 |     await expect(page.getByText('This report is genuine.')).toBeVisible();
  305 |     const t = await page.locator('main').innerText();
  306 |     for (const k of ['Laboratory', 'Patient', 'Tests', 'Issued', 'Version']) expect(t).toContain(k);
  307 |     expect(t).toContain('Test Diagnostics');
  308 |     expect(t).toContain('A.B.');
  309 |     expect(t).toContain('Complete Blood Count');
  310 |     expect(t).not.toMatch(/phone|address|date of birth|result|\bDOB\b/i);
  311 |   });
  312 |   test('superseded status', async ({ page }) => {
  313 |     await page.goto(`/v/${T('qrsup')}`);
  314 |     await expect(page.getByText(/Superseded — a newer version of this report exists|This report was replaced by a newer version\./)).toBeVisible();
  315 |     await expect(page.getByText('This report is genuine.')).toHaveCount(0);
  316 |   });
  317 |   test('unknown / revoked / unreleased / malformed: status, headers and body identical', async ({ request }) => {
  318 |     const shots: string[] = [];
  319 |     for (const tok of [T('qrunk'), T('qrrev'), T('qrunrel'), 'x!']) {
  320 |       const r = await request.get(`/v/${tok}`, { maxRedirects: 0 });
  321 |       const h = { ...r.headers() }; delete h.date; delete h['content-length']; delete h.etag; delete h['x-request-id'];
  322 |       shots.push(norm(JSON.stringify({ s: r.status(), h, b: (await r.text()).split(tok).join('TOKEN') })));
  323 |     }
> 324 |     expect(new Set(shots).size).toBe(1);
      |                                 ^ Error: expect(received).toBe(expected) // Object.is equality
  325 |     expect(JSON.parse(shots[0]).s).toBeLessThan(500);
  326 |   });
  327 |   test('not-found copy; rate limit copy; API 500 -> generic error with reference id', async ({ page }) => {
  328 |     await page.goto(`/v/${T('qrunk')}`);
  329 |     await expect(page.getByText("We couldn't verify this report.")).toBeVisible();
  330 |     await page.goto(`/v/${T('qrrl')}`);
  331 |     await expect(page.getByText(/Too many attempts\. Please try again in \d+ minutes?\./)).toBeVisible();
  332 |     await page.goto(`/v/${T('qrboom')}`);
  333 |     await expect(page.getByText('Something went wrong. Please try again later.')).toBeVisible();
  334 |   });
  335 | });
  336 | 
  337 | test.describe('works at 320 px; touch targets; axe (WCAG 2.2 AA)', () => {
  338 |   test.use({ viewport: { width: 320, height: 640 } });
  339 |   const states: Array<[string, (p: Page) => Promise<void>]> = [
  340 |     ['landing', async (p) => { await p.goto(`/r/${T('ok')}`); }],
  341 |     ['code', async (p) => { await p.goto(`/r/${T('ok')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText('Code sent to the mobile number registered with the lab.')).toBeVisible(); }],
  342 |     ['code-error', async (p) => { await p.goto(`/r/${T('ok')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await enterCode(p, '000000'); const v = p.getByRole('button', { name: 'View report' }); if (await v.isVisible().catch(() => false)) await v.click(); await expect(p.getByText(/That code is not right\./)).toBeVisible(); }],
  343 |     ['report', async (p) => { await login(p, 'ok'); }],
  344 |     ['report-updated-smart', async (p) => { await login(p, 'smart'); await expect(p.getByRole('heading', { name: 'Health summary' })).toBeVisible(); }],
  345 |     ['invalid-link', async (p) => { await p.goto(`/r/${T('unk')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText('This link is not valid.', { exact: false })).toBeVisible(); }],
  346 |     ['reissue-confirmation', async (p) => { await p.goto(`/r/${T('exp')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await p.getByRole('button', { name: 'Request a new link' }).click(); await expect(p.getByText('If this link was sent to you', { exact: false })).toBeVisible(); }],
  347 |     ['rate-limited', async (p) => { await p.goto(`/r/${T('rl')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText(/Too many attempts/)).toBeVisible(); }],
  348 |     ['qr-valid', async (p) => { await p.goto(`/v/${T('qrok')}`); }],
  349 |     ['qr-superseded', async (p) => { await p.goto(`/v/${T('qrsup')}`); }],
  350 |     ['qr-not-found', async (p) => { await p.goto(`/v/${T('qrunk')}`); }],
  351 |     ['app-fallback-report', async (p) => { await p.goto(`/app/reports/01900000-0000-7000-8000-000000000001`); await expect(p.getByText('Open the link the lab sent you to view this report.')).toBeVisible(); }],
  352 |     ['app-fallback-other', async (p) => { await p.goto(`/app/anything/else`); await expect(p.getByText('Open the app to continue.')).toBeVisible(); }],
  353 |   ];
  354 |   for (const [name, go] of states) {
  355 |     test(`${name}: no horizontal scroll, lang, title, axe 0 violations`, async ({ page }) => {
  356 |       await go(page);
  357 |       await noOverflow(page);
  358 |       expect(await page.locator('html').getAttribute('lang')).toBeTruthy();
  359 |       expect((await page.title()).trim().length).toBeGreaterThan(0);
  360 |       await expect(page.locator('main')).toHaveCount(1);
  361 |       expect(await axeScan(page)).toEqual([]);
  362 |     });
  363 |   }
  364 |   test('44 px touch targets on primary actions', async ({ page }) => {
  365 |     await page.goto(`/r/${T('ok')}`);
  366 |     const box = await page.getByRole('button', { name: 'Send me a code' }).boundingBox();
  367 |     expect(box!.height).toBeGreaterThanOrEqual(44);
  368 |     expect(box!.width).toBeGreaterThanOrEqual(44);
  369 |   });
  370 |   test('app fallbacks carry no data and no PHI', async ({ page }) => {
  371 |     await page.goto(`/app/reports/01900000-0000-7000-8000-000000000001`);
  372 |     expect((await apiLog()).length).toBe(0);
  373 |   });
  374 | });
  375 | 
  376 | test.describe('well-known files (D-38)', () => {
  377 |   test('Android assetlinks + iOS AASA served as JSON from /.well-known without cookies', async ({ request }) => {
  378 |     const a = await request.get('/.well-known/assetlinks.json');
  379 |     expect(a.status()).toBe(200);
  380 |     expect(Array.isArray(await a.json())).toBe(true);
  381 |     const i = await request.get('/.well-known/apple-app-site-association');
  382 |     expect(i.status()).toBe(200);
  383 |     expect(typeof (await i.json())).toBe('object');
  384 |   });
  385 | });
  386 | 
```