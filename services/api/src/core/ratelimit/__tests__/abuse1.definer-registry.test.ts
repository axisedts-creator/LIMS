// SEC-ABUSE-1 (LD-410 item 4, review round 4 item 1): the two new DEFINERs must be in the generated
// db/tests/isolation/_registry.sql (T0B-08_inventory.test.sql set_eq against pg_proc is pgTAP, NOT run in the lane).
// Static read only. Fails until `node db/tools/gen-isolation-probes.ts` is run and committed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const registry = () => readFileSync(`${ROOT}db/tests/isolation/_registry.sql`, 'utf8');

describe('_registry.sql lists the LD-410 rate-limit DEFINERs (owner lims_owner, EXECUTE lims_api only)', () => {
  for (const fn of ['app.ratelimit_peek', 'app.ratelimit_clear']) {
    it(`${fn}: exactly one row, lims_owner, execute [lims_api] only, no touches, no policies`, () => {
      const rows = registry().split('\n').filter((l) => l.includes(`('${fn}'`));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.replace(/\s+/g, ' ').trim()).toBe(
        `('${fn}', 'lims_owner', ARRAY['lims_api']::text[], ARRAY[]::text[], ARRAY[]::text[]),`,
      );
    });
  }
  it('app.ratelimit_hit row is untouched (lims_api + lims_worker)', () => {
    const rows = registry().split('\n').filter((l) => l.includes("('app.ratelimit_hit'"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("ARRAY['lims_api', 'lims_worker']::text[]");
  });
});
