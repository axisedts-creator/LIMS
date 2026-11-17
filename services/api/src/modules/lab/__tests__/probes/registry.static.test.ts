// C5 T-32 static probes (no database): contract <-> probe coverage tie, permission / idempotency table (02-TRD §7.1, contracts/permissions.yaml, 07 §5.1 P-10),
// S-09 route lint, S-12 event-schema key scan, S-18/S-19 source scans, and "every lab table is named by the table probes" (P-T).
// Self-contained on purpose: imports ./kit.ts only for OPS / permissions (kit loads without a database).
// LD-70 (2026-11-08): probes/pending.json is the writer's inventory, never a tester file; this suite does not read it.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../../../core/module.js';
import { handlers } from '../../handlers/index.js';
import { ALL_LAB_PERMS, LAB_PERMS, OPS, PRIVILEGED, LAB_TENANT_TABLES, fileText } from './kit.js';

const MOD = 'services/api/src/modules/lab';
const walk = (dir: string): string[] => readdirSync(join(REPO_ROOT, dir)).flatMap((f) => {
  const rel = `${dir}/${f}`; return statSync(join(REPO_ROOT, rel)).isDirectory() ? (f === '__tests__' ? [] : walk(rel)) : [rel];
});
const SRC = walk(MOD).filter((f) => f.endsWith('.ts'));

const EXPECT: Record<string, string> = {   // operationId -> x-permission (07 §5.1 P-10 = 03-IC §11 + CR-C5-004 + 08 A13 D-4)
  lookupSpecimenByBarcode: 'lab.specimen.read', listSpecimens: 'lab.specimen.read', getSpecimen: 'lab.specimen.read', collectSpecimen: 'lab.specimen.collect', bulkCollectSpecimens: 'lab.specimen.collect',
  bulkDispatchSpecimens: 'lab.specimen.collect', receiveSpecimen: 'lab.specimen.receive', bulkReceiveSpecimens: 'lab.specimen.receive', rejectSpecimen: 'lab.specimen.reject', requestRecollection: 'lab.specimen.reject',
  createAliquots: 'lab.specimen.receive', storeSpecimen: 'lab.specimen.receive', discardSpecimen: 'lab.specimen.receive', printSpecimenLabels: 'lab.specimen.label_print', requestOrderLabelPrint: 'lab.specimen.label_print',
  getLabOrder: 'lab.specimen.read', listOrderResults: 'lab.result.read', getStatusBoard: 'lab.status_board.read', listWorklistItems: 'lab.worklist.read', listPendingItems: 'lab.worklist.read',
  createWorksheet: 'lab.worksheet.manage', listWorksheets: 'lab.worklist.read', getWorksheet: 'lab.worklist.read', getResult: 'lab.result.read', bulkEnterResults: 'lab.result.enter', getResultHistory: 'lab.result.read',
  getAnalyteTrend: 'lab.result.read', verifyResult: 'lab.result.verify', bulkVerifyResults: 'lab.result.verify', returnResult: 'lab.result.verify', approveResult: 'lab.result.approve', bulkApproveResults: 'lab.result.approve',
  amendResult: 'lab.result.amend', listResultVersions: 'lab.result.read', listVerificationQueue: 'lab.result.read', listCriticalValues: 'lab.critical_value.read', getCriticalValue: 'lab.critical_value.read',
  logCriticalNotification: 'lab.critical_value.log_notification', listIngestExceptions: 'lab.result.read', getIngestException: 'lab.result.read', assignIngestException: 'lab.result.enter',
  reapplyIngestException: 'lab.result.enter', discardIngestException: 'lab.result.enter', listQcResults: 'lab.qc.capture', captureQcResult: 'lab.qc.capture', listQcHolds: 'lab.result.read',
  releaseQcHold: 'lab.qc_hold.release', getLabSettings: 'lab.worklist.read', updateLabSettings: 'lab.config.manage', listDeltaCheckRules: 'lab.result.read', createDeltaCheckRule: 'lab.config.manage',
  versionDeltaCheckRule: 'lab.config.manage', deactivateDeltaCheckRule: 'lab.config.manage', listLabCodedSet: 'lab.specimen.read', upsertLabCode: 'lab.config.manage',
};

