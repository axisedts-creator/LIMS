// T0D-FIX-1 item 1 fixture: the handler echoes the query exactly as the pipeline hands it over (after the core split and ajv coercion).
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  handlers: {
    listThings: async (req: any) => {
      ((globalThis as any).__bootCalls ??= []).push('listThings');
      return { status: 200, body: { query: req.query } };
    },
  },
};
