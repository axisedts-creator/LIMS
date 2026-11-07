// C6-T10 — source-level guarantees (07-SECURITY T9, REQ-SEC-083/084/087; 02-TRD §5.2): untrusted PDFs never reach Chromium (AC-04.6), SQL is static
// and tenant-scoped, the service does not embed SQL, the task is registered in the worker manifest.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const SERVICE = join(here, '..', 'service', 'outsourced.service.ts');
const HANDLERS = join(here, '..', 'handlers', 'outsourced.handlers.ts');
const TASK = join(here, '..', '..', '..', '..', '..', 'worker', 'src', 'jobs', 'reporting', 'tasks', 'process_input_file.ts');
const read = (p: string) => readFileSync(p, 'utf8').replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('files exist', () => it.each([SERVICE, HANDLERS, TASK])('%s', (p) => expect(existsSync(p)).toBe(true)));

describe.each([['service', SERVICE], ['handlers', HANDLERS], ['task', TASK]])('%s source', (_n, p) => {
  const src = () => read(p);
  it('never touches the renderer / Chromium pool (outsourced bytes go to the sandbox only)', () => {
    expect(src()).not.toMatch(/renderer|chromium|playwright|puppeteer|render_report_version|\/internal\/render/i);
  });
  it('no dynamic SQL: no template interpolation or concatenation inside a string that names reporting.*', () => {
    expect(src()).not.toMatch(/`[^`]*\b(?:from|into|update|join)\s+reporting\.[^`]*\$\{/i);
    expect(src()).not.toMatch(/['"][^'"]*\b(?:from|into|update)\s+reporting\.[^'"]*['"]\s*\+/i);
  });
  it('does not log or label with the client filename / bytes', () => {
    expect(src()).not.toMatch(/(?:log|logger)\w*\.(?:info|warn|error|debug)\([^)]*(?:original_filename|originalFilename|\.bytes|filename)/);
  });
});

describe('layering', () => {
  it('service and handlers carry no inline SQL (T03 convention: repository/ owns SQL)', () => {
    for (const p of [SERVICE, HANDLERS]) expect(read(p)).not.toMatch(/\b(?:select\s[\s\S]{0,200}\sfrom|insert\s+into|update\s+\w+(?:\.\w+)?\s+set|delete\s+from)\b/i);
  });
  it('the service reaches storage only through ctx (no direct createStorage / raw clients)', () => {
    expect(read(SERVICE)).not.toMatch(/createStorage|createClient|fetch\(|node:fs|node:child_process/);
  });
  it('concurrent confirms: reassemble() row-locks the order item BEFORE counting confirmed files (READ COMMITTED stale-count race)', () => {
    const svc = read(SERVICE); const start = svc.indexOf('async function reassemble');
    expect(start).toBeGreaterThanOrEqual(0);
    const body = svc.slice(start, start + 800);
    const lock = body.indexOf('lockOrderItem('); const count = body.indexOf('confirmedFileIds(');
    expect(lock).toBeGreaterThanOrEqual(0); expect(count).toBeGreaterThan(lock);
    const repo = readFileSync(join(here, '..', 'repository', 'outsourced.repo.ts'), 'utf8');
    const fn = /export async function lockOrderItem[\s\S]*?\n\}/.exec(repo)?.[0] ?? '';
    expect(fn).toMatch(/FROM reporting\.report_order_items/i); expect(fn).toMatch(/tenant_id\s*=\s*\$1/); expect(fn).toMatch(/order_item_id\s*=\s*\$2/); expect(fn).toMatch(/FOR UPDATE/i);
  });
  it('the task never shells out (qpdf runs only inside the sandbox container)', () => {
    expect(read(TASK)).not.toMatch(/node:child_process|\bexec(?:Sync|File)?\(|\bspawn\(|\bqpdf\b/);
  });
});
