// T0D-FAVICON-1 (LD-310, founder 2026-11-17 04:54 NPT: "add favicon as the Metro Labs app icon; light and fast on low end PCs").
// Proves: favicon.ico (16/32/48), icon.png 192, apple-icon.png 180 each < 12 KB; manifest.ts fields + 192/512 icons (512 < 40 KB);
// layout metadata title template "%s - Metro Labs" / default "Metro Labs" + description; icons come from file conventions (no explicit icons);
// login + shell still show the Metro Labs mark; the brand folder is untouched.
// Expected now: the icon files and manifest.ts do not exist and layout.tsx still has title 'LIMS', so the cases fail.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@lims/ui/fonts.css', () => ({}));
vi.mock('@lims/ui/tokens.css', () => ({}));
vi.mock('@lims/ui/kit.css', () => ({}));
vi.mock('@/core/shell/shell.css', () => ({}));
vi.mock('@/core/shell/Providers', () => ({ Providers: () => null }));

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..'); // apps/web/src/app
const webDir = join(appDir, '..', '..'); // apps/web
const repo = join(webDir, '..', '..');
const brandDir = join(repo, 'packages', 'ui', 'assets', 'brand');
const KB = 1024;

const png = (file: string) => {
  const b = readFileSync(file);
  expect(b.subarray(0, 8).toString('hex'), `${file} is a PNG`).toBe('89504e470d0a1a0a');
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bytes: b.length };
};
const ico = (file: string) => {
  const b = readFileSync(file);
  expect(b.readUInt16LE(0), 'ico reserved').toBe(0);
  expect(b.readUInt16LE(2), 'ico type 1 = icon').toBe(1);
  const n = b.readUInt16LE(4);
  const sizes = Array.from({ length: n }, (_, i) => `${b[6 + i * 16] || 256}x${b[7 + i * 16] || 256}`);
  return { sizes: sizes.sort(), bytes: b.length };
};

describe('icon files from the Next file conventions (done_when 1)', () => {
  it('favicon.ico holds exactly the 16, 32 and 48 px images and is under 12 KB', () => {
    const f = join(appDir, 'favicon.ico');
    expect(existsSync(f), 'apps/web/src/app/favicon.ico').toBe(true);
    const i = ico(f);
    expect(i.sizes).toEqual(['16x16', '32x32', '48x48']);
    expect(i.bytes).toBeLessThan(12 * KB);
  });

  it('icon.png is 192 x 192 and under 12 KB', () => {
    const f = join(appDir, 'icon.png');
    expect(existsSync(f), 'apps/web/src/app/icon.png').toBe(true);
    const p = png(f);
    expect([p.width, p.height]).toEqual([192, 192]);
    expect(p.bytes).toBeLessThan(12 * KB);
  });

  it('apple-icon.png is 180 x 180 and under 12 KB', () => {
    const f = join(appDir, 'apple-icon.png');
    expect(existsSync(f), 'apps/web/src/app/apple-icon.png').toBe(true);
    const p = png(f);
    expect([p.width, p.height]).toEqual([180, 180]);
    expect(p.bytes).toBeLessThan(12 * KB);
  });

  it('the three files are real, distinct images (not empty placeholders or copies of each other)', () => {
    const files = ['favicon.ico', 'icon.png', 'apple-icon.png'].map((n) => readFileSync(join(appDir, n)));
    for (const b of files) expect(b.length).toBeGreaterThan(500);
    expect(new Set(files.map((b) => b.toString('base64'))).size).toBe(3);
  });

  it('no icon route is added next to the files (file conventions only, no icon.tsx / icon.ts)', () => {
    for (const n of ['icon.tsx', 'icon.ts', 'apple-icon.tsx', 'apple-icon.ts', 'favicon.ts']) {
      expect(existsSync(join(appDir, n)), n).toBe(false);
    }
  });
});

