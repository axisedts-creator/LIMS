// @vitest-environment jsdom
// T0D-12 / AC-0D-8.6 (axe over the story set, no critical/serious) + AC-0D-8.7 (no request leaves the origin while rendering).
// ASSUMED story format (spec says only "story set is the input for axe", 02-TRD:1028): CSF3 file
//   src/components/<Name>/<Name>.stories.tsx with a default export meta ({ title?, component?, args? }) and >=1 named export that is
//   a component function, or an object { render?(args), args? } (with meta.component used when render is absent).
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { seriousViolations } from './helpers';

const REQUIRED = [
  'Button', 'IconButton', 'Menu', 'TextField', 'TextArea', 'IntegerField', 'DecimalField', 'MoneyField', 'Select', 'CodedSelect',
  'Checkbox', 'RadioGroup', 'Switch', 'Form', 'Dialog', 'ConfirmDialog', 'Drawer', 'Toast', 'Banner', 'EmptyState', 'ErrorState',
  'LoadingSkeleton', 'PageShell', 'PageHeader', 'Tabs', 'StatusChip', 'FlagBadge', 'ResultValue', 'MoneyText', 'IdText',
  'DescriptionList', 'Stack', 'Inline', 'Grid', 'Card', 'Divider', 'VisuallyHidden',
];

const mods = import.meta.glob('../*/*.stories.tsx', { eager: true }) as Record<string, any>;

function storyEntries(mod: any): [string, any][] {
  return Object.entries(mod).filter(([k]) => k !== 'default' && k !== '__namedExportsOrder');
}
function toElement(meta: any, story: any) {
  if (typeof story === 'function') return createElement(story);
  const args = { ...(meta?.args ?? {}), ...(story?.args ?? {}) };
  if (typeof story?.render === 'function') return createElement(() => story.render(args));
  if (meta?.component) return createElement(meta.component, args);
  throw new Error('story is neither a function, nor has render(), nor has meta.component');
}

describe('story set exists for every T0D-12 component (done_when)', () => {
  it.each(REQUIRED)('%s has a story file with at least one story', (name) => {
    const mod = mods[`../${name}/${name}.stories.tsx`];
    expect(mod, `missing src/components/${name}/${name}.stories.tsx`).toBeTruthy();
    expect(storyEntries(mod).length).toBeGreaterThan(0);
  });
});

const cases = Object.entries(mods).flatMap(([file, mod]) => storyEntries(mod).map(([n, s]) => [`${file.split('/')[1]}/${n}`, mod.default, s] as const));

describe('axe: no critical or serious violation in any story (AC-0D-8.6)', () => {
  it('story set is non-empty', () => {
    expect(cases.length).toBeGreaterThanOrEqual(REQUIRED.length);
  });

  it.each(cases)('%s', async (_id, meta, story) => {
    const { container } = render(toElement(meta, story));
    await act(async () => {});
    expect(await seriousViolations(document.body)).toEqual([]);
    expect(container).toBeTruthy();
  });
});

describe('no network request while rendering stories (AC-0D-8.7, REQ-SEC-141)', () => {
  it('fetch/XHR/sendBeacon unused; no foreign link/img/script/@import in DOM', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('network blocked')));
    const xhrSpy = vi.fn();
    const beaconSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.stubGlobal('XMLHttpRequest', function () { xhrSpy(); } as any);
    (navigator as any).sendBeacon = beaconSpy;
    try {
      expect(cases.length).toBeGreaterThan(0);
      for (const [, meta, story] of cases) {
        const { container, unmount } = render(toElement(meta, story));
        await act(async () => {});
        // resource loaders only (anchors may legitimately point outside)
        const foreign = [...document.querySelectorAll('img[src],script[src],source[src],iframe[src],link[href],style')].filter((el) => {
          const v = (el.getAttribute('src') ?? el.getAttribute('href') ?? '') + (el.tagName === 'STYLE' ? el.textContent : '');
          return /(^|[\s("'=])(https?:)?\/\/[^/\s]/i.test(v);
        });
        expect(foreign.map((e) => e.outerHTML)).toEqual([]);
        expect(container).toBeTruthy();
        unmount();
      }
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrSpy).not.toHaveBeenCalled();
      expect(beaconSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
