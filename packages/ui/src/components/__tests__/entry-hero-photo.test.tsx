// @vitest-environment jsdom
// T0D-MSERIES-6 (LD-287, founder 2026-11-16 20:00 NPT): EntryHero takes an optional photoSrc and shows the Metro Labs laboratory photo as the panel background.
// Unit side of the task: the component contract, the asset file (copied byte for byte from the founder's file), and the source guards inside packages/ui.
// The integration side (layout, brand.ts, css, contrast, axe) is apps/web/src/features/admin/auth/__tests__/m6.photo.test.tsx.
// Contract (see that file's header): photo = img.lims-auth-photo, then div.lims-auth-photo-overlay, both aria-hidden, both before everything the M5 hero already rendered.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { EntryHero } from '../EntryHero/EntryHero';

afterEach(cleanup);

const UI = process.cwd(); // vitest root = packages/ui
const ASSET = join(UI, 'assets', 'brand', 'lab-hero.webp');
const SRC = '/media/lab-hero.test.webp';
const hero = (props: { photoSrc?: string } = {}) => render(<aside className="lims-auth-panel"><EntryHero markSrc="/media/mark.png" {...props} /></aside>);

describe('EntryHero photoSrc', () => {
  it('with photoSrc: the photo is the first child, then the overlay, then the unchanged M5 pieces', () => {
    const { container } = hero({ photoSrc: SRC });
    const aside = container.firstElementChild as HTMLElement;
    const img = aside.children[0] as HTMLImageElement;
    expect(img.tagName).toBe('IMG');
    expect(img.className).toBe('lims-auth-photo');
    expect(aside.children[1]!.className).toBe('lims-auth-photo-overlay');
    expect([...aside.children].slice(2).map((c) => (c.getAttribute('class') ?? '').split(' ')[0])).toEqual(
      ['lims-auth-rings', 'lims-auth-scene', 'lims-auth-mark', 'lims-auth-chip', 'lims-auth-chip', 'lims-auth-chip', 'lims-auth-tagline'],
    );
    expect(aside.querySelectorAll('.lims-auth-well')).toHaveLength(96);
    expect(aside.querySelector('.lims-auth-mark img')?.getAttribute('src')).toBe('/media/mark.png');
  });

  it('decorative: alt="" (present), aria-hidden, not focusable, lazy, async, 768 x 512, the given src, nothing else (no style, srcset, role, tabindex)', () => {
    const img = hero({ photoSrc: SRC }).container.querySelector('img.lims-auth-photo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(SRC);
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
    expect(img.getAttribute('loading')).toBe('lazy');
    expect(img.getAttribute('decoding')).toBe('async');
    expect([img.getAttribute('width'), img.getAttribute('height')]).toEqual(['768', '512']);
    for (const a of ['tabindex', 'role', 'style', 'srcset', 'sizes', 'fetchpriority', 'crossorigin', 'usemap', 'onclick']) expect(img.hasAttribute(a), a).toBe(false);
    const overlay = hero({ photoSrc: SRC }).container.querySelector('.lims-auth-photo-overlay') as HTMLElement;
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(overlay.children).toHaveLength(0);
    expect(overlay.hasAttribute('style')).toBe(false);
  });

  it('without photoSrc (omitted or empty string): no photo, no overlay, no broken <img>; only the mark image remains (the M5 output)', () => {
    for (const props of [{}, { photoSrc: '' }]) {
      const { container, unmount } = hero(props);
      expect(container.querySelector('.lims-auth-photo, .lims-auth-photo-overlay')).toBeNull();
      expect([...container.querySelectorAll('img')].map((i) => i.getAttribute('src'))).toEqual(['/media/mark.png']);
      unmount();
    }
  });

  it('the markup does not depend on the photo size: the src is passed through untouched (no hard coded file name, no remote URL, no data URI)', () => {
    const img = hero({ photoSrc: '/_next/static/media/lab-hero.abc123.webp' }).container.querySelector('img.lims-auth-photo') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/_next/static/media/lab-hero.abc123.webp');
  });

  it('axe: the hero with the photo has no violation', async () => {
    const { container } = hero({ photoSrc: SRC });
    const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } }, resultTypes: ['violations'] });
    expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html.slice(0, 80)}`)).toEqual([]);
  });
});

describe('EntryHero.tsx source (packages/ui guards)', () => {
  const code = readFileSync(join(UI, 'src', 'components', 'EntryHero', 'EntryHero.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  it('photoSrc is an optional string prop', () => { expect(code).toMatch(/\bphotoSrc\?\s*:\s*string\b/); });
  it('no raw colour, inline style, remote URL, data URI or image file literal', () => {
    expect(/(?<![\w&.])#[0-9a-fA-F]{3,8}(?![\w-])|\brgba?\(|\bhsla?\(/.test(code)).toBe(false);
    expect(/\bstyle\s*=\s*(\{|["'])/.test(code)).toBe(false);
    expect(/https?:\/\/|\bdata:/.test(code)).toBe(false);
    expect(/["'`][^"'`\s]*\.(webp|png|jpe?g|gif|avif)["'`]/i.test(code)).toBe(false);
  });
});

