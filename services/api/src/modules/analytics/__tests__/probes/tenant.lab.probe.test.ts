// AN-T21 — P1, P3, P4, P5, X3 for the lab-side reports of the AN-T11 world: tests done (#9), quality indicators (#13), delivery (#14), interfaces (#15).
// The world carries tenant B rows with SENTINEL values, NULL-centre results / deliveries, and a foreign instrument / agent / test / department.
import { vi } from 'vitest';
import {
  A1, A2, AGENT, B1, BR1, BRB, DEPT, INSTR, OWNER_A1, OWNER_ALL, SENTINEL, TEST, WINDOW, makeCtx11, seedT11,
} from '../../handlers/__tests__/helpers.t11.js';
import { runReportBattery, type World } from './battery.js';

vi.mock('../../repository/rollups.repo.js', async () => (await import('../../handlers/__tests__/helpers.t11.js')).rollupsMockT11);
vi.mock('../../repository/labels.repo.js', async () => (await import('../../handlers/__tests__/helpers.t11.js')).labelsRepoMockT11);
vi.mock('../../repository/sourceViews.repo.js', async () => (await import('../../handlers/__tests__/helpers.t11.js')).sourceViewsMockT11);

const world: World = {
  name: 'lab',
  seed: seedT11,
  makeCtx: (actor) => makeCtx11(actor),
  actorsFor: () => ({ all: OWNER_ALL, a1: OWNER_A1 }),
  window: WINDOW,
  centres: { a1: A1, a2: A2, b: B1 },
  branches: { containsA1andA2: BR1, b: BRB },
  forbidden: [String(SENTINEL), B1, BRB, DEPT.FOREIGN, TEST.FOREIGN, INSTR.FOREIGN, AGENT.FOREIGN, 'Tenant B Doppler'],
  foreignDepartment: DEPT.FOREIGN, homeDepartment: DEPT.H,
};
runReportBattery(world, ['getTestsDoneReport', 'getQualityIndicatorsReport', 'getDeliveryReport', 'getInterfacesReport']);
