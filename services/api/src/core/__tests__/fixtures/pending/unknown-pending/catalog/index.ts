// T0B-BOOTGATE-1 fixture: every spec operation has a handler, but the pending list names ghostOp (typo / not in the spec) -> boot fails naming ghostOp.
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  pendingOperations: ['ghostOp'],
  handlers: {
    listThings: async () => ({ status: 200, body: { items: [] } }),
    getThing: async () => ({ status: 200, body: { id: 'x', name: 'alpha' } }),
    createThing: async () => ({ status: 201, body: { id: 't2', name: 'n' } }),
    deleteThing: async () => ({ status: 204 }),
  },
};
