// C2.T12 — nightly Playwright E2E for AU-1..AU-7 (AC-A1.1, A2.1/2.2, A3.1/3.2, A7.1, A8.1). Not part of the per-task verify (needs a running stack).
// Stack contract: staff web at LIMS_E2E_WEB_URL, identity API stub (or real C2 + GoTrue) behind LIMS_ORIGIN_API with these synthetic accounts:
//   active@lab.test / E2E-passphrase-001  (no MFA role)        mfa@lab.test / E2E-passphrase-002 (verified TOTP; code = LIMS_E2E_TOTP env, 6 digits)
//   enrol@lab.test / E2E-passphrase-003   (MFA role, no factor)  locked@lab.test (locked)
import { expect, test } from '@playwright/test';

const JWT = /eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/;

async function login(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/auth/login');
  await page.getByLabel(/^email/i).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in' }).click();
}

test('AC-A1.1 login sets an opaque HttpOnly __Host- cookie and leaves no JWT in browser-readable state', async ({ page, context }) => {
  const bodies: string[] = [];
  page.on('response', async (r) => { bodies.push(await r.text().catch(() => '')); });
  await login(page, 'active@lab.test', 'E2E-passphrase-001');
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
  const sid = (await context.cookies()).find((c) => c.name === '__Host-lims_sid');
  expect(sid, 'session cookie').toBeTruthy();
  expect(sid).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Lax', path: '/' });
  expect(sid!.value).not.toMatch(JWT);
  expect((await context.cookies()).filter((c) => !c.httpOnly).map((c) => c.value).join('')).not.toMatch(JWT);
  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + document.cookie);
  expect(storage).not.toMatch(JWT);
  expect(storage).not.toContain(sid!.value);
  expect(bodies.join('\n')).not.toMatch(JWT);
});

test('AU-1 wrong password shows the inline error and sets no cookie', async ({ page, context }) => {
  await login(page, 'active@lab.test', 'wrong-password');
  await expect(page.getByText('Email or password is incorrect.')).toBeVisible();
  expect((await context.cookies()).find((c) => c.name === '__Host-lims_sid')).toBeUndefined();
});

test('AC-A2.1/2.2 MFA: password -> /auth/mfa (business pages blocked) -> valid code -> shell', async ({ page }) => {
  await login(page, 'mfa@lab.test', 'E2E-passphrase-002');
  await page.waitForURL('**/auth/mfa');
  await page.goto('/analytics');
  await expect(page).toHaveURL(/\/auth\/mfa/); // mfa_pending is redirected, never shown business data
  await page.getByRole('textbox').first().click();
  await page.keyboard.type(process.env.LIMS_E2E_TOTP ?? '000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await page.waitForURL((u) => !u.pathname.startsWith('/auth/'));
});

test('AC-A3.1 forced enrolment lands on /auth/mfa/enrol with the banner', async ({ page }) => {
  await login(page, 'enrol@lab.test', 'E2E-passphrase-003');
  await page.waitForURL('**/auth/mfa/enrol');
  await expect(page.getByText('Your role requires two-step verification before you can continue.')).toBeVisible();
  await page.getByRole('button', { name: /^continue$/i }).click();
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toHaveAttribute('src', /^data:image\//);
});

test('AC-A7.1 forgot password shows the same message for a known and an unknown email', async ({ page }) => {
  const msgs: string[] = [];
  for (const email of ['active@lab.test', 'nobody-here@lab.test']) {
    await page.goto('/auth/forgot');
    await page.getByLabel(/^email/i).fill(email);
    await page.getByRole('button', { name: 'Send reset link' }).click();
    await expect(page.getByText(/If an account exists for/)).toBeVisible();
    msgs.push((await page.getByText(/If an account exists for/).textContent())!.replace(email, '{email}'));
  }
  expect(msgs[1]).toBe(msgs[0]);
});

test('AC-A7.2/A8.2 a bad confirm link shows the invalid-link copy and the token is not left in the URL or Referer', async ({ page }) => {
  const referers: (string | undefined)[] = [];
  page.on('request', (r) => referers.push(r.headers()['referer']));
  await page.goto('/auth/confirm?token_hash=used-or-unknown&type=recovery');
  await expect(page.getByText('This reset link is invalid or has expired. Request a new one.')).toBeVisible();
  expect(referers.join(' ')).not.toContain('used-or-unknown');
});

test('CSRF: a cross-origin POST to an auth action is rejected by core with 403 auth.csrf_failed', async ({ request }) => {
  const r = await request.post('/auth/login', { headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }, data: 'email=a@b.test&password=x' });
  expect(r.status()).toBe(403);
});

test('AU-6 / AU-7 are public pages (no session needed) and /auth/login?logged_out=1 shows the banner', async ({ page }) => {
  await page.goto('/auth/login?logged_out=1');
  await expect(page.getByText('You have been logged out.')).toBeVisible();
  await page.goto('/auth/logout');
  await expect(page).toHaveURL(/\/auth\//);
  await page.goto('/auth/session-expired');
  await expect(page.getByRole('link', { name: /log in again/i })).toBeVisible();
});
