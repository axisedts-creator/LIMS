// T0B-MISREPORTS-1 done_when (3) "exports stream through the existing export path and never hold the whole result in memory; the row cap returns the standard validation error".
// No database. Pinned seams (kit.ts header): export/CsvWriter.ts writeCsvStream(table:{meta,columns}, chunks) and export/XlsxWriter.ts writeXlsxStream(...) take an
// AsyncIterable of row chunks and return an AsyncIterable<Uint8Array>; the bytes / cells equal writeCsv / writeXlsx of the same rows; the source is pulled lazily.
// The worker task analytics.build_export reads the new reports through streamMisReport (wiring check below); the old reports keep buildReport.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { readXlsx } from '../../export/__tests__/xlsxRead.js';
import { NEW_CODES } from './contract.js';

const META = {
  tenantDisplayName: 'Test Lab Pvt Ltd', reportTitle: 'Bill of the Day', periodLabelAd: '2020-06-01 to 2020-06-30', periodLabelBs: '2077-02-19 to 2077-03-17 B.S.',
  scopeLabel: 'All centres', generatedAtLocal: '2026-11-17 11:45', exportId: '01900002-0000-7000-8000-0000000000aa', exportedBy: 'Test User', freshnessNote: 'Data as of 2026-11-17 11:40',
};
const COLUMNS = [
  { key: 'invoice_number', label: 'Invoice number', kind: 'text' }, { key: 'orders', label: 'Orders', kind: 'count' }, { key: 'net_paisa', label: 'Net', kind: 'paisa' }, { key: 'rate_bp', label: 'Rate', kind: 'bp' },
] as const;
const row = (i: number) => ({ invoice_number: i % 17 === 0 ? '=HYPERLINK("http://x","click")' : `INV-${i}`, orders: i % 3, net_paisa: i % 5 === 0 ? -740 : 100_000 + i, rate_bp: 2500 });
const mk = (n: number, size: number) => Array.from({ length: Math.ceil(n / size) }, (_, c) => Array.from({ length: Math.min(size, n - c * size) }, (_, k) => row(c * size + k)));
function source(chunks: object[][], o: { failAt?: number } = {}) {
  const state = { pulled: 0, done: false };
  const it = (async function* () { for (const [i, c] of chunks.entries()) { if (o.failAt === i) throw new Error('synthetic source failure'); state.pulled++; yield c as never; } state.done = true; })();
  return { it, state };
}
const drain = async (it: AsyncIterable<Uint8Array>) => { const out: Uint8Array[] = []; for await (const b of it) out.push(b); return out; };
const cat = (bs: Uint8Array[]) => new Uint8Array(Buffer.concat(bs));
const load = async () => ({ csv: (await import('../../export/CsvWriter.js')) as any, xlsx: (await import('../../export/XlsxWriter.js')) as any });

describe('writeCsvStream', () => {
  it.each([0, 1, 7, 120, 1000])('%i rows: the concatenated bytes equal writeCsv of the same table (header block, NPR columns, neutralised text, negative numbers bare)', async (n) => {
    const { csv } = await load(); const chunks = mk(n, 50); const rows = chunks.flat();
    const streamed = cat(await drain(csv.writeCsvStream({ meta: META, columns: [...COLUMNS] }, source(chunks).it)));
    expect(Buffer.from(streamed).equals(Buffer.from(csv.writeCsv({ meta: META, columns: [...COLUMNS], rows })))).toBe(true);
  });
  it('an empty result still produces the header block and the label row (the empty range of every report)', async () => {
    const { csv } = await load();
    const text = Buffer.from(cat(await drain(csv.writeCsvStream({ meta: META, columns: [...COLUMNS] }, source([]).it)))).toString('utf8');
    expect(text).toContain('Invoice number'); expect(text).toContain('# Tenant: Test Lab Pvt Ltd'); expect(text.split('\r\n').filter((l) => !l.startsWith('#') && l.trim()).length).toBe(1);
  });
  it('lazy: the first bytes are produced before the source is exhausted, the source is never read ahead by more than a chunk or two, and every chunk is consumed exactly once', async () => {
    const { csv } = await load(); const src = source(mk(5000, 100)); // 50 source chunks
    const out = csv.writeCsvStream({ meta: META, columns: [...COLUMNS] }, src.it)[Symbol.asyncIterator]();
    const first = await out.next();
    expect(first.done).toBe(false); expect(first.value.length).toBeGreaterThan(0);
    expect(src.state.pulled, 'only the head of the source was read for the first output chunk').toBeLessThanOrEqual(3);
    let n = 1; for (let r = await out.next(); !r.done; r = await out.next()) n++;
    expect(src.state.pulled).toBe(50); expect(src.state.done).toBe(true); expect(n, 'many output chunks, not one buffer').toBeGreaterThan(1);
  });
  it('a failing source rejects the stream and the writer stops reading', async () => {
    const { csv } = await load(); const src = source(mk(500, 100), { failAt: 2 });
    await expect(drain(csv.writeCsvStream({ meta: META, columns: [...COLUMNS] }, src.it))).rejects.toThrow('synthetic source failure');
    expect(src.state.pulled).toBe(2);
  });
  it('a non integer in a numeric column never reaches a file (RangeError), as in writeCsv', async () => {
    const { csv } = await load();
    await expect(drain(csv.writeCsvStream({ meta: META, columns: [...COLUMNS] }, source([[{ invoice_number: 'x', orders: 1.5, net_paisa: 1, rate_bp: 1 }]]).it))).rejects.toThrow(RangeError);
  });
});

describe('writeXlsxStream', () => {
  it.each([0, 1, 120, 1000])('%i rows: the workbook reads back with the same sheets and cells as writeXlsx of the same table', async (n) => {
    const { xlsx } = await load(); const chunks = mk(n, 50); const rows = chunks.flat();
    const streamed = readXlsx(cat(await drain(xlsx.writeXlsxStream({ meta: META, columns: [...COLUMNS] }, source(chunks).it))));
    const whole = readXlsx(await xlsx.writeXlsx({ meta: META, columns: [...COLUMNS], rows }));
    expect(streamed).toEqual(whole);
    expect(Object.keys(streamed)).toEqual(expect.arrayContaining(['Report', 'About']));
  });
  it('reads the source chunk by chunk (every chunk once, in order) and rejects when the source fails', async () => {
    const { xlsx } = await load(); const src = source(mk(300, 100));
    await drain(xlsx.writeXlsxStream({ meta: META, columns: [...COLUMNS] }, src.it));
    expect(src.state.pulled).toBe(3);
    await expect(drain(xlsx.writeXlsxStream({ meta: META, columns: [...COLUMNS] }, source(mk(300, 100), { failAt: 1 }).it))).rejects.toThrow('synthetic source failure');
  });
});

describe('wiring of the export path', () => {
  const text = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
  it('the worker task builds the new reports from streamMisReport and the streaming writers; the old reports still use buildReport', () => {
    const t = text('services/worker/src/jobs/analytics/tasks/build_export.ts');
    expect(t).toMatch(/streamMisReport/); expect(t).toMatch(/writeCsvStream/); expect(t).toMatch(/writeXlsxStream/); expect(t).toMatch(/buildReport/);
  });
  it('every new report is exportable and schedulable in the registry the worker reads', async () => {
    const { getReport } = await import('../../domain/reportRegistry.js');
    for (const c of NEW_CODES) { expect(getReport(c).exportable).toBe(true); expect(getReport(c).schedulable).toBe(true); }
  });
});
