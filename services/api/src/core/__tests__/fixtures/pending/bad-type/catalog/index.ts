// T0B-BOOTGATE-1 fixture: pendingOperations must be a string array; a bare string is a boot failure naming the field and the module.
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  pendingOperations: 'deleteThing',
  handlers: {
    listThings: async () => ({ status: 200, body: { items: [] } }),
    getThing: async () => ({ status: 200, body: { id: 'x', name: 'alpha' } }),
    createThing: async () => ({ status: 201, body: { id: 't2', name: 'n' } }),
  },
};
