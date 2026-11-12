// Test fixture for CR-C16-024: same handlers as fixtures/ok/catalog; its spec carries `x-extensible: true`.
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  handlers: {
    listThings: async () => ({ status: 200, body: { items: [{ id: 't1', name: 'alpha' }] } }),
    getThing: async (req: any) => ({ status: 200, body: { id: req.params.id, name: 'alpha' } }),
    createThing: async (req: any) => ({ status: 201, body: { id: 't2', name: req.body.name } }),
    deleteThing: async () => ({ status: 204 }),
  },
};
