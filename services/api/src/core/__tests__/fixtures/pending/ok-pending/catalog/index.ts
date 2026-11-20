// T0B-BOOTGATE-1 fixture: deleteThing has no handler and is listed pending -> boot ok, DELETE answers 501.
const calls = ((globalThis as any).__bootCalls ??= []) as string[];
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  pendingOperations: ['deleteThing'],
  handlers: {
    listThings: async () => { calls.push('listThings'); return { status: 200, body: { items: [{ id: 't1', name: 'alpha' }] } }; },
    getThing: async (req: any) => { calls.push('getThing'); return { status: 200, body: { id: req.params.id, name: 'alpha' } }; },
    createThing: async (req: any) => { calls.push('createThing'); return { status: 201, body: { id: 't2', name: req.body.name } }; },
  },
};
