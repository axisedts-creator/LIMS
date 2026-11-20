// T0D-UI-R04 rail groups, UPDATED by T0D-MSERIES-2 (LD-251, 13-M-SERIES s3): the eight-heading fold of 10-DESIGN-SYSTEM s3 / LD-140 is replaced by the 14 NavGroups
// (order, labels and the build-nav fields are pinned in m2.groups.test.ts). What stays here: every NavGroup is a rail group and no heading is dead or duplicated.
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/messages.ts';
import { NAV_GROUPS } from '../types.ts';
import * as mod from '../rail-groups.ts';

const RAIL_GROUPS = mod.RAIL_GROUPS as readonly { id: string; labelKey: string }[];

describe('RAIL_GROUPS', () => {
  it('one heading per NavGroup (all 14), none dead, none duplicated', () => {
    expect(RAIL_GROUPS.map((g) => g.id)).toEqual([...NAV_GROUPS]);
    expect(new Set(RAIL_GROUPS.map((g) => g.id)).size).toBe(14);
  });
  it('label keys are unique and live in the core catalogue (never rendered as a raw key)', () => {
    const keys = RAIL_GROUPS.map((g) => g.labelKey);
    expect(new Set(keys).size).toBe(14);
    for (const k of keys) { expect(k).toMatch(/^core\.nav\./); expect(t(k)).not.toBe(k); }
  });
});
