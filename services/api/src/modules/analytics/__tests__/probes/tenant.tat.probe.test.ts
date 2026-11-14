// AN-T21 — P1, P3, P5, X3 for the TAT report (#10) over the AN-T12 world (tat_facts of tenant A and tenant B, NULL-centre order facts).
import { vi } from 'vitest';
import { A1, A2, B1, BR1, BRB, OWNER_A1, OWNER_ALL, SENTINEL, WINDOW12, makeCtx12, seedT12 } from '../../handlers/__tests__/helpers.t12.js';
import { runReportBattery, type World } from './battery.js';

vi.mock('../../repository/tat.repo.js', async () => (await import('../../handlers/__tests__/helpers.t12.js')).tatMockT12);
vi.mock('../../repository/rollups.repo.js', async () => (await import('../../handlers/__tests__/helpers.t12.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('../../handlers/__tests__/helpers.t12.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('../../handlers/__tests__/helpers.t12.js')).sourceViewsMockT11);

const world: World = {
  name: 'tat',
  seed: seedT12,
  makeCtx: (actor) => makeCtx12(actor),
  actorsFor: () => ({ all: OWNER_ALL, a1: OWNER_A1 }),
  window: WINDOW12,
  centres: { a1: A1, a2: A2, b: B1 },
  branches: { containsA1andA2: BR1, b: BRB },
  forbidden: [String(SENTINEL), B1, BRB],
};
runReportBattery(world, ['getTatReport']);
