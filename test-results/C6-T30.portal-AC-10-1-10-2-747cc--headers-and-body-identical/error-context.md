# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: C6-T30.portal.spec.ts >> AC-10.1 / 10.2 / 10.3 QR verify >> unknown / revoked / unreleased / malformed: status, headers and body identical
- Location: ..\..\tests\portal-e2e\C6-T30.portal.spec.ts:311:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 1
Received: 4
```

# Test source

```ts
  218 |     await expect(page).toHaveURL(new RegExp(`/r/${T('ok')}(/code)?$`));
  219 |     await expect(page.getByText('Complete Blood Count')).toHaveCount(0);
  220 |   });
  221 | 
  222 |   test('Sign out ends the session (P6) and clears the cookie', async ({ page, context }) => {
  223 |     await login(page, 'ok');
  224 |     const out = page.getByRole('button', { name: 'Sign out' });
  225 |     if (await out.count()) await out.click(); else await page.getByRole('link', { name: 'Sign out' }).click();
  226 |     await expect.poll(async () => (await apiLog()).some((r) => r.url === '/v1/reporting/portal/sessions/end' && r.method === 'POST')).toBe(true);
  227 |     expect((await context.cookies(PORTAL)).find((x) => x.name === COOKIE)).toBeUndefined();
  228 |   });
  229 | });
  230 | 
  231 | test.describe('AC-11.9 headers on /r/ and /v/ pages (REQ-SEC-089/090)', () => {
  232 |   for (const path of [`/r/${T('ok')}`, `/r/${T('ok')}/code`, `/r/${T('ok')}/report`, `/v/${T('qrok')}`, `/v/${T('qrunk')}`]) {
  233 |     test(`headers ${path.replace(/0{4,}/, '…')}`, async ({ request }) => {
  234 |       const h = (await request.get(path, { maxRedirects: 0 })).headers();
  235 |       expect(h['referrer-policy']).toBe('no-referrer');
  236 |       expect(h['cache-control']).toContain('no-store');
  237 |       expect(h['x-content-type-options']).toBe('nosniff');
  238 |       expect(h['strict-transport-security']).toMatch(/max-age=63072000/);
  239 |       const csp = h['content-security-policy'] ?? h['content-security-policy-report-only'];
  240 |       expect(csp, 'CSP header').toBeTruthy();
  241 |       expect(csp).toMatch(/script-src[^;]*'nonce-[^']+'/);
  242 |       expect(csp).toContain("object-src 'none'");
  243 |       expect(csp).toContain("frame-ancestors 'none'");
  244 |       expect(csp).toMatch(/form-action 'self'/);
  245 |       expect(csp).toMatch(/default-src 'self'/);
  246 |     });
  247 |   }
  248 |   test('no third-party requests (all sub-requests stay on the portal origin)', async ({ page }) => {
  249 |     const origins = new Set<string>();
  250 |     page.on('request', (r) => { origins.add(new URL(r.url()).origin); });
  251 |     await page.goto(`/r/${T('ok')}`);
  252 |     await page.goto(`/v/${T('qrok')}`);
  253 |     expect([...origins]).toEqual([PORTAL]);
  254 |   });
  255 |   test('client IP: X-Forwarded-For is forwarded as received with the portal BFF key (D-32)', async ({ request }) => {
  256 |     await request.get(`/v/${T('qrok')}`, { headers: { 'x-forwarded-for': '203.0.113.7' } });
  257 |     const q = (await apiLog()).find((r) => r.url === '/v1/reporting/verifications');
  258 |     expect(q.xff).toBe('203.0.113.7');
  259 |     expect(q.bffKey).toBe(BFF_KEY);
  260 |     expect(JSON.stringify(q)).not.toMatch(/\?/); // token in body, not URL
  261 |     expect(q.body).toEqual({ qr_token: T('qrok') });
  262 |   });
  263 |   test('state changes are POST only with an Origin check (REQ-SEC-091/092)', async ({ request }) => {
  264 |     expect((await request.get(`/r/${T('exp')}/reissue`, { maxRedirects: 0 })).status()).toBe(405);
  265 |     const bad = await request.post(`/r/${T('exp')}/reissue`, { headers: { origin: 'https://evil.example' }, maxRedirects: 0 });
  266 |     expect(bad.status()).toBe(403);
  267 |     expect((await apiLog()).some((r) => r.url === '/v1/reporting/portal/link-reissues')).toBe(false);
  268 |   });
  269 | });
  270 | 
  271 | test.describe('AC-11.11 Health summary', () => {
  272 |   test('NULL snapshot: no heading, no placeholder', async ({ page }) => {
  273 |     await login(page, 'ok');
  274 |     await expect(page.getByText(/health summary/i)).toHaveCount(0);
  275 |   });
  276 |   test('set snapshot: read-only section with N1 + disclaimerText, no controls, no links', async ({ page }) => {
  277 |     await login(page, 'smart');
  278 |     const sec = page.locator('section', { has: page.getByRole('heading', { name: 'Health summary' }) });
  279 |     await expect(sec).toBeVisible();
  280 |     await expect(sec).toContainText("This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor.");
  281 |     await expect(sec).toContainText('SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS');
  282 |     await expect(sec).toContainText('Serum Ferritin');
  283 |     expect(await sec.locator('input, button, select, textarea, a').count()).toBe(0);
  284 |     const calls = (await apiLog()).map((r) => r.url);
  285 |     expect(calls.every((u) => u.startsWith('/v1/reporting/'))).toBe(true); // zero SmartReport calls on the request path
  286 |   });
  287 |   test('unrenderable snapshot: error copy; rest of the page and Download unaffected', async ({ page }) => {
  288 |     await login(page, 'badsmart');
  289 |     await expect(page.getByRole('heading', { name: 'Health summary' })).toBeVisible();
  290 |     await expect(page.getByText('Your health summary cannot be shown right now. Your full report is available to download above.')).toBeVisible();
  291 |     await expect(page.getByRole('link', { name: 'Download PDF' }).or(page.getByRole('button', { name: 'Download PDF' }))).toBeVisible();
  292 |   });
  293 | });
  294 | 
  295 | test.describe('AC-10.1 / 10.2 / 10.3 QR verify', () => {
  296 |   test('valid: genuine banner + only the allowed fields', async ({ page }) => {
  297 |     await page.goto(`/v/${T('qrok')}`);
  298 |     await expect(page.getByText('This report is genuine.')).toBeVisible();
  299 |     const t = await page.locator('main').innerText();
  300 |     for (const k of ['Laboratory', 'Patient', 'Tests', 'Issued', 'Version']) expect(t).toContain(k);
  301 |     expect(t).toContain('Test Diagnostics');
  302 |     expect(t).toContain('A.B.');
  303 |     expect(t).toContain('Complete Blood Count');
  304 |     expect(t).not.toMatch(/phone|address|date of birth|result|\bDOB\b/i);
  305 |   });
  306 |   test('superseded status', async ({ page }) => {
  307 |     await page.goto(`/v/${T('qrsup')}`);
  308 |     await expect(page.getByText(/Superseded — a newer version of this report exists|This report was replaced by a newer version\./)).toBeVisible();
  309 |     await expect(page.getByText('This report is genuine.')).toHaveCount(0);
  310 |   });
  311 |   test('unknown / revoked / unreleased / malformed: status, headers and body identical', async ({ request }) => {
  312 |     const shots: string[] = [];
  313 |     for (const tok of [T('qrunk'), T('qrrev'), T('qrunrel'), 'x!']) {
  314 |       const r = await request.get(`/v/${tok}`, { maxRedirects: 0 });
  315 |       const h = { ...r.headers() }; delete h.date; delete h['content-length']; delete h.etag; delete h['x-request-id'];
  316 |       shots.push(norm(JSON.stringify({ s: r.status(), h, b: (await r.text()).split(tok).join('TOKEN') })));
  317 |     }
> 318 |     expect(new Set(shots).size).toBe(1);
      |                                 ^ Error: expect(received).toBe(expected) // Object.is equality
  319 |     expect(JSON.parse(shots[0]).s).toBeLessThan(500);
  320 |   });
  321 |   test('not-found copy; rate limit copy; API 500 -> generic error with reference id', async ({ page }) => {
  322 |     await page.goto(`/v/${T('qrunk')}`);
  323 |     await expect(page.getByText("We couldn't verify this report.")).toBeVisible();
  324 |     await page.goto(`/v/${T('qrrl')}`);
  325 |     await expect(page.getByText(/Too many attempts\. Please try again in \d+ minutes?\./)).toBeVisible();
  326 |     await page.goto(`/v/${T('qrboom')}`);
  327 |     await expect(page.getByText('Something went wrong. Please try again later.')).toBeVisible();
  328 |   });
  329 | });
  330 | 
  331 | test.describe('works at 320 px; touch targets; axe (WCAG 2.2 AA)', () => {
  332 |   test.use({ viewport: { width: 320, height: 640 } });
  333 |   const states: Array<[string, (p: Page) => Promise<void>]> = [
  334 |     ['landing', async (p) => { await p.goto(`/r/${T('ok')}`); }],
  335 |     ['code', async (p) => { await p.goto(`/r/${T('ok')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText('Code sent to the mobile number registered with the lab.')).toBeVisible(); }],
  336 |     ['code-error', async (p) => { await p.goto(`/r/${T('ok')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await enterCode(p, '000000'); const v = p.getByRole('button', { name: 'View report' }); if (await v.isVisible().catch(() => false)) await v.click(); await expect(p.getByText(/That code is not right\./)).toBeVisible(); }],
  337 |     ['report', async (p) => { await login(p, 'ok'); }],
  338 |     ['report-updated-smart', async (p) => { await login(p, 'smart'); await expect(p.getByRole('heading', { name: 'Health summary' })).toBeVisible(); }],
  339 |     ['invalid-link', async (p) => { await p.goto(`/r/${T('unk')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText('This link is not valid.', { exact: false })).toBeVisible(); }],
  340 |     ['reissue-confirmation', async (p) => { await p.goto(`/r/${T('exp')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await p.getByRole('button', { name: 'Request a new link' }).click(); await expect(p.getByText('If this link was sent to you', { exact: false })).toBeVisible(); }],
  341 |     ['rate-limited', async (p) => { await p.goto(`/r/${T('rl')}`); await p.getByRole('button', { name: 'Send me a code' }).click(); await expect(p.getByText(/Too many attempts/)).toBeVisible(); }],
  342 |     ['qr-valid', async (p) => { await p.goto(`/v/${T('qrok')}`); }],
  343 |     ['qr-superseded', async (p) => { await p.goto(`/v/${T('qrsup')}`); }],
  344 |     ['qr-not-found', async (p) => { await p.goto(`/v/${T('qrunk')}`); }],
  345 |     ['app-fallback-report', async (p) => { await p.goto(`/app/reports/01900000-0000-7000-8000-000000000001`); await expect(p.getByText('Open the link the lab sent you to view this report.')).toBeVisible(); }],
  346 |     ['app-fallback-other', async (p) => { await p.goto(`/app/anything/else`); await expect(p.getByText('Open the app to continue.')).toBeVisible(); }],
  347 |   ];
  348 |   for (const [name, go] of states) {
  349 |     test(`${name}: no horizontal scroll, lang, title, axe 0 violations`, async ({ page }) => {
  350 |       await go(page);
  351 |       await noOverflow(page);
  352 |       expect(await page.locator('html').getAttribute('lang')).toBeTruthy();
  353 |       expect((await page.title()).trim().length).toBeGreaterThan(0);
  354 |       await expect(page.locator('main')).toHaveCount(1);
  355 |       expect(await axeScan(page)).toEqual([]);
  356 |     });
  357 |   }
  358 |   test('44 px touch targets on primary actions', async ({ page }) => {
  359 |     await page.goto(`/r/${T('ok')}`);
  360 |     const box = await page.getByRole('button', { name: 'Send me a code' }).boundingBox();
  361 |     expect(box!.height).toBeGreaterThanOrEqual(44);
  362 |     expect(box!.width).toBeGreaterThanOrEqual(44);
  363 |   });
  364 |   test('app fallbacks carry no data and no PHI', async ({ page }) => {
  365 |     await page.goto(`/app/reports/01900000-0000-7000-8000-000000000001`);
  366 |     expect((await apiLog()).length).toBe(0);
  367 |   });
  368 | });
  369 | 
  370 | test.describe('well-known files (D-38)', () => {
  371 |   test('Android assetlinks + iOS AASA served as JSON from /.well-known without cookies', async ({ request }) => {
  372 |     const a = await request.get('/.well-known/assetlinks.json');
  373 |     expect(a.status()).toBe(200);
  374 |     expect(Array.isArray(await a.json())).toBe(true);
  375 |     const i = await request.get('/.well-known/apple-app-site-association');
  376 |     expect(i.status()).toBe(200);
  377 |     expect(typeof (await i.json())).toBe('object');
  378 |   });
  379 | });
  380 | 
```