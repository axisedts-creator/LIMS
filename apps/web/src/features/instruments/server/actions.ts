'use server';
// Server actions for the client components. Errors become { ok:false, code } because a thrown ApiError loses its code
// across the action boundary in production. Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAgent } from './createAgent.server';
import { issueEnrolmentCode } from './issueEnrolmentCode.server';
import { listAgentCommands } from './listAgentCommands.server';
import { requestAgentCommand } from './requestAgentCommand.server';
import { retireAgent } from './retireAgent.server';
import { revokeAgent } from './revokeAgent.server';
import { updateAgent } from './updateAgent.server';
import type { ActionResult, Agent, AgentCommand, AgentCommandKind, CreateAgentInput, EnrolmentCodeIssued, ReasonInput, UpdateAgentInput } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, status: e.status, code: e.problem.code };
    throw e;
  }
}

export async function createAgentAction(input: CreateAgentInput, idempotencyKey: string): Promise<ActionResult<Pick<Agent, 'id' | 'agent_code'>>> {
  return run(async () => {
    const a = await createAgent(input, idempotencyKey);
    return { id: a.id, agent_code: a.agent_code };
  });
}

export async function issueEnrolmentCodeAction(agentId: string): Promise<ActionResult<EnrolmentCodeIssued>> {
  return run(async () => {
    const r = await issueEnrolmentCode(agentId);
    return { enrolment_code: r.enrolment_code, expires_at: r.expires_at, credential_id: r.credential_id };
  });
}

export async function updateAgentAction(agentId: string, version: number, input: UpdateAgentInput): Promise<ActionResult<{ version: number }>> {
  return run(async () => ({ version: (await updateAgent(agentId, version, input)).version }));
}

export async function revokeAgentAction(agentId: string, version: number, reason: ReasonInput): Promise<ActionResult<{ version: number }>> {
  return run(async () => ({ version: (await revokeAgent(agentId, version, reason)).version }));
}

export async function retireAgentAction(agentId: string, version: number, reason: ReasonInput): Promise<ActionResult<{ version: number }>> {
  return run(async () => ({ version: (await retireAgent(agentId, version, reason)).version }));
}

export async function requestAgentCommandAction(agentId: string, cmd: { kind: AgentCommandKind; since?: string }, idempotencyKey: string): Promise<ActionResult<Pick<AgentCommand, 'command_id' | 'state'>>> {
  return run(async () => {
    const c = await requestAgentCommand(agentId, cmd, idempotencyKey);
    return { command_id: c.command_id, state: c.state };
  });
}

export async function listAgentCommandsAction(agentId: string): Promise<ActionResult<AgentCommand[]>> {
  return run(async () => (await listAgentCommands(agentId)).data);
}
