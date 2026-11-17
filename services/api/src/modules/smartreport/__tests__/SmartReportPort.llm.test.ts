// C14 T28 — AC-20.4 / done_when "port returns LLM text only when approved with use_llm_text" (02-TRD §7.1 step 9; 03-IC §4.10; PRD AC-20.4).
// SmartReportPort.buildSummary returns the LLM overlay text of an item ONLY when status = approved AND use_llm_text = true AND the overlay holds that item (itemRef
// deranged:<resultId> | advice:<blockId> | followup:<ruleId>); in every other case the template text of the stored content. Output stays the allow-list (no llm_text / use_llm_text / llm_overlay).
// Part 2 drives the real #31 approval handler: approve {use_llm_text: true} over a draft with an overlay -> port returns the LLM text; {use_llm_text:false} / omitted -> template text.
// Fails now: the port ignores llm_overlay (and the overlay text is never applied).
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../repository/summaries.repo.js', async () => (await import('./t15.fakes.js')).summariesRepoFake);
vi.mock('../repository/reviews.repo.js', async () => (await import('./t15.fakes.js')).reviewsRepoFake);
vi.mock('../repository/codedSets.repo.js', async () => (await import('./t15.fakes.js')).codedSetsRepoFake);
vi.mock('../repository/bindings.repo.js', async () => (await import('./t15.fakes.js')).bindingsRepoFake);
vi.mock('../repository/library.repo.js', async () => (await import('./t15.fakes.js')).libraryRepoFake);
vi.mock('../repository/blocks.repo.js', async () => (await import('./t15.fakes.js')).blocksRepoFake);
vi.mock('../repository/rules.repo.js', async () => (await import('./t15.fakes.js')).rulesRepoFake);
vi.mock('../repository/mappings.repo.js', async () => (await import('./t15.fakes.js')).mappingsRepoFake);
vi.mock('../repository/groups.repo.js', async () => (await import('./t15.fakes.js')).groupsRepoFake);

import { handlers } from '../handlers/index.js';
import { smartReportPort } from '../ports/SmartReportPort.impl.js';
import { buildOrGet } from '../summary.service.js';
import { ifMatch, request } from './t11.helpers.js';
import { makeCtx as sysCtx, run as inSysTx } from './t12.fakes.js';
import { HGB_RESULT, ORDER, inTx, makeCtx, seedWorld, w } from './t15.fakes.js';

type Row = Record<string, any>;
const LLM_TEXT = 'The laboratory reference range is above Hemoglobin, which is lower than usual, so reading this with your doctor is wise.';
const settings = { featureFlags: { smart_report: true } };
const identity = { getTenantSettings: vi.fn(async (_c: unknown, input: { keys: string[] }) => Object.fromEntries(input.keys.map((k) => [k, (settings as any)[k]]))) };
const portCtx = (): any => { const c = sysCtx(); c.ports.IdentityPort = identity; return c; };
const mk = async (): Promise<Row> => { const c = sysCtx(); return (await inSysTx(c, () => buildOrGet(c, { orderId: ORDER.a } as any))).summary; };
const rowOf = (id: string): Row => w.summaries.find((s) => s.id === id)!;
const fetchView = async (): Promise<any> => { const c = portCtx(); return inSysTx(c, () => smartReportPort.buildSummary(c, { orderId: ORDER.a, version: 1 })); };
const REF = `deranged:${HGB_RESULT.a}`;
const overlayOf = (items: Record<string, string>) => ({ run_id: '01900000-7200-7000-8000-0000000007aa', items });
const approveVia = (id: string, body: unknown) => {
  const c = makeCtx('pathologist', 'approveSmartSummary');
  const h = (handlers as Record<string, (r: unknown, x: unknown) => Promise<any>>).approveSmartSummary!;
  return inTx(c.ctx, () => h(request({ params: { summary_id: id }, headers: ifMatch(rowOf(id).version), body }), c.ctx));
};
const textsOf = (v: any): string[] => [...v.deranged.map((d: Row) => d.text), ...v.advice.map((a: Row) => a.text), ...v.followUps.map((f: Row) => f.text)];
beforeEach(() => { seedWorld(); vi.clearAllMocks(); });

