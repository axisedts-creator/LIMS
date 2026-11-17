// T3 export.state.ts — 03-APP-FLOW §2.7. Assumed API (pure): STATES, canTransition(from: Status, to: Status): boolean.
import { describe, expect, it } from 'vitest';
import { STATES, canTransition } from '../export.state.js';
import { checkStateTable, type Edge } from './state-table.helper.js';

const ALL = ['queued', 'building', 'ready', 'failed', 'expired'];
const allowed: Edge[] = [
  ['queued', 'building'], ['building', 'ready'], ['ready', 'expired'], ['building', 'failed'], ['queued', 'failed'],
];
checkStateTable('audit export', STATES, ALL, canTransition as never, allowed, false);

describe('audit export terminals', () => {
  it('failed and expired have no exits', () => {
    for (const f of ['failed', 'expired']) for (const t of ALL) expect(canTransition(f as never, t as never)).toBe(false);
  });
});
