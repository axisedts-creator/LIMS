'use server';
// Server actions for the client components. Errors become { ok:false, code } because a thrown ApiError loses its code
// across the action boundary in production. Only ApiError is mapped; anything else rethrows to the error boundary.
import 'server-only';
import { ApiError } from '@/core/api/server-fetch';
import { createAgent } from './createAgent.server';
import { getAgentLogBundle } from './getAgentLogBundle.server';
import { issueEnrolmentCode } from './issueEnrolmentCode.server';
import { listAgentCommands } from './listAgentCommands.server';
import { requestAgentCommand } from './requestAgentCommand.server';
import { retireAgent } from './retireAgent.server';
import { revokeAgent } from './revokeAgent.server';
import { updateAgent } from './updateAgent.server';
import { createInstrument } from './createInstrument.server';
import { goLiveInstrument } from './goLiveInstrument.server';
import { resumeInstrument } from './resumeInstrument.server';
import { retireInstrument } from './retireInstrument.server';
import { startInstrumentCommissioning } from './startInstrumentCommissioning.server';
import { suspendInstrument } from './suspendInstrument.server';
import { updateInstrument } from './updateInstrument.server';
import { updateInstrumentSettings } from './updateInstrumentSettings.server';
import { createInstrumentCodeMap } from './createInstrumentCodeMap.server';
import { listInstrumentCodeMaps } from './listInstrumentCodeMaps.server';
import { updateInstrumentCodeMap } from './updateInstrumentCodeMap.server';
import { upsertInstrumentCodeMaps } from './upsertInstrumentCodeMaps.server';
import { getTestRef, listUnitRefs, searchTests } from './catalogLookups.server';
import { getInstrumentMessage } from './getInstrumentMessage.server';
import { getInstrumentMessageRaw } from './getInstrumentMessageRaw.server';
import { rematchInstrumentRecord } from './rematchInstrumentRecord.server';
import { reprocessInstrumentMessage } from './reprocessInstrumentMessage.server';
import { searchInstrumentMessages, type SearchMessagesInput } from './searchInstrumentMessages.server';
import type { MessageDetailDto, MessageRaw, MessageSummary, ReasonFields, RematchResult, ReprocessResult } from './messages';
import type { CodeMapCreate, CodeMapFields, CodeMapPatch, CodeMapResult, InstrumentCodeMap, TestRef, UnitRef } from './codeMaps';
import type { InstrumentBody } from '../forms/instrument';
import type { ActionResult, Agent, AgentCommand, AgentLogBundle,AgentCommandKind, CreateAgentInput, EnrolmentCodeIssued, FieldProblemDto, GoLiveChecklist, InstrumentSettings, InstrumentSettingsBody, ReasonInput, UpdateAgentInput } from './types';

