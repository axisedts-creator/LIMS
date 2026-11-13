// C14 T03 repository emulators + world state (not a test file). Loaded by vi.mock factories, so it must NOT import the handlers.
// Emulators follow the T02 repository SEAMS: tenant filter from rc.tenantId, insert rejects tenant_id/created_by/updated_by/version in the row,
// optimistic update -> common.version_conflict | common.not_found, list = active rows only. Synthetic data only.
import { vi } from 'vitest';
import { TENANTS, actorIdFor, idFor } from '../../../../../../../packages/fakes/src/base';
import { LimsError } from '../../../../core/errors.js';

export const TA = TENANTS.A;
export const TB = TENANTS.B;
export const SEED = 1;
export const id = (n: number) => idFor(SEED, 0x7300 + n);
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Row = Record<string, any>;
export const world = {
  tenantTerms: [] as Row[],
  globalTerms: [] as Row[],
  rejectReasons: [] as Row[],
  organGroups: [] as Row[],
  calls: [] as { fn: string; tenantId?: string; args: unknown[] }[],
};
export const callsOf = (...fns: string[]) => world.calls.filter((c) => fns.includes(c.fn));
export const repoCalls = () => world.calls.length;

const STAMP = '2026-11-01T00:00:00.000Z';
const tenantTerm = (n: number, tenantId: string, term: string, o: Row = {}): Row => ({
  id: id(n), tenant_id: tenantId, term, term_folded: term.normalize('NFC').toLocaleLowerCase('und'), language: 'en', reason: null, is_active: true, version: 1,
  created_at: STAMP, created_by: actorIdFor('A', 'user', 'pathologist'), updated_at: STAMP, updated_by: actorIdFor('A', 'user', 'pathologist'), ...o,
});
const globalTerm = (t: string, language = 'en'): Row => ({ term_folded: t, term: t, language, reason: 'global wording rule (04 R8)', is_active: true, created_at: STAMP });
const codeRow = (code: string, display: string, sort_order: number, o: Row = {}): Row => ({ code, display, system: 'lims', system_version: '1', sort_order, is_active: true, created_at: STAMP, ...o });

export const IDS = { aActive: id(1), aInactive: id(2), bActive: id(3), aOther: id(4) };

export function seed(): void {
  world.calls = [];
  world.tenantTerms = [
    tenantTerm(1, TA, 'guaranteed cure', { reason: 'Synthetic wording rule', version: 1 }),
    tenantTerm(2, TA, 'old term', { is_active: false, version: 3 }),
    tenantTerm(3, TB, 'b-only-term'),
    tenantTerm(4, TA, 'zeta term', { language: 'ne' }),
  ];
  world.globalTerms = ['diagnos', 'cure', 'guarantee', 'supplement', 'prescri'].map((t) => globalTerm(t)).concat([globalTerm('http', 'any'), globalTerm('www.', 'any')]);
  world.rejectReasons = [
    codeRow('other', 'Other', 90), codeRow('wording_problem', 'Wording not appropriate', 10), codeRow('library_error', 'Library rule or text error', 20),
    codeRow('not_appropriate_for_patient', 'Not appropriate for this patient', 30), codeRow('results_under_review', 'Results under review', 40),
    codeRow('retired_reason', 'Retired', 5, { is_active: false }),
  ];
  const og: [string, string, number][] = [['blood_counts', 'Blood counts', 10], ['glucose', 'Blood sugar', 20], ['lipids', 'Cholesterol and lipids', 30], ['liver', 'Liver', 40],
    ['kidney', 'Kidney', 50], ['electrolytes', 'Electrolytes', 60], ['thyroid', 'Thyroid', 70], ['iron', 'Iron studies', 80], ['vitamins', 'Vitamins', 90],
    ['inflammation', 'Inflammation', 100], ['hormones', 'Hormones', 110], ['immunology', 'Immunology and serology', 120], ['urine', 'Urine examination', 130],
    ['stool', 'Stool examination', 140], ['vitals', 'Body measurements', 150], ['other', 'Other', 900]];
  world.organGroups = [codeRow('retired_group', 'Retired', 1, { is_active: false }), ...og.reverse().map(([c, d, s]) => codeRow(c, d, s))];
}

interface Rc { tenantId: string; actorId: string }
const note = (fn: string, rc: Rc | undefined, ...args: unknown[]) => world.calls.push({ fn, ...(rc ? { tenantId: rc.tenantId } : {}), args });
const INSERTABLE = ['id', 'term', 'term_folded', 'language', 'reason', 'is_active'];
let seq = 100;

export const denyTermsRepoFake = {
  insertDenyTerm: vi.fn(async (rc: Rc, row: Row) => {
    note('insertDenyTerm', rc, row);
    const bad = Object.keys(row).filter((k) => !INSERTABLE.includes(k));
    if (bad.length) throw new Error(`repo: row carries column(s) not allowed: ${bad.join(', ')}`);
    const r = { ...tenantTerm(0, rc.tenantId, row.term, { id: row.id ?? id(seq++), term_folded: row.term_folded, language: row.language, reason: row.reason ?? null, is_active: row.is_active ?? true }), created_by: rc.actorId, updated_by: rc.actorId };
    world.tenantTerms.push(r);
    return { ...r };
  }),
  getDenyTerm: vi.fn(async (rc: Rc, termId: string) => {
    note('getDenyTerm', rc, termId);
    const r = world.tenantTerms.find((t) => t.tenant_id === rc.tenantId && t.id === termId);
    return r ? { ...r } : null;
  }),
  updateDenyTerm: vi.fn(async (rc: Rc, termId: string, expectedVersion: number, patch: Row) => {
    note('updateDenyTerm', rc, termId, expectedVersion, patch);
    const r = world.tenantTerms.find((t) => t.tenant_id === rc.tenantId && t.id === termId);
    if (!r) throw new LimsError('common.not_found');
    if (r.version !== expectedVersion) throw new LimsError('common.version_conflict');
    Object.assign(r, patch, { version: r.version + 1, updated_by: rc.actorId });
    return { ...r };
  }),
  listDenyTerms: vi.fn(async (rc: Rc, o?: { includeInactive?: boolean }) => {
    note('listDenyTerms', rc, o);
    return world.tenantTerms.filter((t) => t.tenant_id === rc.tenantId && (o?.includeInactive === true || t.is_active))
      .sort((a, b) => a.term_folded.localeCompare(b.term_folded) || a.language.localeCompare(b.language)).map((r) => ({ ...r }));
  }),
  listGlobalDenyTerms: vi.fn(async (rc: Rc) => {
    note('listGlobalDenyTerms', rc);
    return world.globalTerms.filter((t) => t.is_active).sort((a, b) => a.term_folded.localeCompare(b.term_folded)).map((r) => ({ ...r }));
  }),
};

export const codedSetsRepoFake = {
  listOrganGroups: vi.fn(async (rc: Rc) => {
    note('listOrganGroups', rc);
    return world.organGroups.filter((r) => r.is_active).sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code)).map((r) => ({ ...r }));
  }),
  listRejectReasons: vi.fn(async (rc: Rc) => {
    note('listRejectReasons', rc);
    return world.rejectReasons.filter((r) => r.is_active).sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code)).map((r) => ({ ...r }));
  }),
};
