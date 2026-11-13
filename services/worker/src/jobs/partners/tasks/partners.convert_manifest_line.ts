// C13 T10 — task partners.convert_manifest_line (02-TRD §8.1, 10 attempts). Thin wrapper: the logic lives in the partners module service.
// The worker JobContext's db.tx reuses the job transaction (core/consumer.ts: no SAVEPOINT), so the wrapper supplies a real savepoint
// around the FrontdeskPort call (02-TRD §8.1, 03-APP-FLOW §4.2 step 5, 08 A19 P-44; precedent smartreport/tasks/prebuild_summary.ts).
import { convertLine, type ConversionCtx } from '../../../../../api/src/modules/partners/service/conversion.service.js';
import type { TaskHandler } from '../../../core/manifest.js';

export const convertManifestLine: TaskHandler = (payload, jobCtx) => {
  const ctx = jobCtx as unknown as ConversionCtx;
  let n = 0;
  // Nest the SQL savepoint inside the JobContext's own db.tx so any savepoint/ctx it provides is kept.
  const db = {
    tx<T>(fn: (c: any) => Promise<T>): Promise<T> {
      return ctx.db.tx(async (c: any) => {
        const q = (c?.tx ?? ctx.tx) as ConversionCtx['tx'];
        const name = 'p_conv_' + String(++n);
        await q.query('SAVEPOINT ' + name);
        try {
          const r = await fn(c ?? ctx);
          await q.query('RELEASE SAVEPOINT ' + name);
          return r;
        } catch (e) {
          await q.query('ROLLBACK TO SAVEPOINT ' + name);
          await q.query('RELEASE SAVEPOINT ' + name);
          throw e;
        }
      });
    },
  };
  return convertLine(payload, Object.assign(Object.create(ctx), { db }) as ConversionCtx);
};
