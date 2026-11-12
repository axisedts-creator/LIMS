// @vitest-environment jsdom
// C14.T29 — SR-02 Phase 3 LLM panel (04-UI-UX SR-02 "Phase 3 LLM panel"; PRD AC-20.4 UI; 07-SECURITY AB-9/AB-11, REQ-SEC-088/089/101).
// Spec: per item a `TextDiff` (template vs AI text) or, until CR-C14-008 ships in @lims/ui, two stacked `Card`s labelled "Approved template text" /
// "AI-rephrased text"; failed items show `Badge` "Kept original" with the failure codes. @lims/ui has no TextDiff yet, so these tests pin the fallback layout.
// ASSUMED CONTRACT (spec silent — a dispute may refine it): component `LlmPanel` is a named export of
//   apps/web/src/features/smartreport/components/LlmPanel.tsx, props `{ run: LlmRun; language?: 'en' | 'ne' }`, where `run` is the #34 `LlmRun`
//   (contracts/openapi/smartreport.yaml: items[{ item_ref, template_text, output_text?, passed, failure_codes[] }]) rendered as received (snake_case).
//   Each item is one labelled container (section/article/group/region/li/.lims-card). A failed item's rejected `output_text` is NOT shown
//   (the reviewer sees the kept original + the codes; AC-20.3).
// The page wiring (SR-02 route, Rephrase button, Approve dialog Switch) belongs to T19 and is not tested here. Synthetic data only.
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';

afterEach(cleanup);
const load = async () => ((await import(/* @vite-ignore */ '../components/LlmPanel')) as { LlmPanel: (p: any) => any }).LlmPanel;
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
const pageText = () => norm(document.body.textContent);
const ITEM = 'section, article, [role="group"], [role="region"], .lims-card, li';
const itemOf = (el: HTMLElement) => el.closest(ITEM) as HTMLElement;
const axeClean = async () => {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
};

const T1 = '{analyte_name} is below the reference range of this laboratory.';
const O1 = '{analyte_name} is lower than the reference range of this laboratory.';
const T2 = 'Please discuss {analyte_name} with your doctor.';
const O2_REJECTED = 'Please discuss 5 {analyte_name} with your doctor, take iron tablets.';
const T3 = 'Consider {test_name} again in {interval_days} days.';
const O3 = 'You may wish to repeat {test_name} in {interval_days} days.';
const items = () => [
  { item_ref: 'deranged:r1', template_text: T1, output_text: O1, passed: true, failure_codes: [] as string[] },
  { item_ref: 'advice:b1', template_text: T2, output_text: O2_REJECTED, passed: false, failure_codes: ['digit_added', 'deny_term'] },
  { item_ref: 'followup:f1', template_text: T3, output_text: O3, passed: true, failure_codes: [] as string[] },
];
const run = (over: Record<string, unknown> = {}) => ({
  id: '01940e00-0000-7000-8000-000000000a01', status: 'partially_passed', prompt_template_version: 'p1', model_ref: 'synthetic-model', created_at: '2026-01-15T04:30:00.000Z',
  items: items(), ...over,
});
const allPassed = () => run({ status: 'succeeded', items: items().filter((i) => i.passed) });

describe('LlmPanel — side-by-side fallback (done_when: diff visible)', () => {
  it('shows, for every item, the template text and the AI text under the spec labels', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={allPassed()} />);
    expect(screen.getAllByText('Approved template text')).toHaveLength(2);
    expect(screen.getAllByText('AI-rephrased text')).toHaveLength(2);
    for (const t of [T1, O1, T3, O3]) expect(pageText()).toContain(norm(t));
  });

  it('pairs each template text with its own AI text, in run order', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={allPassed()} />);
    const first = itemOf(screen.getAllByText('Approved template text')[0]!);
    expect(norm(first.textContent)).toContain(norm(T1));
    expect(norm(first.textContent)).toContain(norm(O1));
    expect(norm(first.textContent)).not.toContain(norm(O3));
    expect(pageText().indexOf(norm(T1))).toBeLessThan(pageText().indexOf(norm(T3)));
  });

  it('keeps {placeholder} tokens verbatim — no patient values are ever filled into this panel', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={allPassed()} />);
    expect(pageText()).toContain('{analyte_name}');
    expect(pageText()).toContain('{interval_days}');
  });

  it('shows no "Kept original" badge when every item passed', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={allPassed()} />);
    expect(screen.queryByText(/kept original/i)).toBeNull();
  });
});