describe('packages/ui/assets/brand/lab-hero.webp (done_when 1, 5, 7)', () => {
  it('exists and is at most 100 KB (and not empty)', () => {
    expect(existsSync(ASSET), `${ASSET} must be copied from C:\\LIMS-state\\assets\\auth-lab-hero.webp`).toBe(true);
    const n = statSync(ASSET).size;
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(100 * 1024);
  });

  it('is the founder file, byte for byte: 52418 bytes, sha256 da79c215...149a (update this pin together with the notes when a larger photo replaces it)', () => {
    const buf = readFileSync(ASSET);
    expect(buf.length).toBe(52418);
    expect(createHash('sha256').update(buf).digest('hex')).toBe('da79c2154ec250618107a02c1faa5602d86af7839f3227afc042b118a9f5149a');
  });

  it('is a real WebP (RIFF....WEBP) of 768 x 512, and the img width/height attributes equal the file size', () => {
    const b = readFileSync(ASSET);
    expect(b.subarray(0, 4).toString('latin1')).toBe('RIFF');
    expect(b.subarray(8, 12).toString('latin1')).toBe('WEBP');
    expect(b.readUInt32LE(4) + 8).toBe(b.length); // RIFF size matches: not truncated
    const kind = b.subarray(12, 16).toString('latin1');
    let w = 0, h = 0;
    if (kind === 'VP8 ') { w = b.readUInt16LE(26) & 0x3fff; h = b.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L') { w = 1 + (b[21]! | ((b[22]! & 0x3f) << 8)); h = 1 + ((b[22]! >> 6) | (b[23]! << 2) | ((b[24]! & 0x0f) << 10)); }
    else if (kind === 'VP8X') { w = 1 + b.readUIntLE(24, 3); h = 1 + b.readUIntLE(27, 3); }
    expect([kind.trim(), w, h].slice(1)).toEqual([768, 512]);
    const img = hero({ photoSrc: SRC }).container.querySelector('img.lims-auth-photo') as HTMLImageElement;
    expect([Number(img.getAttribute('width')), Number(img.getAttribute('height'))]).toEqual([w, h]);
  });
});

describe('no remote image URL in packages/ui/src', () => {
  const walk = (dir: string, out: string[] = []): string[] => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) { if (!['node_modules', '__tests__', 'dist'].includes(n)) walk(p, out); } else if (/\.(tsx?|css)$/.test(n) && !/\.(test|spec)\./.test(n)) out.push(p);
    }
    return out;
  };
  it('no <img src>, srcSet or url() with http(s):// or //host in any non-test source', () => {
    const bad = walk(join(UI, 'src')).filter((f) => /<img\b[^>]*\bsrc\s*=\s*["'{`]\s*["'`]?\s*(?:https?:)?\/\/[a-z0-9]|\bsrcSet\s*=\s*["'`]\s*(?:https?:)?\/\/|\burl\(\s*["']?\s*(?:https?:)?\/\/[a-z0-9]/i.test(readFileSync(f, 'utf8')));
    expect(bad).toEqual([]);
  });
});
