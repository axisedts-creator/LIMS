// CR TENANT-LOGO-1 fixture: the handlers answer with the SHAPE of the body the pipeline handed over (never the bytes).
const shape = (body: any) => Object.fromEntries(Object.entries(body ?? {}).map(([k, v]: [string, any]) => [k,
  v && typeof v === 'object'
    ? { filename: v.filename, mimeType: v.mimeType, isBuffer: Buffer.isBuffer(v.bytes), size: v.bytes?.length, first4: Buffer.from(v.bytes ?? []).subarray(0, 4).toString('hex') }
    : v]));

export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  handlers: {
    uploadThing: async (req: any) => { ((globalThis as any).__bootCalls ??= []).push('uploadThing'); return { status: 200, body: shape(req.body) }; },
    createNote: async (req: any) => { ((globalThis as any).__bootCalls ??= []).push('createNote'); return { status: 200, body: shape(req.body) }; },
  },
};
