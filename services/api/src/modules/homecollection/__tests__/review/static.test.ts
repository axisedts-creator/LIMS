// HC-T13 static guards (no DB). Files of this task: collection.service.ts (+ handlers/reviewHeldCollection.ts wiring H9 into the manifest, as HC-T09/T12 did for their handlers).
// Guards: repository seam (SQL only in repository/*.repo.ts), collection state machine from domain/collection.state.ts, the event goes through the typed publisher of HC-T12 (events/publish.ts),
// ports by catalog name, names verbatim, no PHI / barcode / free text in logs (07-SECURITY §6). Fails now: the files do not exist (H9 is an HC-T01 stub).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const code = (f: string) => readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, '$1');
const F = { service: join(ROOT, 'collection.service.ts'), handler: join(ROOT, 'handlers', 'reviewHeldCollection.ts') };
const own = (): string[] => Object.values(F).filter(existsSync);
const all = (): string => own().map(code).join('\n');

describe('HC-T13 files', () => {
  it('collection.service.ts and handlers/reviewHeldCollection.ts exist', () => {
    for (const [k, f] of Object.entries(F)) expect(existsSync(f), `${k}: ${f} missing (HC-T13 not implemented yet)`).toBe(true);
  });
  it('the module manifest wires the real H9 handler (no 501 stub left for reviewHeldCollection)', () => {
    expect(code(join(ROOT, 'index.ts')), 'index.ts does not import handlers/reviewHeldCollection.js').toMatch(/handlers\/reviewHeldCollection\.js/);
  });
});

describe('HC-T13 source rules', () => {
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
  it('uses the HC-T03 repositories (collections, visit flags, visits) and the C0 collection state machine (held -> applied | discarded only)', () => {
    const t = all();
    for (const re of [/collections\.repo/, /getCollectionById/, /updateCollection\b/, /visitFlags\.repo/, /updateVisitFlag/, /listAppliedCollectionsBySpecimenIds/, /collection\.state|assertCollectionTransition/]) expect(t, String(re)).toMatch(re);
  });
  it('optimistic concurrency: the update passes the expected version (If-Match) to updateCollection', () => {
    expect(all()).toMatch(/updateCollection\s*\([^)]*(expectedVersion|version|ifMatch)/i);
  });
  it('C3 guards go through the ports by catalog name: FrontdeskPort.getOrderSummary (order cancelled?) and LabPort.lookupSpecimens({orderId}) (specimen ordered?); assertRole(homecollection.visit.assign)', () => {
    const t = all();
    for (const re of [/getOrderSummary/, /lookupSpecimens/, /orderId/, /assertRole/, /homecollection\.visit\.assign|HOMECOLLECTION_PERMISSIONS/]) expect(t, String(re)).toMatch(re);
  });
  it('the event goes through the typed publisher of HC-T12 (createHomecollectionEvents(...).collectionSynced); no raw events.publish with the type string', () => {
    const t = all();
    expect(t).toMatch(/createHomecollectionEvents/);
    expect(t).toMatch(/collectionSynced/);
    expect(/events\.publish\(/.test(t), 'raw events.publish').toBe(false);
  });
  it('names verbatim (03-IC §8 / errors.yaml): error codes, flag kind, decisions, statuses', () => {
    const t = all();
    for (const s of ['homecollection.collection_not_held', 'homecollection.mutation_superseded', 'homecollection.barcode_mismatch', 'common.validation_failed', 'common.not_found', 'held_collection',
      'review_reasons', 'applied', 'discarded', 'held']) expect(t, s).toContain(s);
  });
  it('cites the spec decisions it implements (CR-C17-006 trigger, CR-C17-007 code) in a comment', () => {
    const raw = own().map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(raw).toMatch(/CR-C17-006|H9|US-09/);
  });
  it('07 §6: no log line carries a barcode, reason text, free text, GPS or PHI', () => {
    expect(own().length, 'HC-T13 files missing').toBeGreaterThan(0);
    for (const f of own()) {
      const t = code(f);
      expect(/ctx\.log\.\w+\([^)]*(barcode|reason_text|reasonText|note|latitude|longitude|payload)/i.test(t), `${f}: logs PHI / free text`).toBe(false);
    }
  });
  it('the handler is thin: it delegates to collection.service.ts (no business rule in the handler)', () => {
    expect(existsSync(F.handler), 'handler missing').toBe(true);
    expect(code(F.handler)).toMatch(/collection\.service/);
  });
});
