'use server';
// Server actions for the client components. Errors become { ok:false, code } because a thrown ApiError loses its code
// across the action boundary in production. Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAgent } from './createAgent.server';
import { issueEnrolmentCode } from './issueEnrolmentCode.server';
import type { ActionResult, Agent, CreateAgentInput, EnrolmentCodeIssued } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

export async function createAgentAction(input: CreateAgentInput): Promise<ActionResult<Pick<Agent, 'id' | 'agent_code'>>> {
  return run(async () => {
    const a = await createAgent(input);
    return { id: a.id, agent_code: a.agent_code };
  });
}

export async function issueEnrolmentCodeAction(agentId: string): Promise<ActionResult<EnrolmentCodeIssued>> {
  return run(async () => {
    const r = await issueEnrolmentCode(agentId);
    return { enrolment_code: r.enrolment_code, expires_at: r.expires_at, credential_id: r.credential_id };
  });
}
