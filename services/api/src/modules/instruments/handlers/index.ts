// operationId -> handler map of module instruments (02-CV §2.2). Keys = every operationId of contracts/openapi/instruments.yaml;
// the core fails boot on a missing or extra key (AC-0D-1.2). API-T01: no 501 stubs — every stub throws common.internal
// (fail closed) until its task replaces it with handlers/<operationId>.ts.
// [CONV] stubs generated from one list (as lab T-01) instead of 41 placeholder files; each later task adds its own file.
import type { Handler } from '../../../core/module.js';
import { LimsError } from '../../../core/errors.js';
import { agentsHandlers } from './agents.handlers.js';

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

const implemented: Partial<Record<InstrumentsOperationId, Handler>> = { ...agentsHandlers };   // API-T04: E10-E21

export const handlers: Readonly<Record<InstrumentsOperationId, Handler>> = Object.freeze(
  Object.fromEntries(OPERATION_IDS.map((op) => [op, implemented[op] ?? notImplemented(op)])) as Record<InstrumentsOperationId, Handler>,
);