describe('LlmPanel — failed items (done_when: "Kept original" badges)', () => {
  it('shows one "Kept original" badge per failed item, none for passed items', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={run()} />);
    expect(screen.getAllByText('Kept original')).toHaveLength(1);
    cleanup();
    const two = run({ items: [...items(), { item_ref: 'advice:b2', template_text: 'Another {group_name} note.', passed: false, failure_codes: ['item_mismatch'] }] });
    render(<LlmPanel run={two} />);
    expect(screen.getAllByText('Kept original')).toHaveLength(2);
  });

  it("lists the failure codes verbatim inside the failed item only", async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={run()} />);
    const failed = itemOf(screen.getByText('Kept original'));
    expect(failed.textContent).toContain('digit_added');
    expect(failed.textContent).toContain('deny_term');
    expect(norm(failed.textContent)).toContain(norm(T2));
    expect(failed.textContent).not.toContain('lower than'); // the passed item's AI text is not inside the failed item
  });

  it('shows the approved template text of a failed item and does NOT show the rejected model output (AB-11)', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={run()} />);
    expect(pageText()).toContain(norm(T2));
    expect(pageText()).not.toContain('iron tablets');
    expect(pageText()).not.toContain('Please discuss 5');
  });

  it('a failed item without output_text (failed run) still renders template + badge + code', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={run({ status: 'failed', items: [{ item_ref: 'advice:b1', template_text: T2, passed: false, failure_codes: ['llm_call_failed'] }] })} />);
    expect(pageText()).toContain(norm(T2));
    expect(screen.getAllByText('Kept original')).toHaveLength(1);
    expect(pageText()).toContain('llm_call_failed');
  });
});

describe('LlmPanel — untrusted text (REQ-SEC-088/089/101, AB-9)', () => {
  it('renders template and model text as text nodes only (XSS corpus)', async () => {
    const LlmPanel = await load();
    const xss = run({ items: [
      { item_ref: 'advice:x1', template_text: '<img src=x onerror=alert(1)> {group_name}', output_text: '<script>alert(2)</script> <a href="https://evil.example">click</a> {group_name}', passed: true, failure_codes: [] },
    ] });
    const { container } = render(<LlmPanel run={xss} />);
    expect(container.querySelector('img, script, a, iframe, svg')).toBeNull();
    expect(pageText()).toContain('<script>alert(2)</script>');
    expect(pageText()).toContain('<img src=x onerror=alert(1)>');
  });

  it('never exposes run internals (model_ref, run id) in the reviewer panel text', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={run()} />);
    expect(pageText()).not.toContain('synthetic-model');
    expect(pageText()).not.toContain('01940e00-0000-7000-8000-000000000a01');
  });
});

describe('LlmPanel — accessibility', () => {
  it('is axe-clean with passed and failed items', async () => {
    const LlmPanel = await load();
    render(<LlmPanel run={run()} />);
    await axeClean();
  });

  it('marks Devanagari text with lang="ne" when language is ne', async () => {
    const LlmPanel = await load();
    const ne = run({ items: [{ item_ref: 'advice:n1', template_text: 'कृपया {analyte_name} बारे डाक्टरसँग सल्लाह गर्नुहोस्।', output_text: 'कृपया {analyte_name} को बारेमा डाक्टरसँग कुरा गर्नुहोस्।', passed: true, failure_codes: [] }] });
    const { container } = render(<LlmPanel run={ne} language="ne" />);
    const els = [...container.querySelectorAll('[lang="ne"]')].map((e) => e.textContent ?? '');
    expect(els.some((t) => t.includes('डाक्टरसँग सल्लाह'))).toBe(true);
    expect(els.some((t) => t.includes('को बारेमा'))).toBe(true);
  });
});
