// C12.T-20 — nav manifest (04-UI-UX §1 Navigation table; CR-C12-002 route ids; AC-0D-7.5 build check). Static + build-nav; no rendering.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildNav } from '../../../core/nav/build-nav.ts';
import { navManifest } from '../nav.manifest.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..', '..');
const FEATURES = join(import.meta.dirname, '..', '..');
const permYaml = readFileSync(join(ROOT, 'contracts', 'permissions.yaml'), 'utf8');
const definedPerms = new Set([...permYaml.matchAll(/code:\s*([a-z_.]+)/g)].map((m) => m[1]));

// 04-UI-UX §1: id, route id, permission, order, chord
const SPEC: [string, string, string, number, string | undefined][] = [
  ['inventory.home', 'staff.inventory.home', 'inventory.item.read', 10, 'g y'],
  ['inventory.stock', 'staff.inventory.stock', 'inventory.item.read', 20, undefined],
  ['inventory.purchase_orders', 'staff.inventory.purchase_orders', 'inventory.item.read', 30, undefined],
  ['inventory.receipts', 'staff.inventory.receipts', 'inventory.item.read', 40, undefined],
  ['inventory.transfers', 'staff.inventory.transfers', 'inventory.item.read', 50, undefined],
  ['inventory.counts', 'staff.inventory.counts', 'inventory.item.read', 60, undefined],
  ['inventory.bench', 'staff.inventory.bench', 'inventory.bench.record', 70, undefined],
  ['inventory.items', 'staff.inventory.items', 'inventory.item.read', 80, undefined],
  ['inventory.rules', 'staff.inventory.rules', 'inventory.item.read', 90, undefined],
  ['inventory.unresolved', 'staff.inventory.unresolved', 'inventory.item.read', 100, undefined],
  ['inventory.alerts', 'staff.inventory.alerts', 'inventory.item.read', 110, undefined],
  ['inventory.reports', 'staff.inventory.reports', 'inventory.item.read', 120, undefined],
  ['inventory.suppliers', 'staff.inventory.suppliers', 'inventory.item.read', 130, undefined],
  ['inventory.stores', 'staff.inventory.stores', 'inventory.item.read', 140, undefined],
  ['inventory.settings', 'staff.inventory.settings', 'inventory.master.manage', 150, undefined],
];

describe('C12.T-20 nav.manifest.ts', () => {
  it('module inventory with exactly the 15 spec entries', () => {
    expect(navManifest.module).toBe('inventory');
    expect(navManifest.entries.map((e) => e.id).sort()).toEqual(SPEC.map((s) => s[0]).sort());
  });
  it.each(SPEC)('%s -> route %s, permission %s, order %i, chord %s, group inventory, phase 2', (id, routeId, permission, order, chord) => {
    const e = navManifest.entries.find((x) => x.id === id)!;
    expect(e, id).toBeTruthy();
    expect(e.routeId).toBe(routeId);
    expect(e.permission).toBe(permission);
    expect(e.order).toBe(order);
    expect(e.group).toBe('inventory');
    expect(e.phase).toBe('2');
    expect(e.chord).toBe(chord);
    expect(typeof e.label === 'string' && e.label.length > 0, 'label message key').toBe(true);
    expect(definedPerms.has(e.permission), 'permission exists in permissions.yaml').toBe(true);
  });
  it('build-nav accepts the inventory manifest (route ids in routes.yaml, staff_web, same permission, no duplicate id/chord across modules)', async () => {
    const { errors, entries } = await buildNav(FEATURES, readFileSync(join(ROOT, 'contracts', 'routes.yaml'), 'utf8'));
    expect(errors.filter((e) => /inventory|g y/.test(e))).toEqual([]);
    expect(entries.filter((e) => e.module === 'inventory').length).toBe(15);
  });
  it('does not import from another feature folder (REQ-ARCH-076)', () => {
    const src = readFileSync(join(FEATURES, 'inventory', 'nav.manifest.ts'), 'utf8');
    expect(/from\s+['"][^'"]*\/features\/(?!inventory\b)[a-z_]+\//.test(src)).toBe(false);
  });
});