async function run<T>(f: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await f() };
  } catch (e) {
    if (e instanceof ApiError) {
      const errors = e.problem['errors'];
      return { ok: false, status: e.status, code: e.problem.code, ...(Array.isArray(errors) ? { errors: errors.slice(0, 50) as FieldProblemDto[] } : {}) };
    }
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

export async function getAgentLogBundleAction(agentId: string, bundleId: string): Promise<ActionResult<Pick<AgentLogBundle, 'bundle_id' | 'lines'>>> {
  return run(async () => {
    const b = await getAgentLogBundle(agentId, bundleId);
    return { bundle_id: b.bundle_id, lines: b.lines };
  });
}

// ── WEB-T03 instruments (E24–E31). Data is { version } only; the page re-reads through router.refresh(). ──
const versionOf = (i: { version: number }) => ({ version: i.version });

export async function createInstrumentAction(input: InstrumentBody, idempotencyKey: string): Promise<ActionResult<{ id: string; instrument_code: string }>> {
  return run(async () => {
    const i = await createInstrument(input, idempotencyKey);
    return { id: i.id, instrument_code: i.instrument_code };
  });
}

export async function updateInstrumentAction(instrumentId: string, version: number, patch: Partial<InstrumentBody>): Promise<ActionResult<{ version: number }>> {
  return run(async () => versionOf(await updateInstrument(instrumentId, version, patch)));
}

export async function startInstrumentCommissioningAction(instrumentId: string, version: number): Promise<ActionResult<{ version: number }>> {
  return run(async () => versionOf(await startInstrumentCommissioning(instrumentId, version)));
}

export async function goLiveInstrumentAction(instrumentId: string, version: number, input: { checklist: GoLiveChecklist; evidence_note: string }): Promise<ActionResult<{ version: number }>> {
  return run(async () => versionOf(await goLiveInstrument(instrumentId, version, input)));
}

export async function suspendInstrumentAction(instrumentId: string, version: number, reason: string): Promise<ActionResult<{ version: number }>> {
  return run(async () => versionOf(await suspendInstrument(instrumentId, version, reason)));
}

export async function resumeInstrumentAction(instrumentId: string, version: number): Promise<ActionResult<{ version: number }>> {
  return run(async () => versionOf(await resumeInstrument(instrumentId, version)));
}

// ── WEB-T06 SCR-11 settings (E41). Returns the new DTO; the form keeps its version for the next If-Match. ──
export async function updateInstrumentSettingsAction(version: number, body: InstrumentSettingsBody): Promise<ActionResult<InstrumentSettings>> {
  return run(() => updateInstrumentSettings(version, body));
}

// ── WEB-T04 SCR-08 mappings (C3 #92–#95 + editor lookups). Each BFF fn checks catalog.instrument_code_map.manage itself. ──
export async function createInstrumentCodeMapAction(input: CodeMapCreate, idempotencyKey: string): Promise<ActionResult<{ id: string; version: number }>> {
  return run(async () => {
    const m = await createInstrumentCodeMap(input, idempotencyKey);
    return { id: m.id, version: m.version };
  });
}

export async function updateInstrumentCodeMapAction(mapId: string, version: number, patch: CodeMapPatch): Promise<ActionResult<{ version: number }>> {
  return run(async () => versionOf(await updateInstrumentCodeMap(mapId, version, patch)));
}

export async function upsertInstrumentCodeMapsAction(instrumentId: string, maps: CodeMapFields[], idempotencyKey: string): Promise<ActionResult<{ results: CodeMapResult[] }>> {
  return run(async () => ({ results: (await upsertInstrumentCodeMaps(instrumentId, maps, idempotencyKey)).results }));
}

/** Source rows for "Copy from instrument…" (active maps of the other instrument). */
export async function listInstrumentCodeMapsAction(instrumentId: string): Promise<ActionResult<InstrumentCodeMap[]>> {
  return run(async () => (await listInstrumentCodeMaps(instrumentId, { isActive: true })).data);
}

export async function searchTestsAction(q: string): Promise<ActionResult<{ id: string; code: string; name: string }[]>> {
  return run(() => searchTests(q));
}

export async function getTestRefAction(testId: string): Promise<ActionResult<TestRef>> {
  return run(() => getTestRef(testId));
}

export async function listUnitRefsAction(): Promise<ActionResult<UnitRef[]>> {
  return run(() => listUnitRefs());
}

// ── WEB-T05 SCR-09/10 messages (E34–E36, E38, E39). The caller owns the Idempotency-Key so a retry reuses it. The sample barcode is only ever a POST body. ──
export async function searchInstrumentMessagesAction(input: SearchMessagesInput): Promise<ActionResult<{ data: MessageSummary[] }>> {
  return run(() => searchInstrumentMessages(input));
}

export async function getInstrumentMessageRawAction(id: string): Promise<ActionResult<MessageRaw>> {
  return run(() => getInstrumentMessageRaw(id));
}

export async function getInstrumentMessageAction(id: string, opts: { previewParse?: boolean } = {}): Promise<ActionResult<MessageDetailDto>> {
  return run(() => getInstrumentMessage(id, opts));
}

export async function reprocessInstrumentMessageAction(id: string, input: ReasonFields, idempotencyKey: string): Promise<ActionResult<ReprocessResult>> {
  return run(() => reprocessInstrumentMessage(id, input, idempotencyKey));
}

export async function rematchInstrumentRecordAction(recordId: string, input: ReasonFields & { sampleBarcode: string }, idempotencyKey: string): Promise<ActionResult<RematchResult>> {
  return run(() => rematchInstrumentRecord(recordId, input, idempotencyKey));
}

export async function retireInstrumentAction(instrumentId: string, version: number, reason: string): Promise<ActionResult<{ version: number }>> {
  return run(async () => versionOf(await retireInstrument(instrumentId, version, reason)));
}
