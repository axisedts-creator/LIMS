// HC-T12 static guards (no DB). Files of this task: sync.service.ts, conflict.service.ts, events/publish.ts (+ handlers/pushSyncMutations.ts wiring A3 into the manifest, as HC-T11 did for A2/A4).
// Guards: repository seam (SQL only in repository/*.repo.ts), review #14 order SELECT -> guard -> INSERT, sync_batches inserted LAST (the table is append-only), mutations never UPDATEd/DELETEd, JCS + SHA-256 payload hash,
// events through the typed publisher, names verbatim, no PHI / barcode / payload in logs (07-SECURITY §6). Fails now: the files do not exist (A3 is an HC-T01 stub).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
const F = { sync: join(ROOT, 'sync.service.ts'), conflict: join(ROOT, 'conflict.service.ts'), publish: join(ROOT, 'events', 'publish.ts'), handler: join(ROOT, 'handlers', 'pushSyncMutations.ts') };
const own = (): string[] => Object.values(F).filter(existsSync);
const all = (): string => own().map(code).join('\n');
const pos = (t: string, re: RegExp): number => t.search(re);

describe('HC-T12 files', () => {
  it('sync.service.ts, conflict.service.ts, events/publish.ts and handlers/pushSyncMutations.ts exist', () => {
    for (const [k, f] of Object.entries(F)) expect(existsSync(f), `${k}: ${f} missing (HC-T12 not implemented yet)`).toBe(true);
  });
  it('the module manifest wires the real A3 handler (no 501 stub left for pushSyncMutations)', () => {
    expect(code(join(ROOT, 'index.ts')), 'index.ts does not import handlers/pushSyncMutations.js').toMatch(/handlers\/pushSyncMutations\.js/);
  });
});

describe('HC-T12 source rules', () => {
  it('SQL stays in the repositories: no .query(, no RLS bypass, no pg import, no console', () => {
    expect(own().length).toBeGreaterThan(0);
    for (const f of own()) {
      const t = code(f);
      expect(/\.query\s*\(/.test(t), `${f}: raw query`).toBe(false);
      expect(/SET\s+(LOCAL\s+)?ROLE|set_config\s*\(\s*'role'|row_security|BYPASSRLS|DISABLE ROW LEVEL/i.test(t), `${f}: RLS bypass`).toBe(false);
      expect(/from\s+['"]pg['"]/.test(t), `${f}: imports pg`).toBe(false);
      expect(/console\./.test(t), `${f}: console`).toBe(false);
    }
  });
  it('review #14: per mutation the stored row is SELECTed (getMutationByClientId) BEFORE the guard runs, and the mutation is INSERTed after it; sync_batches is inserted LAST, after every mutation insert', () => {
    expect(existsSync(F.sync), 'sync.service.ts missing').toBe(true);
    const t = code(F.sync);
    const sel = pos(t, /getMutationByClientId/), ins = pos(t, /insertMutation\b/), batch = pos(t, /insertSyncBatch\b/);
    expect(sel, 'no getMutationByClientId').toBeGreaterThanOrEqual(0);
    expect(ins, 'no insertMutation').toBeGreaterThanOrEqual(0);
    expect(batch, 'no insertSyncBatch').toBeGreaterThanOrEqual(0);
    expect(sel).toBeLessThan(ins);
    expect(t.lastIndexOf('insertMutation')).toBeLessThan(batch);
    // the guards live in conflict.service.ts and are invoked between the SELECT and the INSERT
    const guard = pos(t, /conflict\.service/);
    expect(guard, 'sync.service does not use conflict.service').toBeGreaterThanOrEqual(0);
    expect(existsSync(F.conflict)).toBe(true);
  });
  it('append-only tables: no update / delete of mutations or sync_batches (no such repo function is used)', () => {
    const t = all();
    expect(/update(Mutation|SyncBatch)|delete(Mutation|SyncBatch)/i.test(t)).toBe(false);
    expect(/mutations\.repo/.test(t)).toBe(true);
    expect(/syncBatches\.repo/.test(t)).toBe(true);
    expect(/ON CONFLICT/i.test(t), 'ON CONFLICT DO NOTHING belongs in the repository').toBe(false);
  });
  it('m#38: payload_sha256 = SHA-256 of the RFC 8785 (JCS) canonical JSON of the payload, computed server-side (node:crypto sha256, a canonicalizer; not JSON.stringify of the raw payload)', () => {
    const t = all();
    expect(t).toMatch(/createHash\(\s*['"]sha256['"]\s*\)|sha256/i);
    expect(t).toMatch(/jcs|canonicali[sz]e|rfc ?8785/i);
    expect(/createHash\([^)]*\)\.update\(\s*JSON\.stringify\(/.test(t), 'hashes JSON.stringify output (key order dependent)').toBe(false);
  });
  it('uses the HC-T03 repositories + ports by catalog names: devices (max_device_seq_received, last_push_at), collections, handovers + items, visit flags, GPS rows, LabPort.lookupSpecimens({orderId}), assertRole(sync.upload)', () => {
    const t = all();
    for (const re of [/devices\.repo/, /collections\.repo/, /handovers\.repo/, /insertHandoverItem/, /visitFlags\.repo/, /visitLocations\.repo/, /visitTransitions\.repo|visitTransition/, /lookupSpecimens/, /assertRole/, /orderId/,
      /homecollection\.sync\.upload|HOMECOLLECTION_PERMISSIONS/, /correctCapturedTime/, /validateMutationPayload|domain\/mutation/]) expect(t, String(re)).toMatch(re);
  });
  it('names verbatim (03-IC / errors.yaml): outcomes, codes, event type, flags, handover item outcomes', () => {
    const t = all();
    for (const s of ['homecollection.mutation_superseded', 'homecollection.visit_not_assigned', 'homecollection.barcode_mismatch', 'homecollection.visit_closed', 'common.idempotency_key_reused', 'common.not_found',
      'common.validation_failed', 'common.payload_too_large', 'common.dependency_unavailable', 'collected_after_cancel', 'held_collection', 'specimen_not_collected', 'payment_rejected', 'identity_mismatch',
      'skipped_not_collected', 'skipped_already_handed_over', 'homecollection.collection.synced.v1']) expect(t, s).toContain(s);
  });
  it('events go through the typed publisher (events/publish.ts): sync.service never calls events.publish with a raw type string', () => {
    expect(existsSync(F.publish), 'events/publish.ts missing').toBe(true);
    const t = code(F.publish);
    expect(t).toMatch(/createHomecollectionEvents/);
    expect(t).toMatch(/home_visit/);
    expect(t).toMatch(/:sync:/);
    expect(/events\.publish\([^)]*'homecollection\.collection\.synced\.v1'/.test(code(F.sync))).toBe(false);
  });
  it('REQ-SEC / 07 §6: no log line carries a barcode, payload, reference, GPS or free text', () => {
    expect(own().length, 'HC-T12 files missing').toBeGreaterThan(0);
    for (const f of own()) {
      const t = code(f);
      expect(/ctx\.log\.\w+\([^)]*(barcode|payload|reference|latitude|longitude|reason_text|note)/i.test(t), `${f}: logs PHI / payload`).toBe(false);
    }
  });
  it('concurrency (TRD §6.3): touched visits are locked in ascending id order (SELECT ... FOR UPDATE through the visits repository)', () => {
    const t = all();
    expect(t).toMatch(/lock|forUpdate|FOR UPDATE/i);
    expect(t).toMatch(/\.sort\(/);
  });
});
