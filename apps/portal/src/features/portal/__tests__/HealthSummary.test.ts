// C6-T39 — 02-TRD §14 row "08 Addendum A4" (d), component level; 04-UI-UX §4.1; 08 A4.7. Server-renders <HealthSummary> (no browser, no JS in the page):
// snapshot -> section with heading, N1 notice, snapshot disclaimerText, approval line, read-only (no controls / links); unrenderable snapshot -> error copy;
// text is React-escaped (a `<script>` in snapshot text never becomes markup); `lang="ne"` on Devanagari blocks. The page-level hidden/shown/error + zero-SmartReportPort-call
// assertions (real Next server, stub API) live in tests/portal-e2e/C6-T30.portal.spec.ts (AC-11.11) and C6-T30.static.test.mjs (no SmartReportPort / smartreport.* in apps/portal).
// Written with createElement (no JSX) so vitest needs no JSX transform of the Next tsconfig (`jsx: preserve`).
import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HealthSummary } from '../HealthSummary';

// vitest transforms the .tsx with the classic JSX runtime (Next's `jsx: preserve` is not a vite transform): give it the global it expects.
(globalThis as { React?: typeof React }).React = React;

const N1 = "This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor.";
const N1H = N1.replace(/'/g, '&#x27;');   // renderToStaticMarkup escapes the apostrophe
const ERR ='Your health summary cannot be shown right now. Your full report is available to download above.';
const SUMMARY: any = {
  summaryId: '01900000-0000-7000-8000-0000000000a1', orderId: '01900000-0000-7000-8000-0000000000a2', reportVersionNo: 1, templateLibraryVersion: 't1', status: 'approved', language: 'en',
  healthScore: { value: 82, band: 'good', formulaVersion: 'f1', panelsScored: 1 },
  panels: [{ panelCode: 'CBC', status: 'borderline', resultIds: [], displayName: 'Complete Blood Count' }],
  deranged: [{ resultId: 'r1', analyteId: 'a1', direction: 'low', severity: 'borderline', templateBlockId: 'b1', text: 'Haemoglobin is slightly low.', analyteName: 'Haemoglobin' }],
  advice: [{ templateBlockId: 'b2', text: 'Eat iron-rich food.' }],
  followUps: [{ ruleId: 'f1', suggestedTestCode: 'FERR', intervalDays: 90, text: 'Repeat in 3 months.', suggestedTestName: 'Serum Ferritin' }],
  trends: [], disclaimerBlockId: 'b3', disclaimerText: 'SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS',
};
const html = (s: unknown) => renderToStaticMarkup(createElement(HealthSummary as any, { summary: s }));

describe('A4(d) portal "Health summary" section (04-UI-UX §4.1)', () => {
  it('renders from the snapshot: heading, fixed notice N1 verbatim, snapshot disclaimerText, content in C14 order, approval line', () => {
    const h = html(SUMMARY);
    expect(h).toContain('>Health summary</h2>'); expect(h).toContain(N1H); expect(h).toContain('SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS');
    for (const t of ['Complete Blood Count', 'Haemoglobin', 'Eat iron-rich food.', 'Serum Ferritin', '90 days', '(not a diagnosis)']) expect(h, t).toContain(t);
    const order = [N1H, '(not a diagnosis)', 'Complete Blood Count', 'Haemoglobin', 'Eat iron-rich food.', 'Serum Ferritin', 'SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS', 'Reviewed and approved'].map((t) => h.indexOf(t));
    expect(order.every((i) => i >= 0)).toBe(true); expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h).toContain('Borderline');                                   // status as a word, not colour only
  });
  it('read-only: no form controls, no links, no buttons, no scripts, no images (no prices / booking / promotions next to follow-ups or advice)', () => {
    expect(html(SUMMARY)).not.toMatch(/<(a|button|input|select|textarea|form|script|img|iframe)[\s>]/i);
  });
  it('unrenderable snapshot -> heading + fixed error copy only; no N1, no throw', () => {
    for (const bad of [{ broken: true }, { ...SUMMARY, panels: 'x' }, { ...SUMMARY, disclaimerText: undefined }, { ...SUMMARY, followUps: null }]) {
      const h = html(bad);
      expect(h).toContain('>Health summary</h2>'); expect(h).toContain(ERR); expect(h).not.toContain(N1H);
    }
  });
  it('snapshot text is escaped: markup in advice / disclaimer / analyte names stays text', () => {
    const h = html({ ...SUMMARY, disclaimerText: '<script>alert(1)</script>', advice: [{ templateBlockId: 'b', text: '<img src=x onerror=alert(1)>' }] });
    expect(h).not.toMatch(/<script|<img/i); expect(h).toContain('&lt;script&gt;');
  });
  it('lang="ne" on Devanagari block text for a Nepali snapshot, none for English', () => {
    expect(html({ ...SUMMARY, language: 'ne', advice: [{ templateBlockId: 'b', text: 'आइरन भएको खाना खानुहोस्।' }] })).toMatch(/lang="ne"[^>]*>[^<]*आइरन/);
    expect(html(SUMMARY)).not.toContain('lang="ne"');
  });
  it('optional parts are omitted, not shown empty: no score -> no score line; no advice -> no "Suggestions" heading; disclaimer + notice always present', () => {
    const h = html({ ...SUMMARY, healthScore: undefined, advice: [], followUps: [], deranged: [] });
    expect(h).not.toContain('not a diagnosis)'); expect(h).not.toContain('Suggestions'); expect(h).toContain(N1H); expect(h).toContain('SYNTHETIC-DISCLAIMER-TEXT-FOR-TESTS');
  });
});
