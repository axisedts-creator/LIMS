// C6-T09 harness self-check: proves the fixtures (not the implementation) behave, so a red T09 run means the task is missing / wrong, not that the fakes are.
import { describe, expect, it } from 'vitest';
import {
  FINAL_PDF, LOGO, LOGO_ID, MAIN_PDF, OUT_BUCKET, OUT_BYTES, OUT_PATH, SIG1_IMG, I, baseStore, b64, makeAssembler, makeIdentity, makeRenderer, makeStore, renderSetup, sha256, snapshot,
  enc, settle, unavailable, partBytes,
} from './render.helpers.js';

describe('render harness', () => {
  it('seeds one `rendering` version of the laboratory report with a full snapshot', () => {
    const s = renderSetup(); const v = s.version();
    expect(v).toMatchObject({ status: 'rendering', report_id: s.db.all('reporting.reports').find((r) => r['family'] === 'laboratory')!['id'], pdf_sha256: null, render_attempts: 0 });
    expect(v['content_snapshot']).toEqual(snapshot()); expect(s.db.all('reporting.report_template_versions')).toHaveLength(1);
  });
  it('identity fake: branding by asset id, signature only for m1, profiles carry council, not_found otherwise', async () => {
    const id = makeIdentity();
    expect((await id.port.readBrandingAsset({}, { assetId: LOGO_ID })).sha256).toBe(sha256(LOGO));
    expect((await id.port.readSignatureImage({}, { membershipId: I.m1 })).contentBase64).toBe(b64(SIG1_IMG));
    expect(((await settle(id.port.readSignatureImage({}, { membershipId: I.m2 }))) as any).code).toBe('common.not_found');
    expect((await id.port.getSignatories({}, { membershipIds: [I.m1, I.m2] })).map((p: any) => p.council)).toEqual(['NMC', 'NHPC']);
    expect((await makeIdentity({ noCouncil: true }).port.getSignatories({}, { membershipIds: [I.m1] }))[0]).not.toHaveProperty('council');
  });
  it('fake tx honours savepoints: an UPDATE after SAVEPOINT x is undone by ROLLBACK TO SAVEPOINT x', async () => {
    const s = renderSetup(); const q = (t: string, v: unknown[] = []) => s.db.tx.query(t, v);
    await q('SAVEPOINT x'); await q(`UPDATE reporting.report_versions SET status = 'rendered' WHERE tenant_id = $1`, [s.version()['tenant_id']]);
    expect(s.version().status).toBe('rendered'); await q('ROLLBACK TO SAVEPOINT x'); expect(s.version().status).toBe('rendering');
  });
  it('renderer / assembler / store fakes', async () => {
    expect((await makeRenderer().render({})).pageCount).toBe(2); expect(((await settle(makeRenderer(unavailable()).render({}))) as any).code).toBe('reporting.render_unavailable');
    const a = makeAssembler({ pageCount: 7 }); expect(await a.assemble({ parts: [] })).toMatchObject({ pageCount: 7 }); expect(a.calls).toHaveLength(1);
    const st = baseStore(); expect(Buffer.from(await st.read(OUT_BUCKET, OUT_PATH)).equals(Buffer.from(OUT_BYTES))).toBe(true);
    await st.put('reports', 'x/y.pdf', FINAL_PDF, { ifAbsent: true }); expect(await settle(st.put('reports', 'x/y.pdf', MAIN_PDF, { ifAbsent: true }))).toBeInstanceOf(Error);
    expect(makeStore().puts).toHaveLength(0); expect(Buffer.from(partBytes({ pdf_base64: b64(enc('hi')) })).toString()).toBe('hi');
  });
});
