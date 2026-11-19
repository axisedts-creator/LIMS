// T0D-WEBFIX-2 (1): every staff navigation label resolves to English text. LD-301 walkthrough 2026-11-17: ~41 entries showed their raw message key.
// Reads every features/*/nav.manifest.ts (label, section, createLabel) and the sidebar group keys; t() is the real catalogue lookup.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { t } from '@/core/i18n/messages';
import { RAIL_GROUPS } from '@/core/nav/rail-groups';

const FEATURES = join(import.meta.dirname, '..', '..'); // apps/web/src/features
const DOTTED_KEY = /^[a-z0-9_]+(\.[a-z0-9_]+)+$/; // looks like a message key: nav.billing.invoices, lab.nav.qc

interface Item { module: string; id: string; field: 'label' | 'section' | 'createLabel'; key: string }

async function allKeys(): Promise<Item[]> {
  const out: Item[] = [];
  for (const d of readdirSync(FEATURES, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name).sort()) {
    const file = join(FEATURES, d, 'nav.manifest.ts');
    if (!existsSync(file)) continue;
    const m = (await import(pathToFileURL(file).href)) as { navManifest: { entries: { id: string; label: string; section?: string; createLabel?: string }[] } };
    for (const e of m.navManifest.entries) {
      for (const field of ['label', 'section', 'createLabel'] as const) {
        const key = e[field];
        if (key !== undefined) out.push({ module: d, id: e.id, field, key });
      }
    }
  }
  return out;
}

describe('staff navigation text (T0D-WEBFIX-2 item 1)', () => {
  it('finds the manifests (guard against a silently empty scan)', async () => {
    const items = await allKeys();
    expect(items.filter((i) => i.field === 'label').length).toBeGreaterThan(100);
  });

  it('no label, section or create label renders as its own message key', async () => {
    const bad = (await allKeys()).filter((i) => t(i.key) === i.key).map((i) => `${i.id} ${i.field}=${i.key}`);
    expect(bad, `${bad.length} entries show a raw key`).toEqual([]);
  });

  it('no resolved text is dot-separated like a key, and none is blank', async () => {
    const bad = (await allKeys()).filter((i) => { const s = t(i.key); return !s.trim() || DOTTED_KEY.test(s); }).map((i) => `${i.id} ${i.field}`);
    expect(bad).toEqual([]);
  });

  it('every sidebar group heading resolves to text', () => {
    const bad = RAIL_GROUPS.filter((g) => t(g.labelKey) === g.labelKey || DOTTED_KEY.test(t(g.labelKey))).map((g) => g.labelKey);
    expect(bad).toEqual([]);
  });

  it('resolved labels are visible English (start with a letter, no "nav." fragments)', async () => {
    const bad = (await allKeys()).map((i) => ({ i, s: t(i.key) })).filter(({ s }) => !/^[A-Za-z]/.test(s) || /\bnav\./.test(s)).map(({ i, s }) => `${i.id}: ${s}`);
    expect(bad).toEqual([]);
  });
});
