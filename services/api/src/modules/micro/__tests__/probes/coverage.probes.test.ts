// C10 T-25 — "every 07-SECURITY §5 test present" (plan row T-25 done_when). Maps S-01…S-30 to the test file(s) that carry them and fails when an id or its file is missing.
// Probes added by T-25 live in this directory; the rest were written with their task (T-05…T-18) and are referenced, not duplicated.
// The map is deliberately explicit: a renamed/removed test file or an id no longer mentioned in it fails here.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const MODULE = join(__dirname, '..', '..');
const H = 'handlers/__tests__/', S = 'service/__tests__/', P = '__tests__/probes/';
const MAP: Record<string, string[]> = {
  'S-01': [`${H}culture.reads.integration.test.ts`, `${H}isolate.writes.integration.test.ts`, `${H}ast.writes.integration.test.ts`, `${H}breakpoint.handlers.test.ts`],
  'S-02': [`${H}culture.reads.integration.test.ts`, `${H}culture.setup.integration.test.ts`],
  'S-03': [`${H}culture.setup.integration.test.ts`, `${H}isolate.writes.integration.test.ts`, `${H}ast.writes.test.ts`],
  'S-04': [`${P}rls.probes.test.ts`, `${H}culture.setup.integration.test.ts`],
  'S-05': [`${P}spec.probes.test.ts`, `${H}culture.setup.test.ts`, `${H}ast.writes.test.ts`],
  'S-06': [`${H}report.submit.test.ts`, `${H}report.submit.integration.test.ts`],
  'S-07': [`${H}report.submit.test.ts`],
  'S-08': [`${P}rls.probes.test.ts`, `${H}isolate.writes.integration.test.ts`],
  'S-09': [`${H}ast.writes.test.ts`],
  'S-10': [`${P}spec.probes.test.ts`, `${H}breakpoint.handlers.test.ts`, `${H}breakpoint.lifecycle.test.ts`],
  'S-11': [`${H}breakpoint.lifecycle.test.ts`],
  'S-12': [`${H}breakpoint.handlers.test.ts`],
  'S-13': [`${H}breakpoint.handlers.test.ts`],
  'S-14': [`${P}ci-grep.probes.test.ts`],
  'S-15': [`${H}breakpoint.handlers.test.ts`],
  'S-16': [`${P}spec.probes.test.ts`],
  'S-17': [`${P}rls.probes.test.ts`],
  'S-18': [`${S}culture.consumer.integration.test.ts`],
  'S-19': [`${S}culture.consumer.test.ts`, `${S}culture.consumer.integration.test.ts`],
  'S-20': [`${P}log-scan.probes.test.ts`, `${P}rls.probes.test.ts`],
  'S-21': [`${P}spec.probes.test.ts`],
  'S-22': [`${P}spec.probes.test.ts`],
  'S-23': [`${H}config.handlers.test.ts`, `${P}spec.probes.test.ts`],
  'S-24': [`${H}config.handlers.test.ts`, `${P}spec.probes.test.ts`],
  'S-25': [`${H}culture.reads.test.ts`, `${P}spec.probes.test.ts`],
  'S-26': [`${P}rls.probes.test.ts`],
  'S-27': ['__tests__/contract/v_pub_report_content.test.ts'],
  'S-28': [`${P}rls.probes.test.ts`, '__tests__/contract/v_pub_report_content.test.ts'],
  'S-29': [`${H}isolate.writes.integration.test.ts`, `${P}rls.probes.test.ts`],
  'S-30': [`${H}culture.reopen-cancel.test.ts`],
};

describe('07-SECURITY §5 coverage map', () => {
  it('lists exactly S-01 … S-30', () => {
    expect(Object.keys(MAP)).toEqual(Array.from({ length: 30 }, (_, i) => `S-${String(i + 1).padStart(2, '0')}`));
  });

  it.each(Object.entries(MAP))('%s is carried by every mapped test file', (id, files) => {
    for (const f of files) {
      const p = join(MODULE, f);
      expect(existsSync(p), `${f} exists`).toBe(true);
      expect(readFileSync(p, 'utf8'), `${f} mentions ${id}`).toMatch(new RegExp(`\\b${id}\\b`));
    }
  });
});
