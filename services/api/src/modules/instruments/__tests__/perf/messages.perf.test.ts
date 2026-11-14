// C7 API-T15 — E33 listInstrumentMessages at 1x and 10x (02-TRD §12.2: "Message list (31-day window) p95 <= 400 ms per page of 50"). Harness limits: see perf.helpers.ts header.
// Volumes: 3,000 msgs/day per lab (TRD §12.1) x 31 days. 1x = 1 lab (93,000 msgs); 10x = 10 labs' worth in the tenant (930,000 msgs). Rows are generated on demand by index (never materialised).
import { describe, expect, it } from 'vitest';
import { createMessagesService } from '../../service/messages.service.js';
import { DAY, NOW, makeCtx, summaryRow, type MessagesRepo, type Row } from '../messages.helpers.js';
import { p95 } from './perf.helpers.js';

const PER_DAY = 3_000, DAYS = 31, PAGE = 50, CALLS = 20;
const TO = NOW, FROM = new Date(Date.parse(NOW) - DAYS * DAY).toISOString();

/** newest-first keyset-by-offset repo over `total` virtual rows inside the window; cursor = opaque offset. Honours limit/cursor/window like the real SQL must. */
function pagedRepo(total: number): MessagesRepo {
  const gap = DAY / (total / DAYS);
  const row = (k: number): Row => summaryRow(k, { received_at: new Date(Date.parse(TO) - k * gap).toISOString() });
  return {
    listMessages: async (_tx, _t, q) => {
      const off = q.cursor ? Number(q.cursor) : 0, end = Math.min(off + q.limit, total);
      return { rows: Array.from({ length: end - off }, (_v, i) => row(off + i)), ...(end < total ? { nextCursor: String(end) } : {}) };
    },
  } as MessagesRepo;
}

describe('TRD §12.2 — E33 message list, 31-day window, page of 50: p95 <= 400 ms', () => {
  for (const [name, labs] of [['1x', 1], ['10x', 10]] as const) {
    it(`${name} (${labs} lab(s) x ${PER_DAY}/day x ${DAYS} days = ${labs * PER_DAY * DAYS} msgs): first page + ${CALLS - 1} cursor pages, no errors, 50 items each, p95 <= 400 ms`, async () => {
      const svc: any = createMessagesService({ repo: pagedRepo(labs * PER_DAY * DAYS) }), { ctx } = makeCtx();
      const list = (cursor?: string) => svc.listInstrumentMessages(ctx, { receivedAtFrom: FROM, receivedAtTo: TO, limit: PAGE, ...(cursor ? { cursor } : {}) });
      await list();                                   // warm-up (JIT / lazy init must not count against p95)
      const times: number[] = [], errors: unknown[] = [], seen = new Set<string>(); let cursor: string | undefined;
      for (let i = 0; i < CALLS; i++) {
        const t0 = performance.now();
        try {
          const r = await list(cursor); times.push(performance.now() - t0);
          expect(r.status).toBe(200); expect(r.body.data).toHaveLength(PAGE);
          for (const d of r.body.data) { expect(seen.has(d.id), 'page overlap').toBe(false); seen.add(d.id); }
          cursor = r.body.page.next_cursor; expect(cursor, 'more pages remain').toBeTypeOf('string');
        } catch (e) { errors.push(e); break; }
      }
      expect(errors).toEqual([]); expect(times).toHaveLength(CALLS); expect(seen.size).toBe(CALLS * PAGE);
      expect(p95(times)).toBeLessThanOrEqual(400);
    }, 60_000);
  }
});