describe('contract <-> probes', () => {
  it('the contract has exactly the 55 lab operations and the handler map has exactly those keys', () => {
    expect(OPS).toHaveLength(55);
    expect(OPS.map((o) => o.id).sort()).toEqual(Object.keys(EXPECT).sort());
    expect(Object.keys(handlers).sort()).toEqual(OPS.map((o) => o.id).sort());
  });
  it('every operation has a probe request in kit.ts (requestFor)', () => {
    const kit = fileText(`${MOD}/__tests__/probes/kit.ts`);
    for (const o of OPS) expect(kit, o.id).toContain(`case '${o.id}'`);
  });
  it('every tenant table of schema lab is named by the table probes (P-T), no more, no less', () => {
    const mig = fileText('db/migrations/20261105001800_lab__create_lab_schema.sql');
    const tenantTables = [...mig.matchAll(/CREATE TABLE lab\.([a-z_]+)/g)].map((m) => m[1]!).filter((t) => !t.startsWith('g_cs_'));
    expect([...LAB_TENANT_TABLES].sort()).toEqual([...tenantTables].sort());
    const probes = fileText(`${MOD}/__tests__/probes/tables.live.test.ts`);
    expect(probes).toContain('LAB_TENANT_TABLES');
  });
});

describe('permission + idempotency table (P-10, 02-TRD §7.1, contracts/permissions.yaml)', () => {
  it.each(OPS.map((o) => [o.id, o] as const))('%s asks for its contract permission, which exists in permissions.yaml', (_id, o) => {
    expect(o.permission).toBe(EXPECT[o.id]);
    expect(ALL_LAB_PERMS).toContain(o.permission);
  });
  it('privileged (aal2) lab permissions are exactly approve / amend / config.manage / qc_hold.release', () => {
    expect([...PRIVILEGED].sort()).toEqual(['lab.config.manage', 'lab.qc_hold.release', 'lab.result.amend', 'lab.result.approve']);
  });
  it('front_desk holds no result permission at all (abuse case 1)', () => {
    const fd = LAB_PERMS.filter((p) => p.roles.includes('front_desk')).map((p) => p.code);
    expect(fd.filter((c) => /^lab\.(result|critical_value|qc|config|worksheet|worklist)/.test(c))).toEqual([]);
  });
  it('every operation declared x-idempotency: required takes the Idempotency-Key header parameter (replay guard)', () => {
    for (const o of OPS.filter((x) => /required/i.test(x.idempotency))) expect(JSON.stringify(o.operation.parameters ?? []), o.id).toContain('IdempotencyKey');
  });
});

describe('S-09 route lint: no barcode / registration number in any lab path or query parameter', () => {
  it('paths and query names', () => {
    for (const o of OPS) {
      expect(o.path, o.id).not.toMatch(/barcode|registration_no/i);
      for (const q of o.queryParams) expect(q, `${o.id} ?${q}`).not.toMatch(/barcode|registration_no/i);
    }
  });
});

describe('S-12 producer schemas: no PHI-ish property in any lab event payload', () => {
  it('contracts/events/lab.*.schema.json define no barcode / value / comment key', () => {
    const files = readdirSync(join(REPO_ROOT, 'contracts/events')).filter((f) => /^lab\..*\.schema\.json$/.test(f));
    expect(files.length).toBeGreaterThanOrEqual(7);
    const keys = (v: unknown, out: Set<string> = new Set()): Set<string> => {
      if (Array.isArray(v)) v.forEach((x) => keys(x, out));
      else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'properties' && x && typeof x === 'object') Object.keys(x).forEach((p) => out.add(p)); keys(x, out); }
      return out;
    };
    for (const f of files) {
      const found = keys(JSON.parse(fileText(`contracts/events/${f}`)));
      for (const bad of ['barcode', 'value', 'value_numeric', 'value_text', 'comment', 'full_name', 'patient_name', 'rejection_comment']) expect(found.has(bad), `${f} has ${bad}`).toBe(false);
    }
  });
});

describe('source scans of the lab module (non-test code): S-18 / S-19', () => {
  it('no log call names a PHI field (barcode, value, comment, name, phone, note, req.body)', () => {
    const bad: string[] = [];
    for (const f of SRC) fileText(f).split('\n').forEach((l, i) => {
      if (/\blog\??\.(info|warn|error|debug)\(/.test(l) && /(barcode|value_raw|value_numeric|value_text|\bvalue\b|comment|full_name|patient_name|phone|\bnote\b|req\.body|\.body\b)/.test(l)) bad.push(`${f}:${i + 1}: ${l.trim().slice(0, 120)}`);
    });
    expect(bad).toEqual([]);
  });
  it('error construction never interpolates a barcode / value / comment into the message', () => {
    const bad: string[] = [];
    for (const f of SRC) fileText(f).split('\n').forEach((l, i) => {
      if (/new LimsError\(/.test(l) && /\$\{[^}]*(barcode|value|comment|full_name|reason_text)/i.test(l)) bad.push(`${f}:${i + 1}`);
    });
    expect(bad).toEqual([]);
  });
  it('no handler / service requests a signed storage URL (07 §5.1: files stay behind the API)', () => {
    expect(SRC.filter((f) => /signedUrl\s*\(/.test(fileText(f)))).toEqual([]);
  });
});
