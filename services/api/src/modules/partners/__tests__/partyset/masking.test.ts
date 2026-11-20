// T0B-PARTYSET-1 done_when (5) MASKING (+ 07-SECURITY: personal / government ids). Real PG17.
// Pins: mask = '*' x (length-4) + last four chars, produced in one place (every read below shows the SAME masked text); the full value only through revealPartyIdNumber with
// partners.party_id_number.read (aal2), each reveal writes one audit event (who, party, field, NEVER the value); full value never in a reply, log line, audit.audit_log row.
// tax_number / national_id_number: 1..32 chars, letters digits and '-' only (length and characters only; the accountant confirms the exact format, in the notes).
import { beforeEach, describe, expect, it } from 'vitest';
import { ADMIN_A, ADMIN_B, P, T, TENANT_A, TENANT_B, auditRows, dbRow, dbRows, fire, ifm, mask, mkCreditParty, mkDoctor, mkPartner, notFound, ok, only, rejected, req, superTx, wipe, as } from './helpers.js';

const TAX = 'SYN000000001', NID = 'SYN-NID-0001', PAN = '987654321';
const getPartner = (id: string, who = ADMIN_A) => fire('getPartner', req({ params: { partner_id: id } }), who);
const listPartners = (who = ADMIN_A) => fire('listPartners', req({ query: { limit: 100 } }), who);
const updatePartner = (id: string, body: unknown, v = 1, who = ADMIN_A) => fire('updatePartner', req({ params: { partner_id: id }, headers: ifm(v), body }), who);
const reveal = (kind: string, id: string, field: string, who = ADMIN_A) => fire('revealPartyIdNumber', req({ params: { party_kind: kind, party_id: id }, body: { field } }), who);
const everything = (o: { reply?: any; error?: any; probe: { logs: string[]; access: any[] } }) => JSON.stringify([o.reply?.body ?? null, o.probe.logs, o.probe.access, (o.error as any)?.message ?? '', (o.error as any)?.errors ?? []]);

beforeEach(async () => { await wipe(TENANT_A, TENANT_B); }, T);

describe('the mask itself', () => {
  it('matches the contract examples', () => {
    expect(mask(TAX)).toBe('********0001');
    expect(mask(NID)).toBe('********0001');
    expect(mask(PAN)).toBe('*****4321');
    expect(mask('ABC')).toBe('***');
  });
});

describe('partners: every read shows the masked value', () => {
  it('getPartner, listPartners and the updatePartner reply show tax_number / national_id_number masked, never full', async () => {
    const p = await mkPartner(TENANT_A, { tax_number: TAX, national_id_number: NID });
    const g = await getPartner(p.id);
    expect(ok(g)).toMatchObject({ tax_number: mask(TAX), national_id_number: mask(NID) });
    const l = await listPartners();
    const row = ok(l).data.find((x: any) => x.id === p.id);
    expect(row).toMatchObject({ tax_number: mask(TAX), national_id_number: mask(NID) });
    const u = await updatePartner(p.id, { name: 'Synthetic Renamed Partner' });
    expect(ok(u)).toMatchObject({ tax_number: mask(TAX), national_id_number: mask(NID) });
    for (const o of [g, l, u]) { expect(everything(o)).not.toContain(TAX); expect(everything(o)).not.toContain(NID); expect(everything(o)).not.toContain('SYN000000001'); }
  }, T);
  it('also for a caller holding partners.party_id_number.read: normal reads stay masked (the value comes only from the reveal call)', async () => {
    const p = await mkPartner(TENANT_A, { tax_number: TAX });
    const o = await getPartner(p.id, as(ADMIN_A, { grants: [P.partnerRead, P.idRead] }));
    expect(ok(o).tax_number).toBe(mask(TAX));
    expect(everything(o)).not.toContain(TAX);
  }, T);
  it('a partner without ids has no tax_number / national_id_number in the reply (or null), never an empty mask', async () => {
    const p = await mkPartner(TENANT_A);
    const b = ok(await getPartner(p.id));
    expect(b.tax_number ?? null).toBeNull();
    expect(b.national_id_number ?? null).toBeNull();
  }, T);
  it('a short value (4 chars or fewer) is fully starred', async () => {
    const p = await mkPartner(TENANT_A, { tax_number: 'AB12' });
    expect(ok(await getPartner(p.id)).tax_number).toBe('****');
  }, T);
});

