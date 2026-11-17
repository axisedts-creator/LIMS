// C5 T-24 — shared LabPort contract (03-IC §4.5 cases 1–20, 08 §4.14 cases 21–30, 08 A13 cases 31–34, 08 A17 D-61 cases 35–36) on the REAL impl (../LabPort.impl.ts) over a real PG17 tx under RLS.
// PRD AC-20.1; also exercises AC-05.8 (31), AC-17.5 (35, 36), AC-17.6 (33), AC-19.4 (11), AC-14.6 (21). Harness + ASSUMED seams: ./harness.ts, ./labPort.harness.ts.
// Needs the database of tests/db/c5-t03/run.sh (see .orchestra/notes/C5.T-24-verify.cmd). Fails now: ../LabPort.impl.ts does not exist.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { runLabPortContract } from '../../../../../../../packages/fakes/contract-tests/LabPort.contract';
import { closePools, live, requireDb } from './harness.js';
import { realLabPortHarness } from './labPort.harness.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
afterAll(closePools);

describe('T-24 harness', () => {
  it('the migrated database is provided (fails, never skips, under LIMS_T03_REQUIRE_DB=1)', () => {
    if (requireDb) expect(live).toBe(true);
  });
});

if (live) runLabPortContract(realLabPortHarness());
