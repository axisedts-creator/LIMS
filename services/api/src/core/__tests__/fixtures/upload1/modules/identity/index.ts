export const manifest = {
  name: 'identity',
  openapi: 'contracts/openapi/identity.yaml',
  produces: [],
  handlers: {
    getIdentityProbe: async () => ({ status: 200, body: { ok: true } }),
  },
};
