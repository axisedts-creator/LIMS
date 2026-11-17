// T0B-BOOTGATE-1 fixture: a module with no handler at all and every spec operation listed pending boots.
export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  pendingOperations: ['listThings', 'getThing', 'createThing', 'deleteThing'],
  handlers: {},
};
