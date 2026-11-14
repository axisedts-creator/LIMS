// T-Q5 e2e on compose: pair -> board Live without a staff session -> revoke -> "no longer paired" (US-EN-22.1/.4).
// Needs the compose stack (see playwright.config.ts); skips when LIMS_E2E_* is unset. Synthetic data only.
import { expect, test } from '@playwright/test';

const WEB = process.env.LIMS_E2E_WEB_URL ?? 'https://localhost:3100';
const API = process.env.LIMS_E2E_API_URL ?? '';
const STAFF = process.env.LIMS_E2E_STAFF_TOKEN ?? '';
const CENTRE = process.env.LIMS_E2E_CENTRE_ID ?? '';
const QUEUE = process.env.LIMS_E2E_QUEUE_ID ?? '';
const COUNTER = process.env.LIMS_E2E_COUNTER_ID ?? '';
const auth = { authorization: `Bearer ${STAFF}`, 'content-type': 'application/json' };

test.skip(!API || !STAFF || !CENTRE || !QUEUE || !COUNTER, 'compose env not set');

test('unpaired browser sees Not paired', async ({ page }) => {
  await page.goto('/queue-display');
  await expect(page.getByText('Ask a lab administrator to pair this screen')).toBeVisible();
});

test('paired display shows the board with no staff session; revoke makes it unpaired', async ({ page, context, request }) => {
  const r = await request.post(`${API}/v1/engagement/queue-displays`, { headers: auth, data: { centre_id: CENTRE, display_name: 'E2E TV', queue_ids: [QUEUE] } });
  expect(r.status()).toBe(201);
  const { display, display_token } = (await r.json()) as { display: { id: string }; display_token: string };
  // fresh context = no staff session cookie (staff logged out); only the display cookie exists
  await context.addCookies([{ name: '__Secure-lims_qdisp', value: display_token, url: new URL('/queue-display', WEB).toString(), httpOnly: true, secure: true, sameSite: 'Strict' }]);
  await page.goto('/queue-display');
  await expect(page.getByText(/Connecting|Connection lost|no longer paired|Ask a lab administrator/)).toHaveCount(0, { timeout: 15_000 });
  // US-EN-22.2: a call made after pairing shows on the board within 10 s (proves the board renders and updates, not a blank page)
  const t = await request.post(`${API}/v1/engagement/queue-tokens`, { headers: { ...auth, 'idempotency-key': crypto.randomUUID() }, data: { queue_id: QUEUE } });
  expect(t.status()).toBe(201);
  const called = await request.post(`${API}/v1/engagement/queues/${QUEUE}/call-next`, { headers: auth, data: { counter_id: COUNTER } });
  expect(called.status()).toBe(200);
  const { token_label } = (await called.json()) as { token_label: string };
  await expect(page.getByText(token_label).first()).toBeVisible({ timeout: 10_000 });
  const rv = await request.post(`${API}/v1/engagement/queue-displays/${display.id}/revoke`, { headers: auth, data: {} });
  expect(rv.ok()).toBe(true);
  await expect(page.getByText('This screen is no longer paired')).toBeVisible({ timeout: 15_000 });
});
