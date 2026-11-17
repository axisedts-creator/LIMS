import 'server-only';
// PUT /v1/catalog/tests/{id}/tat-targets (TatTargetsSet, If-Match). T0D-TESTMGMT-1 (LD-318): routine / urgent targets (seconds) plus the
// seven stage targets in minutes (StageTatTarget). Validated before any request; at most one target per stage.
import { serverFetch } from '@/core/api/server-fetch';
import { ifMatch, json, uuid } from './guard';
import { bad, int, list, oneOf, pick } from './shared';

export const TAT_STAGES = ['registration', 'sample_collection', 'accession', 'result', 'approval_1', 'approval_2', 'release'] as const;
export interface StageTarget { stage: (typeof TAT_STAGES)[number]; target_minutes: number }
export interface TatTarget { priority: 'routine' | 'urgent'; segment: 'within_lab' | 'total'; target_seconds: number }

const target = (v: unknown) => pick(v, { priority: oneOf('routine', 'urgent'), segment: oneOf('within_lab', 'total'), target_seconds: int(60, 2_592_000) }, ['priority', 'segment', 'target_seconds']);
const stage = (v: unknown) => pick(v, { stage: oneOf(...TAT_STAGES), target_minutes: int(0, 43_200) }, ['stage', 'target_minutes']);

export async function setTestTatTargets(testId: string, version: number, input: { targets: TatTarget[]; stage_targets?: StageTarget[] }) {
  const body = pick(input, { targets: list(2, target), stage_targets: list(7, stage) }, ['targets']);
  const stages = (body['stage_targets'] as StageTarget[] | undefined) ?? [];
  if (new Set(stages.map((s) => s.stage)).size !== stages.length) throw bad();
  return serverFetch<{ targets: TatTarget[]; stage_targets: StageTarget[] }>(`/v1/catalog/tests/${uuid(testId)}/tat-targets`, {
    method: 'PUT',
    headers: json({ 'if-match': ifMatch(version) }),
    body: JSON.stringify(body),
  });
}
