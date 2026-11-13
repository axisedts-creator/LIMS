// C14 T13 — the shared SmartReportPort contract (packages/fakes/contract-tests/SmartReportPort.contract.ts, IC §4.10, 02-TRD §7.1) run on the REAL port:
// cases 1-7 and 10-14 (+ (4) disabled tenant and the D-111 case). Cases 8-9 are withdrawn (08 A2.3). Done when: all pass on the real impl, summary_not_ready never thrown.
// Harness: ./t13.harness.ts (real port + real summary.service + engine over the T12 repository emulators and port fakes).
// Fails now: the T01 placeholder port always throws smartreport.feature_disabled (cases 1-3, 5-7, 10-14 fail; (4) passes).
import { vi } from 'vitest';

vi.mock('../repository/summaries.repo.js', async () => (await import('./t12.fakes.js')).summariesRepoFake);
vi.mock('../repository/bindings.repo.js', async () => (await import('./t12.fakes.js')).bindingsRepoFake);
vi.mock('../repository/library.repo.js', async () => (await import('./t12.fakes.js')).libraryRepoFake);
vi.mock('../repository/blocks.repo.js', async () => (await import('./t12.fakes.js')).blocksRepoFake);
vi.mock('../repository/rules.repo.js', async () => (await import('./t12.fakes.js')).rulesRepoFake);
vi.mock('../repository/mappings.repo.js', async () => (await import('./t12.fakes.js')).mappingsRepoFake);
vi.mock('../repository/groups.repo.js', async () => (await import('./t12.fakes.js')).groupsRepoFake);
vi.mock('../repository/codedSets.repo.js', async () => (await import('./t12.fakes.js')).codedSetsRepoFake);

import { runSmartReportPortContract } from '../../../../../../packages/fakes/contract-tests/SmartReportPort.contract';
import { smartReportPort } from '../ports/SmartReportPort.impl.js';
import { realPortHarness } from './t13.harness.js';

runSmartReportPortContract(realPortHarness(() => smartReportPort));
