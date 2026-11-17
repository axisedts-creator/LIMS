// C5 T-01 — worker manifest CI check (06-IMPLEMENTATION-PLAN row T-01: "worker manifest subscriptions equal 02-TRD §7.2").
// Expects ../index.ts to `export const manifest: WorkerManifest` (module 'lab'; SEAM: export name `manifest`, like the API module).
// Subscriptions are compared with the §7.2 table parsed from the spec itself and with EVENT_CONSUMERS.lab.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EVENT_CONSUMERS } from '../../../../../../contracts/ports/generated/events.js';
import { isLimsError } from '../../../../../api/src/core/errors.js';
import { REPO_ROOT } from '../../../../../api/src/core/module.js';
import { validateManifests } from '../../../core/manifest.js';
import { manifest } from '../index.js';

/** Event types in the first column of the §7.2 "Consumed" table of 02-TRD. */
function trdConsumed(): string[] {
  const text = readFileSync(join(REPO_ROOT, 'spec', 'chunks', 'C5-lab-workflow', '02-TRD.md'), 'utf8');
  const start = text.indexOf('### 7.2 Consumed');
  const end = text.indexOf('\n## 8.', start);
  expect(start, '02-TRD §7.2 heading not found').toBeGreaterThan(-1);
  expect(end, '02-TRD §8 heading not found').toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/^\| `([a-z_]+(?:\.[a-z_]+)+\.v\d+)`/gm)].map((m) => m[1]!);
}

describe('T-01 worker manifest (lab)', () => {
  it('parses 9 consumed events from 02-TRD §7.2', () => {
    expect(trdConsumed()).toHaveLength(9);
  });

  it('is module lab and passes the build-time manifest checks', () => {
    expect(manifest.module).toBe('lab');
    expect(() => validateManifests([manifest])).not.toThrow();
  });

  it('subscriptions equal the 02-TRD §7.2 table and EVENT_CONSUMERS.lab (no extra, none missing)', () => {
    const subs = Object.keys(manifest.subscriptions ?? {}).sort();
    expect(subs).toEqual([...trdConsumed()].sort());
    expect(subs).toEqual([...(EVENT_CONSUMERS.lab ?? [])].sort());
  });

  // Each consumer task replaces its stub (06-IMPLEMENTATION-PLAN); add its event type here when it lands. T-06: the three frontdesk.order.* consumers
  // (behaviour: consumers.order.test.ts and service/__tests__/order.service.integration.test.ts). T-09: homecollection.collection.synced.v1
  // (consumers.homecollection.test.ts and service/__tests__/homecollection.consumer.integration.test.ts).
  // T-27: reporting.report.released.v1 (consumers.reportreleased.test.ts and service/__tests__/reportreleased.consumer.integration.test.ts).
  // T-22: instruments.result.received.v1 (consumers.instruments.test.ts and service/__tests__/ingest.service.test.ts).
  // T-23: catalog.changed.v1 (tasks.reapply.test.ts) enqueues lab.reapply_unmapped_exceptions for entity_type instrument_code_map.
  const IMPLEMENTED = new Set(['frontdesk.order.created.v1', 'frontdesk.order.items_changed.v1', 'frontdesk.order.cancelled.v1', 'homecollection.collection.synced.v1', 'reporting.report.released.v1', 'instruments.result.received.v1', 'catalog.changed.v1',
    'instruments.qc.received.v1', 'quality.qc_run.rejected.v1']);   // T-25: consumers.qc.test.ts and service/__tests__/qc.consumer.integration.test.ts

  it('every not-yet-implemented subscription handler is a stub that rejects with common.internal (no silent success, no 501)', async () => {
    const all = Object.entries(manifest.subscriptions ?? {});
    expect(all.length).toBe(9);
    const entries = all.filter(([type]) => !IMPLEMENTED.has(type));
    expect(entries.length).toBe(9 - IMPLEMENTED.size);
    for (const [type, handler] of entries) {
      expect(typeof handler, type).toBe('function');
      const err = await handler({ event_type: type }, {} as any).then(() => undefined, (e: unknown) => e);
      expect(isLimsError(err, 'common.internal'), `${type} must reject with LimsError common.internal`).toBe(true);
    }
  });

  it('declares only lab.* tasks and crontab entries that refer to declared tasks', () => {
    for (const id of Object.keys(manifest.tasks ?? {})) expect(id.startsWith('lab.')).toBe(true);
    for (const c of manifest.crontab ?? []) expect(Object.keys(manifest.tasks ?? {})).toContain(c.identifier);
  });
});
