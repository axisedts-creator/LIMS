// Test fixture for T0D-01. Valid shape: name = directory = spec stem, handlers = spec operationIds, produces = IC §3.25.
const calls = ((globalThis as any).__bootCalls ??= []) as string[];
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  handlers: {
    listThings: async () => { calls.push('listThings'); return { status: 200, body: { items: [{ id: 't1', name: 'alpha' }] } }; },
    getThing: async (req: any) => { calls.push('getThing'); return { status: 200, body: { id: req.params.id, name: 'alpha' } }; },
    createThing: async (req: any) => { calls.push('createThing'); return { status: 201, body: { id: 't2', name: req.body.name }, headers: { 'x-fixture': 'created' } }; },
  },
};
