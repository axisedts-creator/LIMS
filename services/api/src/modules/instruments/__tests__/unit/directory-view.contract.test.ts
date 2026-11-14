// C7 API-T16 — published view `instruments.v_pub_instrument_directory` column contract (08 4.9 / R12d, CR-C9-006 + CR-C12-005, 03-IC 6.5) and bucket name `instruments-attachments` (08 R26).
// Regression guard on the shipped DDL: exact columns, exact order, no extra internal column, security_invoker, grants. Live RLS behaviour of the view is db/tests (T0B-10), not here.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadInstrumentsConfig } from '../../config.js';

const root = (p: string) => new URL(`../../../../../../../${p}`, import.meta.url);
const read = (p: string) => readFileSync(root(p), 'utf8');
const COLUMNS = ['tenant_id', 'instrument_id', 'centre_id', 'instrument_code', 'display_name', 'vendor', 'model', 'state', 'is_active'];
const view = (sql: string) => { const m = /CREATE VIEW instruments\.v_pub_instrument_directory\b([\s\S]*?);/.exec(sql); expect(m, 'view DDL present').not.toBeNull(); return m![0]; };
const outCols = (ddl: string) => { const sel = /SELECT\s+([\s\S]*?)\s+FROM\b/i.exec(ddl)![1]!; return sel.split(',').map((c) => c.trim().replace(/^.*\bAS\s+/i, '').replace(/^\w+\./, '')); };

describe('v_pub_instrument_directory', () => {
  const MIGRATION = 'db/migrations/20261105002000_instruments__create_instruments_schema.sql';
  it('migration: exactly the 9 contract columns, in contract order', () => { expect(outCols(view(read(MIGRATION)))).toEqual(COLUMNS); });
  it('spec 05-SCHEMA 6 and the migration agree', () => { expect(outCols(view(read('spec/chunks/C7-instrument-integration/05-SCHEMA.md')))).toEqual(COLUMNS); });
  it('08 R12d and 03-IC 6.5 list the same columns', () => {
    expect(read('spec/program/08-CR-REGISTER.md')).toContain(`Columns: \`${COLUMNS.join(', ')}\``);
    expect(read('spec/program/03-INTERFACE-CATALOG.md')).toContain(`| \`instruments.v_pub_instrument_directory\` (added by 08, CR-C9-006 + CR-C12-005, R12d) | ${COLUMNS.join(', ')} |`);
  });
  it('reads only instruments.instruments, security_invoker (caller RLS applies), SELECT granted to lims_app + lims_analytics, nothing internal exposed', () => {
    const sql = read(MIGRATION), v = view(sql);
    expect(v).toMatch(/WITH \(security_invoker = true\)/); expect(v).toMatch(/FROM instruments\.instruments i;$/i);
    for (const internal of ['agent_id', 'driver_code', 'parser_options', 'qc_sample_id_patterns', 'link_settings', 'timezone']) expect(outCols(v)).not.toContain(internal);
    expect(sql).toMatch(/GRANT SELECT ON [^;]*instruments\.v_pub_instrument_directory[^;]* TO lims_app, lims_analytics;/);
  });
});

describe('attachment bucket (08 R26 / CR-C7-007)', () => {
  it('default is instruments-attachments; the schema CHECK pins the same name', () => {
    expect(loadInstrumentsConfig({}).attachmentBucket).toBe('instruments-attachments');
    expect(read('db/migrations/20261105002000_instruments__create_instruments_schema.sql')).toContain("CONSTRAINT attachments__bucket__ck CHECK (bucket = 'instruments-attachments')");
  });
});