describe('partners: writing the ids', () => {
  it('updatePartner stores the FULL value, answers it masked, and the value never reaches audit.audit_log or the log lines', async () => {
    const p = await mkPartner(TENANT_A);
    const o = await updatePartner(p.id, { tax_number: TAX, national_id_number: NID });
    expect(ok(o)).toMatchObject({ tax_number: mask(TAX), national_id_number: mask(NID) });
    expect(await dbRow('partners.partners', p.id)).toMatchObject({ tax_number: TAX, national_id_number: NID });
    expect(everything(o)).not.toContain(TAX);
    const trail = JSON.stringify(await auditRows('partners.partners', p.id));
    expect(trail).not.toContain(TAX);
    expect(trail).not.toContain(NID);
  }, T);
  it('a change made straight in the table (owner) is not audited with the value either (the audit trigger excludes the id columns)', async () => {
    const p = await mkPartner(TENANT_A);
    await superTx(async (tx) => { await tx.query('UPDATE partners.partners SET tax_number = $2, national_id_number = $3 WHERE id = $1', [p.id, TAX, NID]); }, TENANT_A);
    const trail = JSON.stringify(await auditRows('partners.partners', p.id));
    expect(trail).not.toContain(TAX);
    expect(trail).not.toContain(NID);
  }, T);
  it.each([
    ['tax_number', ''], ['tax_number', 'A'.repeat(33)], ['tax_number', 'AB\u0000CD'], ['tax_number', 'AB<CD>'], ['tax_number', "AB'CD"], ['tax_number', 'AB;CD'], ['tax_number', 12345], ['tax_number', null],
    ['national_id_number', ''], ['national_id_number', 'N'.repeat(33)], ['national_id_number', 'NI\nD1'], ['national_id_number', 'NI<D1'], ['national_id_number', 7],
  ])('%s = %j is refused with its field path, the value is not echoed, nothing is written', async (field, value) => {
    const p = await mkPartner(TENANT_A);
    const o = await updatePartner(p.id, { [field]: value });
    rejected(o, 'common.validation_failed', `/${field}`, typeof value === 'string' && value.length > 3 ? value : undefined);
    expect(o.probe.writes).toEqual([]);
    expect((await dbRow('partners.partners', p.id))[field]).toBeNull();
  }, T);
  it('the limits are valid: 1 and 32 characters, letters digits and hyphen', async () => {
    const p = await mkPartner(TENANT_A);
    ok(await updatePartner(p.id, { tax_number: 'A' }));
    ok(await updatePartner(p.id, { tax_number: 'A1-'.repeat(10) + 'ZZ' }, 2));
    expect((await dbRow('partners.partners', p.id)).tax_number).toHaveLength(32);
  }, T);
});

describe('credit party and doctor reads (catalog) are masked too', () => {
  it('getCreditParty shows pan masked; the master row keeps the full value', async () => {
    const { manifest } = await import('../../../catalog/index.js');
    const cp = await mkCreditParty(TENANT_A, { pan: PAN });
    const o = await fire('getCreditParty', req({ params: { credit_party_id: cp.id } }), as(ADMIN_A, { grants: [P.priceRead, P.priceManage] }), { manifest: manifest as never });
    expect(ok(o).pan).toBe(mask(PAN));
    expect(everything(o)).not.toContain(PAN);
    expect((await dbRow('catalog.credit_parties', cp.id)).pan).toBe(PAN);
  }, T);
});

