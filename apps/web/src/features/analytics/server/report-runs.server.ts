import 'server-only';
// #28 getReportRun (BFF read). The id is validated by the caller; this is the last line of defence against path injection.
import { serverFetch } from '@/core/api/server-fetch';
import { UUID_RE } from '../report-codes';
import type { Json } from './reports.server';

export function getReportRun(id: string) {
  if (!UUID_RE.test(id)) throw new Error('invalid report run id');
  return serverFetch<Json>(`/v1/analytics/report-runs/${id}`);
}
