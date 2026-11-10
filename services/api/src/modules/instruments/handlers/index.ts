// operationId -> handler map of module instruments (02-CV §2.2). Keys = every operationId of contracts/openapi/instruments.yaml;
// the core fails boot on a missing or extra key (AC-0D-1.2). API-T01: no 501 stubs — every stub throws common.internal
// (fail closed) until its task replaces it with handlers/<operationId>.ts.
// [CONV] stubs generated from one list (as lab T-01) instead of 41 placeholder files; each later task adds its own file.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { agentsHandlers } from './agents.handlers.js';
import { attachmentsHandlers } from './attachments.handlers.js';
import { deviceHandlers } from './device.handlers.js';
import { ingestHandlers } from './ingest.handlers.js';
import { instrumentsHandlers } from './instruments.handlers.js';
import { messagesHandlers } from './messages.handlers.js';
import { reprocessHandlers } from './reprocess.handlers.js';

const OPERATION_IDS = [
  // agent (deviceToken)
  'enrolAgent', 'getAgentConfig', 'submitAgentHeartbeat', 'submitMessageBatch', 'submitHostQuery', 'submitAttachment',
  'submitAgentLogBundle', 'downloadAgentRelease',
  // agents (bearerJwt)
  'listAgents', 'createAgent', 'getAgent', 'updateAgent', 'issueEnrolmentCode', 'revokeAgent', 'retireAgent',
  'requestAgentCommand', 'listAgentCommands', 'listAgentHealthTransitions', 'getAgentLogBundle', 'listAgentReleases',
  'listDrivers',
  // instruments
  'listInstruments', 'createInstrument', 'getInstrument', 'updateInstrument', 'startInstrumentCommissioning',
  'goLiveInstrument', 'suspendInstrument', 'resumeInstrument', 'retireInstrument', 'listObservedInstrumentCodes',
  // messages
  'listInstrumentMessages', 'searchInstrumentMessages', 'getInstrumentMessage', 'getInstrumentMessageRaw',
  'downloadInstrumentAttachment', 'reprocessInstrumentMessage', 'rematchInstrumentRecord',
  // settings, rejections
  'getInstrumentSettings', 'updateInstrumentSettings', 'listMessageRejections',
] as const;

export type InstrumentsOperationId = (typeof OPERATION_IDS)[number];

const notImplemented = (operationId: string): Handler => async () => {
  throw new LimsError('common.internal', `instruments ${operationId} not implemented`);
};

const implemented: Partial<Record<InstrumentsOperationId, Handler>> = { ...agentsHandlers, ...deviceHandlers, ...ingestHandlers, ...attachmentsHandlers, ...messagesHandlers, ...reprocessHandlers, ...instrumentsHandlers };   // API-T04: E10-E21, API-T06: E01-E03/E07/E08, API-T09: E04, API-T11: E06/E37, API-T12: E33-E36/E42, API-T13: E38/E39, INT-T03: E05/E22-E32/E40/E41 wired

export const handlers: Readonly<Record<InstrumentsOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? notImplemented(op)])) as Record<InstrumentsOperationId, Handler>,
);
