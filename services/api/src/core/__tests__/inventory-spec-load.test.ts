// T0D-12d / LD-115 (CR-C12-T01b): the API loads contracts/openapi/inventory.yaml through core/module.ts loadSpec (bundleRefs)
// without "collides with a local definition" for Code. Before the rename the local object schema Code clashed with _common.yaml Code (string).
// core/module.ts is not changed: the file is fixed, not the loader.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSpec, REPO_ROOT } from '../module.js';

const file = join(REPO_ROOT, 'contracts', 'openapi', 'inventory.yaml');

describe('inventory.yaml boots through loadSpec (LD-115)', () => {
  it('does not throw (no Code collision)', () => {
    expect(() => loadSpec(file)).not.toThrow();
  });

  it('bundled Code is the _common.yaml string and InventoryCodedSetEntry is the local object', () => {
    const s = loadSpec(file).components.schemas;
    expect(s.Code?.type).toBe('string');
    expect(s.InventoryCodedSetEntry?.type).toBe('object');
    expect(s.InventoryCodedSetEntry.required).toEqual(['code', 'display', 'is_active']);
  });

  it('no $ref is left pointing at a file path after bundling, and every #/components/schemas ref resolves', () => {
    const spec = loadSpec(file);
    const bad: string[] = [];
    const walk = (n: any): void => {
      if (!n || typeof n !== 'object') return;
      if (typeof n.$ref === 'string') {
        const m = /^#\/components\/schemas\/(.+)$/.exec(n.$ref);
        if (m && !spec.components.schemas[m[1]!]) bad.push(n.$ref);
      }
      for (const v of Object.values(n)) walk(v);
    };
    walk(spec);
    expect(bad).toEqual([]);
  });
});
