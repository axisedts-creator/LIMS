'use server';
// Server actions for the T-24 client components. A thrown ApiError loses its code across the action boundary in production, so errors become
// { ok:false, status, code } (same as catalog actions.ts). Reads that the client polls or loads lazily go through here too: the bearer JWT
// never reaches client code (REQ-SEC-068).
import 'server-only';
import { createBreakpointImport, transitionBreakpointSet } from './breakpointWrites.server';
import { getBreakpointSet } from './getBreakpointSet.server';
import { listBreakpointImportIssues } from './listBreakpointImportIssues.server';
import { listBreakpointRows } from './listBreakpointRows.server';
import { run } from './shared';
import {
  createAstPanel, createPlatingProtocol, createVocabMap, listAstPanels, listCodedSet, listInstrumentAstDefaults, listInstruments, listMicroTests, listPlatingProtocols, listVocabMaps,
  putInstrumentAstDefault, updateMicroSettings, upsertCode, versionAstPanel, versionPlatingProtocol,
} from './settings.server';
import type {
  ActionResult, AstPanelDto, AstPanelInput, BreakpointImportIssueDto, BreakpointRowDto, BreakpointSetDto, InstrumentAstDefaultDto, InstrumentLite, MicroCodeDto, MicroCodeInput, MicroSettingsDto,
  MicroSettingsInput, PlatingProtocolDto, PlatingProtocolInput, TestLite, VocabMapDto, VocabMapInput,
} from './types';

// ---- breakpoint tables
export async function createBreakpointImportAction(form: FormData, idempotencyKey: string): Promise<ActionResult<BreakpointSetDto>> {
  return run(() => createBreakpointImport(form, idempotencyKey));
}
export async function pollBreakpointSetAction(id: string): Promise<ActionResult<BreakpointSetDto>> {
  return run(() => getBreakpointSet(id));
}
export async function listBreakpointIssuesAction(id: string, severity?: 'error' | 'warning'): Promise<ActionResult<BreakpointImportIssueDto[]>> {
  return run(async () => (await listBreakpointImportIssues(id, { ...(severity ? { severity } : {}) })).data);
}
export async function listBreakpointRowsAction(id: string, q: { antibioticCode?: string; organismCode?: string } = {}): Promise<ActionResult<BreakpointRowDto[]>> {
  return run(async () => (await listBreakpointRows(id, q)).data);
}
export async function activateBreakpointSetAction(id: string, version: number, effectiveFrom?: string): Promise<ActionResult<BreakpointSetDto>> {
  return run(() => transitionBreakpointSet(id, 'activate', version, effectiveFrom ? { effective_from: effectiveFrom } : {}));
}
export async function retireBreakpointSetAction(id: string, version: number): Promise<ActionResult<BreakpointSetDto>> {
  return run(() => transitionBreakpointSet(id, 'retire', version));
}
export async function discardBreakpointSetAction(id: string, version: number): Promise<ActionResult<BreakpointSetDto>> {
  return run(() => transitionBreakpointSet(id, 'discard', version));
}

// ---- settings
export async function updateMicroSettingsAction(version: number, input: MicroSettingsInput): Promise<ActionResult<MicroSettingsDto>> {
  return run(() => updateMicroSettings(version, input));
}
export async function listCodedSetAction(set: string): Promise<ActionResult<MicroCodeDto[]>> {
  return run(async () => (await listCodedSet(set)).data);
}
export async function upsertCodeAction(set: string, code: string, input: MicroCodeInput): Promise<ActionResult<MicroCodeDto>> {
  return run(() => upsertCode(set, code, input));
}
export async function listPlatingProtocolsAction(): Promise<ActionResult<PlatingProtocolDto[]>> {
  return run(async () => (await listPlatingProtocols()).data);
}
export async function createPlatingProtocolAction(input: PlatingProtocolInput, idempotencyKey: string): Promise<ActionResult<PlatingProtocolDto>> {
  return run(() => createPlatingProtocol(input, idempotencyKey));
}
export async function versionPlatingProtocolAction(id: string, version: number, input: PlatingProtocolInput, idempotencyKey: string): Promise<ActionResult<PlatingProtocolDto>> {
  return run(() => versionPlatingProtocol(id, version, input, idempotencyKey));
}
export async function listAstPanelsAction(): Promise<ActionResult<AstPanelDto[]>> {
  return run(async () => (await listAstPanels()).data);
}
export async function createAstPanelAction(input: AstPanelInput, idempotencyKey: string): Promise<ActionResult<AstPanelDto>> {
  return run(() => createAstPanel(input, idempotencyKey));
}
export async function versionAstPanelAction(id: string, version: number, input: AstPanelInput, idempotencyKey: string): Promise<ActionResult<AstPanelDto>> {
  return run(() => versionAstPanel(id, version, input, idempotencyKey));
}
export async function listInstrumentsAction(): Promise<ActionResult<InstrumentLite[]>> {
  return run(async () => (await listInstruments()).data);
}
export async function listMicroTestsAction(): Promise<ActionResult<TestLite[]>> {
  return run(async () => (await listMicroTests()).data);
}
export async function listVocabMapsAction(instrumentId: string): Promise<ActionResult<VocabMapDto[]>> {
  return run(async () => (await listVocabMaps(instrumentId)).data);
}
export async function createVocabMapAction(input: VocabMapInput, idempotencyKey: string): Promise<ActionResult<VocabMapDto>> {
  return run(() => createVocabMap(input, idempotencyKey));
}
export async function listInstrumentAstDefaultsAction(): Promise<ActionResult<InstrumentAstDefaultDto[]>> {
  return run(async () => (await listInstrumentAstDefaults()).data);
}
export async function putInstrumentAstDefaultAction(instrumentId: string, input: { standard: string; standard_version: string }, version?: number): Promise<ActionResult<InstrumentAstDefaultDto>> {
  return run(() => putInstrumentAstDefault(instrumentId, input, version));
}
