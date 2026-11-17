// E32 listObservedInstrumentCodes (02-TRD §7.3; 01-PRD AC-17.1 server half: the codes observed from an instrument with their current mapping status).
// Read-only. The C3 maps themselves (listInstrumentCodeMaps) are read by the web BFF, not here. 404 before 403 (S-01/S-02): load the instrument, then assert at its centre.
import { toObservedCode } from '../mappers/instruments.mapper.js';
import { createInstrumentsRepo, type InstrumentsRepo } from '../repo/instruments.repo.js';
import { cursorOf, fail, limitOf, page, scope, type AgentsCtx, type Result } from './agents.service.js';
import { loadInstrument } from './instruments.service.js';

const READ = 'instruments.instrument.read';
const CLASSES = ['patient', 'qc', 'calibrator'];
const MAPPING = ['mapped', 'unmapped'];

export function createObservedCodesService(deps: { repo?: InstrumentsRepo } = {}) {
  const repo = deps.repo ?? createInstrumentsRepo();
  return {
    async listObservedInstrumentCodes(ctx: AgentsCtx, input: { instrumentId?: unknown; recordClass?: unknown; mappingStatus?: unknown; cursor?: unknown; limit?: unknown }): Promise<Result> {
      const s = scope(ctx);
      if (input?.recordClass !== undefined && !CLASSES.includes(input.recordClass as string)) fail('/record_class');
      if (input?.mappingStatus !== undefined && !MAPPING.includes(input.mappingStatus as string)) fail('/mapping_status');
      const limit = limitOf(input?.limit);
      const cursor = cursorOf(input?.cursor);
      const ins = await loadInstrument(repo, s, input?.instrumentId, READ);
      const res = await repo.listObservedCodes(s.tx, s.tenantId, ins['id'], { recordClass: input.recordClass, mappingStatus: input.mappingStatus, cursor, limit });
      return { status: 200, body: { data: res.rows.map(toObservedCode), page: page(limit, res.nextCursor) } };
    },
  };
}
export type ObservedCodesService = ReturnType<typeof createObservedCodesService>;
