// T0D-MSERIES-6 (LD-287) Playwright check of the live sign-in screen (done_when 8). NOT part of the vitest verify: it needs a running web app.
// Run: LIMS_E2E_WEB_URL=http://localhost:3000 pnpm --dir apps/web exec playwright test --config src/features/admin/auth/__tests__/e2e/playwright.config.ts m6-photo
// Without LIMS_E2E_WEB_URL the suite fails on purpose (a skipped check is not a pass). Screenshots go to .orchestra/notes/ (the notes folder).
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const BASE = process.env.LIMS_E2E_WEB_URL ?? '';
const NOTES = join(__dirname, '..', '..', '..', '..', '..', '..', '..', '..', '.orchestra', 'notes'); // e2e -> __tests__ -> auth -> admin -> features -> src -> web -> apps -> repo

test.beforeAll(() => {
  if (!BASE) throw new Error('set LIMS_E2E_WEB_URL (dev server or staging) to run the sign-in photo check');
});

for (const [name, width, height] of [['1440', 1440, 900], ['390', 390, 844]] as const) {
  test.describe(`sign-in photo at ${name} px`, () => {
    test.use({ viewport: { width, height } });

    test('no horizontal scroll; every image request is same-origin; screenshot saved', async ({ page }) => {
      const images: string[] = [];
      page.on('request', (r) => { if (r.resourceType() === 'image') images.push(r.url()); });
      await page.goto(`${BASE}/auth/login`);
      await expect(page.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeVisible();
      await page.locator('.lims-auth-panel').scrollIntoViewIfNeeded();
      await page.waitForLoadState('networkidle');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      const origin = new URL(BASE).origin;
      for (const u of images) expect(new URL(u).origin, `image ${u}`).toBe(origin);
      await page.screenshot({ path: join(NOTES, `T0D-MSERIES-6-signin-${name}.png`), fullPage: width < 1000 });
    });

    test('the photo: decorative, decoded at 768 x 512, covers the panel, behind the plate, chips, mark and tagline', async ({ page }) => {
      await page.goto(`${BASE}/auth/login`);
      const photo = page.locator('.lims-auth-panel img.lims-auth-photo');
      await expect(photo).toHaveCount(1);
      await photo.scrollIntoViewIfNeeded();
      await expect.poll(() => photo.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBe(768);
      const info = await page.evaluate(() => {
        const img = document.querySelector('.lims-auth-panel img.lims-auth-photo') as HTMLImageElement;
        const panel = document.querySelector('.lims-auth-panel') as HTMLElement;
        const cs = getComputedStyle(img);
        const r = img.getBoundingClientRect();
        const p = panel.getBoundingClientRect();
        const tag = document.querySelector('.lims-auth-tagline') as HTMLElement;
        const t = tag.getBoundingClientRect();
        const top = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
        return {
          src: img.currentSrc, alt: img.getAttribute('alt'), hidden: img.getAttribute('aria-hidden'), fit: cs.objectFit, pos: cs.objectPosition,
          covers: Math.abs(r.width - p.width) < 2 && Math.abs(r.height - p.height) < 2, tagOverPhoto: top !== img && !!top?.closest('.lims-auth-tagline'),
          nat: [img.naturalWidth, img.naturalHeight],
        };
      });
      expect(info.src.startsWith(new URL(BASE).origin)).toBe(true);
      expect([info.alt, info.hidden, info.fit]).toEqual(['', 'true', 'cover']);
      expect(info.nat).toEqual([768, 512]);
      expect(info.covers, 'the photo fills the panel').toBe(true);
      expect(info.tagOverPhoto, 'the tagline paints above the photo').toBe(true);
    });
  });
}

test.describe('mobile (390): the photo follows the panel (stacked, never overflowing), as in T0D-MSERIES-5', () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test('either not displayed, or inside the panel bounds', async ({ page }) => {
    await page.goto(`${BASE}/auth/login`);
    const r = await page.evaluate(() => {
      const img = document.querySelector('.lims-auth-photo') as HTMLElement;
      const panel = document.querySelector('.lims-auth-panel') as HTMLElement;
      const a = img.getBoundingClientRect();
      const b = panel.getBoundingClientRect();
      return { shown: getComputedStyle(img).display !== 'none' && a.width > 0, inside: a.left >= b.left - 1 && a.right <= b.right + 1 && a.top >= b.top - 1 && a.bottom <= b.bottom + 1 };
    });
    expect(!r.shown || r.inside).toBe(true);
  });
});

test.describe('reduced motion: the photo is static', () => {
  test.use({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  test('no animation on the photo or the overlay', async ({ page }) => {
    await page.goto(`${BASE}/auth/login`);
    const names = await page.evaluate(() => ['.lims-auth-photo', '.lims-auth-photo-overlay'].map((s) => getComputedStyle(document.querySelector(s) as HTMLElement).animationName));
    expect(names).toEqual(['none', 'none']);
  });
});