describe('revealPartyIdNumber', () => {
  it('answers the full value to partners.party_id_number.read at aal2 and writes ONE audit event per call that names who / party / field and never the value', async () => {
    const p = await mkPartner(TENANT_A, { tax_number: TAX, national_id_number: NID });
    const o = await reveal('partner', p.id, 'tax_number');
    expect(ok(o)).toEqual({ party_kind: 'partner', party_id: p.id, field: 'tax_number', value: TAX });
    expect(o.probe.identity).toContain(P.idRead);
    expect(o.probe.access).toHaveLength(1);
    const ev = JSON.stringify(o.probe.access[0]);
    expect(ev).toContain(p.id);
    expect(ev).toContain('tax_number');
    expect(ev).not.toContain(TAX);
    expect(ev).not.toContain('"value"');
    const o2 = await reveal('partner', p.id, 'national_id_number');
    expect(ok(o2).value).toBe(NID);
    expect(o2.probe.access).toHaveLength(1);
    expect(JSON.stringify([o.probe.logs, o2.probe.logs])).not.toMatch(new RegExp(`${TAX}|${NID}`));
  }, T);
  it('works for a doctor (national_id_number) and a credit party (tax_number = pan)', async () => {
    const d = await mkDoctor(TENANT_A, { national_id_number: NID });
    expect(ok(await reveal('doctor', d.id, 'national_id_number')).value).toBe(NID);
    const cp = await mkCreditParty(TENANT_A, { pan: PAN });
    expect(ok(await reveal('credit_party', cp.id, 'tax_number')).value).toBe(PAN);
  }, T);
  it('without the permission: auth.forbidden, no value anywhere in the answer; at aal1: auth.mfa_required; no reveal audit event either way', async () => {
    const p = await mkPartner(TENANT_A, { tax_number: TAX });
    const no = await reveal('partner', p.id, 'tax_number', only(5, P.partnerRead, P.settingRead, P.settingManage, P.penalty, P.decide));
    rejected(no, 'auth.forbidden', undefined, TAX);
    expect(everything(no)).not.toContain(TAX);
    const low = await reveal('partner', p.id, 'tax_number', as(ADMIN_A, { mfa: 'aal1' }));
    rejected(low, 'auth.mfa_required', undefined, TAX);
    expect(everything(low)).not.toContain(TAX);
  }, T);
  it('a party without the field, an unknown party and a party of another tenant are common.not_found; a bad field is /field', async () => {
    const p = await mkPartner(TENANT_A, { tax_number: TAX });
    notFound(await reveal('partner', p.id, 'national_id_number'));
    notFound(await reveal('partner', '01a1a98a-ac40-7000-8000-00000000dead', 'tax_number'));
    notFound(await reveal('partner', p.id, 'tax_number', ADMIN_B));
    rejected(await reveal('partner', p.id, 'password'), 'common.validation_failed', '/field');
  }, T);
});

describe('no handler of the module returns a full id number without the permission (sweep)', () => {
  it('every read of partner data, as a caller with all partners codes except party_id_number.read, is free of the full values', async () => {
    const p = await mkPartner(TENANT_A, { tax_number: TAX, national_id_number: NID });
    await superTx(async (tx) => { await tx.query('INSERT INTO partners.party_onboarding (id, tenant_id, party_kind, party_id, created_by, updated_by) VALUES (gen_random_uuid(), $1, $2, $3, $4, $4)', [TENANT_A, 'partner', p.id, ADMIN_A.userId]); }, TENANT_A);
    const who = as(ADMIN_A, { grants: [P.partnerRead, P.partnerManage, P.settingRead, P.settingManage, P.decide, P.penalty] });
    const outs = [
      await getPartner(p.id, who), await listPartners(who),
      await fire('listPartyOnboarding', req({ query: {} }), who),
      await fire('getPartyCommercialSetting', req({ params: { party_kind: 'partner', party_id: p.id } }), who),
      await fire('listNonComplianceEvents', req({ query: { party_kind: 'partner', party_id: p.id } }), who),
    ];
    for (const o of outs) { expect(o.error, String((o.error as any)?.message)).toBeUndefined(); expect(everything(o)).not.toMatch(new RegExp(`${TAX}|${NID}`)); }
    // nothing in the audit log of the whole database carries either value (partners, doctors and credit parties are all audited with the id columns excluded)
    expect(await dbRows('audit.audit_log', 'audit_log::text LIKE $1 OR audit_log::text LIKE $2', [`%${TAX}%`, `%${NID}%`])).toEqual([]);
  }, T);
});