describe('C14-T28 port — LLM overlay applies only to an APPROVED summary with use_llm_text = true (AC-20.4)', () => {
  it('approved + use_llm_text true + overlay: the item text is the LLM text; everything else (disclaimer, panels, other items) is unchanged', async () => {
    const s = await mk(); const template = rowOf(s.id).content.deranged[0].text;
    Object.assign(rowOf(s.id), { status: 'approved', approved_at: '2026-11-12T01:00:00.000Z', approved_by_membership_id: '01900000-7200-7000-8000-000000007500', use_llm_text: true, llm_overlay: overlayOf({ [REF]: LLM_TEXT }) });
    const v = await fetchView();
    expect(v.status).toBe('approved');
    expect(v.deranged.find((d: Row) => d.resultId === HGB_RESULT.a).text).toBe(LLM_TEXT);
    expect(v.deranged.find((d: Row) => d.resultId === HGB_RESULT.a).text).not.toBe(template);
    expect(v.disclaimerText).toBe(rowOf(s.id).content.disclaimerText);
    expect(v.panels).toEqual(rowOf(s.id).content.panels);
  });

  it('approved + use_llm_text false (default) + overlay present: the TEMPLATE text', async () => {
    const s = await mk(); const template = rowOf(s.id).content.deranged[0].text;
    Object.assign(rowOf(s.id), { status: 'approved', approved_at: '2026-11-12T01:00:00.000Z', approved_by_membership_id: '01900000-7200-7000-8000-000000007500', use_llm_text: false, llm_overlay: overlayOf({ [REF]: LLM_TEXT }) });
    const v = await fetchView();
    expect(v.deranged.find((d: Row) => d.resultId === HGB_RESULT.a).text).toBe(template);
    expect(JSON.stringify(v)).not.toContain(LLM_TEXT);
  });

  it.each(['draft', 'rejected', 'superseded'])('status %s with an overlay (even with use_llm_text forced true): never LLM text (only approved text is printed)', async (status) => {
    const s = await mk(); const template = rowOf(s.id).content.deranged[0].text;
    Object.assign(rowOf(s.id), { status, use_llm_text: true, llm_overlay: overlayOf({ [REF]: LLM_TEXT }) });
    if (status === 'superseded') Object.assign(rowOf(s.id), { superseded_at: '2026-11-12T02:00:00.000Z', superseded_reason: 'results_changed' });
    const c = portCtx();
    const v = await inSysTx(c, () => smartReportPort.buildSummary(c, { orderId: ORDER.a, version: 1 })).catch(() => undefined);
    if (v !== undefined) { expect(JSON.stringify(v)).not.toContain(LLM_TEXT); expect(v.status).toBe('draft'); expect(textsOf(v)).toContain(template); }
  });

  it('approved + true but the overlay does not hold the item (it failed validation: "kept original") -> template text for that item', async () => {
    const s = await mk(); const template = rowOf(s.id).content.deranged[0].text;
    Object.assign(rowOf(s.id), { status: 'approved', approved_at: '2026-11-12T01:00:00.000Z', approved_by_membership_id: '01900000-7200-7000-8000-000000007500', use_llm_text: true,
      llm_overlay: overlayOf({ 'advice:01900000-7200-7000-8000-00000000ffff': 'unrelated overlay item' }) });
    const v = await fetchView();
    expect(v.deranged.find((d: Row) => d.resultId === HGB_RESULT.a).text).toBe(template);
    expect(JSON.stringify(v)).not.toContain('unrelated overlay item');
  });

  it('overlay entries for refs that are not in the content are ignored; no item is added or removed', async () => {
    const s = await mk(); const before = rowOf(s.id).content;
    Object.assign(rowOf(s.id), { status: 'approved', approved_at: '2026-11-12T01:00:00.000Z', approved_by_membership_id: '01900000-7200-7000-8000-000000007500', use_llm_text: true,
      llm_overlay: overlayOf({ [REF]: LLM_TEXT, 'deranged:01900000-7200-7000-8000-00000000eeee': 'INJECTED ITEM', 'followup:01900000-7200-7000-8000-00000000dddd': 'INJECTED FOLLOWUP' }) });
    const v = await fetchView();
    expect(v.deranged).toHaveLength(before.deranged.length); expect(v.advice).toHaveLength(before.advice.length); expect(v.followUps).toHaveLength(before.followUps.length);
    expect(JSON.stringify(v)).not.toContain('INJECTED');
  });

  it('approved + true but llm_overlay is null (data inconsistency the schema CHECK forbids) -> template text, no crash', async () => {
    const s = await mk(); const template = rowOf(s.id).content.deranged[0].text;
    Object.assign(rowOf(s.id), { status: 'approved', approved_at: '2026-11-12T01:00:00.000Z', approved_by_membership_id: '01900000-7200-7000-8000-000000007500', use_llm_text: true, llm_overlay: null });
    expect(textsOf(await fetchView())).toContain(template);
  });

  it('the output stays the allow-list: no llm_text / use_llm_text / llm_overlay / run id, with or without the overlay applied', async () => {
    const s = await mk();
    Object.assign(rowOf(s.id), { status: 'approved', approved_at: '2026-11-12T01:00:00.000Z', approved_by_membership_id: '01900000-7200-7000-8000-000000007500', use_llm_text: true, llm_overlay: overlayOf({ [REF]: LLM_TEXT }) });
    const wire = JSON.stringify(await fetchView());
    for (const leak of ['llm_text', 'llmText', 'use_llm_text', 'useLlmText', 'llm_overlay', 'llmOverlay', 'run_id', '01900000-7200-7000-8000-0000000007aa']) expect(wire, leak).not.toContain(leak);
  });

  it('LLM text that still carries an unfilled {placeholder} token is never printed raw (filled, or the template text kept)', async () => {
    const s = await mk();
    Object.assign(rowOf(s.id), { status: 'approved', approved_at: '2026-11-12T01:00:00.000Z', approved_by_membership_id: '01900000-7200-7000-8000-000000007500', use_llm_text: true,
      llm_overlay: overlayOf({ [REF]: 'Your {analyte_name} is lower than the usual range of this laboratory.' }) });
    for (const t of textsOf(await fetchView())) expect(t).not.toMatch(/\{[a-z_]+\}/);
  });
});

