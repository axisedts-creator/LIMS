// T0B-REGAPI-1 (LD-310) — facts that need no DB: no new permission code, the repository knows the 13 columns, nothing logs the sensitive fields.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { FRONTDESK_PERMISSIONS } from '../../permissions.js';

const MOD = join(REPO_ROOT, 'services/api/src/modules/frontdesk');
const src = (rel: string) => readFileSync(join(MOD, rel), 'utf8');
const NEW_COLS = ['title', 'external_patient_id', 'nationality', 'government_id_type', 'government_id_number', 'address_province', 'address_district', 'address_municipality',
  'address_ward', 'address_tole', 'address_postal_code', 'profile_photo_attachment_id', 'custom_fields'];

describe('(5) authorization uses the existing permissions only', () => {
  it('FRONTDESK_PERMISSIONS is exactly the ten codes that existed before this task', () => {
    expect(Object.values(FRONTDESK_PERMISSIONS).sort()).toEqual(['frontdesk.discount.apply', 'frontdesk.discount.approve', 'frontdesk.order.cancel', 'frontdesk.order.edit',
      'frontdesk.order.read', 'frontdesk.patient.anonymise', 'frontdesk.patient.read', 'frontdesk.registration.create', 'frontdesk.settings.manage', 'frontdesk.trf.upload']);
  });
  it('contracts/permissions.yaml has no frontdesk code for registration fields, ids or photos', () => {
    const y = readFileSync(join(REPO_ROOT, 'contracts/permissions.yaml'), 'utf8');
    const codes = [...y.matchAll(/frontdesk\.[a-z_.]+/g)].map((m) => m[0]);
    expect(codes.filter((c) => /government|sensitive|photo|external|custom/.test(c))).toEqual([]);
  });
});

describe('(2) repository and logging discipline', () => {
  it('patients.repo.ts reads and writes all 13 new columns (insert COLS and update list)', () => {
    const r = src('repository/patients.repo.ts');
    for (const c of NEW_COLS) expect(r.match(new RegExp(`['"\`]${c}['"\`]`, 'g'))?.length ?? 0, c).toBeGreaterThanOrEqual(2);
  });
  it('no non-test frontdesk source passes a government id or structured address value to a logger or console', () => {
    const files: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(join(MOD, d), { withFileTypes: true })) { const p = `${d}/${e.name}`; if (e.isDirectory()) { if (e.name !== '__tests__') walk(p); } else if (/\.ts$/.test(e.name)) files.push(p); } };
    for (const d of ['handlers', 'service', 'repository', 'mappers', 'domain']) walk(d);
    for (const f of files) {
      for (const line of src(f).split('\n')) {
        if (/\b(log|logger|console)\s*\.\s*(info|warn|error|debug|trace|log)\b/.test(line)) expect(line, f).not.toMatch(/government_id|governmentId|address_(province|district|municipality|ward|tole|postal)/);
      }
    }
  });
  it('the mapper never puts a new field into patientSummaryDto (search / candidates stay closed)', () => {
    const m = src('mappers/patient.dto.ts');
    const body = /export function patientSummaryDto[^]*?\r?\n}\r?\n/.exec(m)?.[0] ?? '';
    expect(body.length).toBeGreaterThan(0);
    for (const c of NEW_COLS) expect(body, c).not.toContain(c);
  });
});
