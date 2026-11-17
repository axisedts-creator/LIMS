// Fixture module for the T0D-04 error-contract tests: every handler fails in a different way.
import { mapDbError } from '../../../../../db/sqlstate.js';
import { LimsError } from '../../../../../errors.js';

const LEAKY = 'relation "core.patients" does not exist: SELECT * FROM core.patients WHERE name = $1 at /srv/lims/api/dist/db.js:12:3';

function weird(kind: string): never {
  switch (kind) {
    case 'string': throw LEAKY;
    case 'null': throw null;
    case 'undefined': throw undefined;
    case 'number': throw 42;
    case 'status200': throw Object.assign(new Error(LEAKY), { statusCode: 200 });
    case 'status302': throw Object.assign(new Error(LEAKY), { statusCode: 302 });
    case 'teapot': throw Object.assign(new Error(LEAKY), { statusCode: 418 });
    case 'unregistered': throw new LimsError('zzz.not_registered');
    case 'leaky500': throw Object.assign(new Error(LEAKY), { stack: `Error: ${LEAKY}\n    at Object.<anonymous> (/srv/lims/api/dist/db.js:12:3)` });
    default: throw new Error(`unknown weird kind ${kind}`);
  }
}

export const manifest = {
  name: 'catalog',
  openapi: 'contracts/openapi/catalog.yaml',
  produces: ['catalog.changed.v1'],
  handlers: {
    boom: async () => { throw new Error(LEAKY); },
    limsError: async (req: any) => { throw new LimsError(req.params.code); },
    withDetail: async () => { throw new LimsError('common.not_found', 'Specimen not found'); },
    rateLimited: async () => { throw Object.assign(new LimsError('common.rate_limited'), { retryAfterSeconds: 7 }); },
    validateBody: async () => ({ status: 200, body: {} }),
    queryParam: async () => ({ status: 200, body: {} }),
    fieldErrors: async () => {
      throw new LimsError('common.validation_failed', 'Request validation failed', [
        { path: '/reason_code', code: 'common.field_required', message: 'reason_code is required' },
      ]);
    },
    rawDb: async () => { throw Object.assign(new Error('insert or update on table "orders" violates foreign key constraint "fk_orders_patient"'), { code: '23503', constraint: 'fk_orders_patient', table: 'orders', detail: 'Key (patient_id)=(synthetic) is not present in table "patients".' }); },
    mappedDb: async (req: any) => { throw mapDbError(Object.assign(new Error(LEAKY), { code: req.params.sqlstate, constraint: 'fk_secret' })); },
    weird: async (req: any) => weird(req.params.kind),
    echo: async () => ({ status: 200, body: {} }),
    declared: async () => { throw new LimsError('common.not_found'); },
  },
};