describe('C14-T28 approval handler #31 + port — the pathologist\'s decision decides (AC-20.4)', () => {
  const withOverlay = async (): Promise<Row> => { const s = await mk(); rowOf(s.id).llm_overlay = overlayOf({ [REF]: LLM_TEXT }); return s; };
  const hgbText = (v: any): string => v.deranged.find((d: Row) => d.resultId === HGB_RESULT.a).text;

  it('approve { attestation: true, use_llm_text: true } over a draft with an overlay -> port returns the LLM text', async () => {
    const s = await withOverlay();
    const r = await approveVia(s.id, { attestation: true, use_llm_text: true });
    expect(r.status).toBe(200); expect(r.body.llm.use_llm_text).toBe(true);
    expect(hgbText(await fetchView())).toBe(LLM_TEXT);
  });

  it('approve { attestation: true, use_llm_text: false } -> template text', async () => {
    const s = await withOverlay(); const template = rowOf(s.id).content.deranged[0].text;
    await approveVia(s.id, { attestation: true, use_llm_text: false });
    expect(hgbText(await fetchView())).toBe(template);
  });

  it('approve { attestation: true } (use_llm_text omitted = default false) -> template text', async () => {
    const s = await withOverlay(); const template = rowOf(s.id).content.deranged[0].text;
    await approveVia(s.id, { attestation: true });
    expect(rowOf(s.id).use_llm_text).toBe(false);
    expect(hgbText(await fetchView())).toBe(template);
  });

  it('before approval the port returns a draft with the template text even though the overlay exists', async () => {
    const s = await withOverlay(); const template = rowOf(s.id).content.deranged[0].text;
    const v = await fetchView();
    expect(v.status).toBe('draft'); expect(hgbText(v)).toBe(template);
  });

  it('use_llm_text true without any overlay -> common.validation_failed (schema CHECK summaries__llm__ck), still a draft', async () => {
    const s = await mk();
    await expect(approveVia(s.id, { attestation: true, use_llm_text: true })).rejects.toMatchObject({ code: 'common.validation_failed' });
    expect(rowOf(s.id).status).toBe('draft');
  });
});
