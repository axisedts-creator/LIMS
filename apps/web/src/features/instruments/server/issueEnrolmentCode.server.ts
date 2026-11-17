import 'server-only';
// E14 issueEnrolmentCode (POST /v1/instruments/agents/{agent_id}/enrolment-codes, x-idempotency: none).
// The code is returned to the caller only: never logged, cached or stored for replay (AC-01.3).
import { ApiError, serverFetch } from '@/core/api/server-fetch';
import { problem } from '@/core/session/types';
import { UUID_RE, type EnrolmentCodeIssued } from './types';

export async function issueEnrolmentCode(agentId: string): Promise<EnrolmentCodeIssued> {
  if (!UUID_RE.test(agentId)) throw new ApiError(404, problem('common.not_found', 'Not found', 404));
  return serverFetch<EnrolmentCodeIssued>(`/v1/instruments/agents/${agentId}/enrolment-codes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}
