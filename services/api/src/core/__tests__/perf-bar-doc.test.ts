// T0B-PERF-1 (LD-310) done_when 6: docs/ops/PRODUCTION-BAR.md states the bar with numbers and marks every item.
// Format expected: markdown table rows `| item | bar | status |`, status one of: "met", "met by this task", "needs a founder or hosting step".
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const FILE = join(import.meta.dirname, '..', '..', '..', '..', '..', 'docs', 'ops', 'PRODUCTION-BAR.md');
const text = existsSync(FILE) ? readFileSync(FILE, 'utf8') : '';
const rows = text.split('\n').filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s:|-]+\|\s*$/.test(l));
const STATUS = /\b(met by this task|needs a founder or hosting step|met)\b/i;

const ITEMS: Array<[string, RegExp]> = [
  ['p95 list reads', /p95.*list|list.*p95/i],
  ['p95 writes', /p95.*write|write.*p95/i],
  ['cold start', /cold start|always.?on|keep.?warm/i],
  ['daily backups and tested restore', /backup/i],
  ['audit trail on every write', /audit trail/i],
  ['row level tenant isolation', /row.?level|tenant isolation/i],
  ['rate limits on login and public endpoints', /rate limit/i],
  ['queue retries with dead letters', /dead.?letter/i],
  ['secrets only in environment', /secrets/i],
  ['TLS only', /\bTLS\b/],
  ['security headers', /security headers/i],
  ['dependency audit clean of high findings', /dependency audit/i],
  ['compression', /compress/i],
  ['Server-Timing and request log', /server-timing/i],
  ['query budget', /quer(y|ies).*(budget|4)|n\+1/i],
  ['statement timeout and pool', /statement timeout/i],
  ['readiness and graceful shutdown', /readiness|graceful/i],
];

describe('docs/ops/PRODUCTION-BAR.md', () => {
  it('exists and is not a stub', () => { expect(existsSync(FILE)).toBe(true); expect(text.length).toBeGreaterThan(1500); });

  it.each(ITEMS)('%s has a table row with a status', (_n, re) => {
    const row = rows.find((r) => re.test(r));
    expect(row, `no table row matches ${re}`).toBeDefined();
    expect(row!, 'row has no status').toMatch(STATUS);
  });

  it('states the numbers: 300 ms list reads, 800 ms writes, 5 s / 15 s statement timeouts, 1 KB compression threshold, 200 ms readiness', () => {
    for (const n of [/300\s*ms/, /800\s*ms/, /\b5\s*s\b|5000/, /\b15\s*s\b|15000/, /1\s*KB/i, /200\s*ms/]) expect(text).toMatch(n);
  });

  it('the money / hosting items are marked as a founder or hosting step, not as met', () => {
    for (const re of [/cold start|always.?on|keep.?warm/i, /backup/i]) {
      expect(rows.find((r) => re.test(r))!).toMatch(/needs a founder or hosting step/i);
    }
  });

  it('documents the env names that tune it, and holds no secret value', () => {
    for (const n of ['LIMS_CORE_STATEMENT_TIMEOUT_MS', 'LIMS_CORE_STATEMENT_TIMEOUT_WRITE_MS', 'LIMS_CORE_DB_POOL_MAX']) expect(text).toContain(n);
    expect(text).not.toMatch(/postgres(ql)?:\/\/[^\s/]+:[^\s@]+@/i);
  });
});
