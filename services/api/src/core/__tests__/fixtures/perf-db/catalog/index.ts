// T0B-PERF-1 fixture (synthetic data): a handler that records database work the way core/db/tx.ts does, through the request-stats seam
// (core/observability/request-stats.ts, interface in .orchestra/notes/T0B-PERF-1-tests.md): 3 statements, 12 ms + 8 ms + 5 ms.
import { currentRequestStats } from '../../../../observability/request-stats.js';

export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  handlers: {
    listThings: async () => {
      const s = currentRequestStats();
      for (const ms of [12, 8, 5]) s?.recordQuery(ms);
      return { status: 200, body: { items: [{ id: 't1', name: 'alpha' }] } };
    },
    getThing: async (req: any) => ({ status: 200, body: { id: req.params.id, name: 'alpha' } }),
    createThing: async (req: any) => ({ status: 201, body: { id: 't2', name: req.body.name } }),
    deleteThing: async () => ({ status: 204 }),
  },
};
