// T0B-PERF-1 fixture (synthetic data): module `catalog` over the shared fixture spec (SHARED_ROOT).
//   listThings?limit=N  -> N items (default 1); 40 items is well over 1 KB, 1 item is well under it
//   getThing id=slow    -> answers after 400 ms (graceful shutdown tests); id=hang -> never answers until released
export const gate = { release: (): void => undefined, started: 0 };

const item = (i: number) => ({ id: `t${i}`, name: `analyte-${String(i).padStart(3, '0')}-`.padEnd(90, 'x') });

export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  handlers: {
    listThings: async (req: any) => ({ status: 200, body: { items: Array.from({ length: Number(req.query?.limit ?? 1) }, (_, i) => item(i)) } }),
    getThing: async (req: any) => {
      gate.started += 1;
      if (req.params.id === 'slow') await new Promise((r) => setTimeout(r, 400));
      if (req.params.id === 'hang') await new Promise<void>((r) => { gate.release = r; });
      return { status: 200, body: { id: req.params.id, name: 'alpha' } };
    },
    createThing: async (req: any) => ({ status: 201, body: { id: 't2', name: req.body.name } }),
    deleteThing: async () => ({ status: 204 }),
  },
};