describe('manifest.ts (done_when 2)', () => {
  const tokens = readFileSync(join(repo, 'packages', 'ui', 'tokens', 'tokens.json'), 'utf8');
  const tokenHex = new Set((tokens.match(/#[0-9A-Fa-f]{6}\b/g) ?? []).map((h) => h.toUpperCase()));

  const load = async () => (await import('../manifest')).default() as unknown as Record<string, unknown> & {
    icons: Array<{ src: string; sizes: string; type?: string }>;
  };

  it('returns name, short_name, start_url and display', async () => {
    const m = await load();
    expect(m.name).toBe('Metro Labs');
    expect(m.short_name).toBe('Metro Labs');
    expect(m.start_url).toBe('/');
    expect(m.display).toBe('standalone');
  });

  it('theme_color and background_color are hex colours that exist in the design tokens (Metro green)', async () => {
    const m = await load();
    for (const k of ['theme_color', 'background_color'] as const) {
      expect(String(m[k]), k).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(tokenHex.has(String(m[k]).toUpperCase()), `${k} ${String(m[k])} must come from tokens.json`).toBe(true);
    }
  });

  it('lists a 192 and a 512 PNG icon with same-origin paths (no remote URL)', async () => {
    const m = await load();
    const by = (s: string) => m.icons.find((i) => i.sizes === s);
    expect(by('192x192'), '192x192 icon').toBeDefined();
    expect(by('512x512'), '512x512 icon').toBeDefined();
    for (const i of m.icons) {
      expect(i.src, 'same-origin absolute path').toMatch(/^\/[^/]/);
      expect(i.type ?? 'image/png').toBe('image/png');
    }
  });

  it('the 192 icon file is 192 px and under 12 KB; the 512 icon file (app/ or public/) is 512 px and under 40 KB', async () => {
    const m = await load();
    const resolve = (src: string) => {
      const path = src.split('?')[0]!;
      return [join(appDir, path), join(webDir, 'public', path)].find((c) => existsSync(c));
    };
    const i192 = m.icons.find((i) => i.sizes === '192x192')!;
    const i512 = m.icons.find((i) => i.sizes === '512x512')!;
    const f192 = resolve(i192.src);
    const f512 = resolve(i512.src);
    expect(f192, `file behind ${i192.src}`).toBeDefined();
    expect(f512, `file behind ${i512.src}`).toBeDefined();
    const p192 = png(f192!);
    expect([p192.width, p192.height]).toEqual([192, 192]);
    expect(p192.bytes).toBeLessThan(12 * KB);
    const p512 = png(f512!);
    expect([p512.width, p512.height]).toEqual([512, 512]);
    expect(p512.bytes).toBeLessThan(40 * KB);
  });
});

describe('layout metadata (done_when 3)', () => {
  it('title template reads "Page name - Metro Labs", default "Metro Labs", and a description is set', async () => {
    const { metadata } = (await import('../layout')) as { metadata: Record<string, unknown> };
    const t = metadata.title as { template?: string; default?: string };
    expect(typeof t, 'title must be an object {default, template}').toBe('object');
    expect(t.default).toBe('Metro Labs');
    expect(t.template).toMatch(/^%s [-–—|] Metro Labs$/);
    expect(String(metadata.description ?? '').length).toBeGreaterThan(10);
  });

  it('icons come from the file conventions: layout does not declare metadata.icons or a manifest link', async () => {
    const { metadata } = (await import('../layout')) as { metadata: Record<string, unknown> };
    expect(metadata.icons, 'explicit icons would add requests and bypass the convention').toBeUndefined();
    expect(metadata.manifest, 'manifest.ts is picked up by the convention').toBeUndefined();
  });

  it('layout still wraps children in Providers and keeps the lims-root body (no behaviour change)', () => {
    const src = readFileSync(join(appDir, 'layout.tsx'), 'utf8');
    expect(src).toContain('<Providers>{children}</Providers>');
    expect(src).toContain('className="lims-root"');
  });
});

describe('same mark on the login screen and the app shell (done_when 4) and untouched brand folder (done_when 6)', () => {
  it('login layout and app shell import the Metro Labs logo from core/shell/brand', () => {
    expect(readFileSync(join(appDir, '(auth)', 'layout.tsx'), 'utf8')).toMatch(/LOGO_ON_LIGHT|MARK/);
    expect(readFileSync(join(webDir, 'src', 'core', 'shell', 'AppShell.tsx'), 'utf8')).toContain('LOGO_ON_DARK');
  });

  it('the brand folder has no favicon/icon files added (a kit test pins it)', () => {
    const names = readdirSync(brandDir).sort();
    expect(names).toEqual(['lab-hero.webp', 'ml-logo-landscape-white.png', 'ml-logo-landscape.png', 'ml-logo-white.png', 'ml-logo.png']);
    expect(statSync(join(brandDir, 'ml-logo.png')).size).toBeGreaterThan(50 * KB); // original source kept
  });

  it('no route files were added under app/ by this task (icons and manifest are conventions, not pages)', () => {
    const top = readdirSync(appDir).filter((n) => !n.startsWith('(') && n !== '__tests__');
    for (const n of top) expect(['apple-icon.png', 'favicon.ico', 'icon.png', 'layout.tsx', 'manifest.ts', 'page.tsx']).toContain(n);
  });
});
