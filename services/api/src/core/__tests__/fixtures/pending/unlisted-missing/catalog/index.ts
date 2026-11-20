// T0B-BOOTGATE-1 fixture: createThing is pending, but deleteThing has no handler and is NOT listed -> boot fails naming deleteThing.
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  pendingOperations: ['createThing'],
  handlers: {
    listThings: async () => ({ status: 200, body: { items: [] } }),
    getThing: async () => ({ status: 200, body: { id: 'x', name: 'alpha' } }),
  },
};
