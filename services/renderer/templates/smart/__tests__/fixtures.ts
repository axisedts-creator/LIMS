// C14-T22 fixtures: synthetic SmartSummary snapshots (03-IC §4.10 + 08 display fields) and fragment helpers. Synthetic data only.
export const U = (n: number) => `018f0000-0000-7000-8000-${String(n).padStart(12, '0')}`;

export const NOTICE = "This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor.";
export const DISCLAIMER_EN = 'SYNTH-DISCLAIMER This summary does not replace advice from your own doctor.';
export const APPROVED_AT = '2026-11-05T04:15:00Z';

export function approved(over: Record<string, unknown> = {}): any {
  return {
    summaryId: U(1), orderId: U(2), reportVersionNo: 1, templateLibraryVersion: 'lib-SYN-1', status: 'approved', approvedByMembershipId: U(3), approvedAt: APPROVED_AT,
    language: 'en', builtAt: '2026-11-05T03:00:00Z', disclaimerBlockId: U(9), disclaimerText: DISCLAIMER_EN,
    healthScore: { value: 72, band: 'fair', formulaVersion: 'score-SYN-1', panelsScored: 4, explanationText: 'SYNTH-EXPLAIN The score reflects how many body systems are in range.' },
    panels: [
      { panelCode: 'CBC', status: 'in_range', resultIds: [U(11)], displayName: 'SYNTH Blood count' },
      { panelCode: 'LIPID', status: 'borderline', resultIds: [U(12)], displayName: 'SYNTH Fat profile' },
      { panelCode: 'GLU', status: 'out_of_range', resultIds: [U(13)], displayName: 'SYNTH Sugar' },
      { panelCode: 'K', status: 'critical', resultIds: [U(14)], displayName: 'SYNTH Minerals' },
    ],
    deranged: [
      { resultId: U(13), analyteId: U(23), direction: 'high', severity: 'out_of_range', templateBlockId: U(33), text: 'SYNTH-FIND-1 Your sugar is higher than the reference range.', analyteName: 'Glucose' },
      { resultId: U(14), analyteId: U(24), direction: 'low', severity: 'critical', templateBlockId: U(34), text: 'SYNTH-FIND-2 Your potassium is lower than the reference range.', analyteName: 'Potassium' },
      { resultId: U(15), analyteId: U(25), direction: 'abnormal', severity: 'borderline', templateBlockId: U(35), text: 'SYNTH-FIND-3 One result is not in its usual form.', analyteName: 'Urine colour' },
    ],
    trends: [{
      analyteId: U(23), direction: 'improved', pointResultIds: [U(41), U(42), U(13)], analyteName: 'Glucose', unitCode: 'mg/dL',
      points: [
        { resultId: U(41), approvedAt: '2025-11-02T04:15:00Z', valueNumeric: '15.0' },
        { resultId: U(42), approvedAt: '2026-05-03T04:15:00Z', valueNumeric: '10.50' },
        { resultId: U(13), approvedAt: APPROVED_AT, valueNumeric: '5.60' },
      ],
    }],
    advice: [{ templateBlockId: U(51), text: 'SYNTH-ADVICE-1 Eat regular balanced meals.' }, { templateBlockId: U(52), text: 'SYNTH-ADVICE-2 Walk every day.' }],
    followUps: [{ ruleId: U(61), suggestedTestCode: 'HBA1C', intervalDays: 90, text: 'SYNTH-FOLLOW-1 Repeat the sugar control test.', suggestedTestName: 'Glycated haemoglobin' }],
    ...over,
  };
}

/** Devanagari block texts (library language ne). Fixed copy stays English (04-UI-UX §4.3). */
export function devanagari(): any {
  return approved({
    language: 'ne', disclaimerText: 'यो सारांशले तपाईंको चिकित्सकको सल्लाहलाई प्रतिस्थापन गर्दैन।',
    healthScore: { value: 72, band: 'fair', formulaVersion: 'score-SYN-1', panelsScored: 4, explanationText: 'यो अङ्कले कति शारीरिक प्रणाली सामान्य सीमामा छन् भन्ने देखाउँछ।' },
    panels: [{ panelCode: 'CBC', status: 'in_range', resultIds: [U(11)], displayName: 'रगतको जाँच' }, { panelCode: 'GLU', status: 'out_of_range', resultIds: [U(13)], displayName: 'चिनीको जाँच' }],
    deranged: [{ resultId: U(13), analyteId: U(23), direction: 'high', severity: 'out_of_range', templateBlockId: U(33), text: 'तपाईंको चिनीको मात्रा सामान्य सीमाभन्दा बढी छ।', analyteName: 'ग्लुकोज' }],
    advice: [{ templateBlockId: U(51), text: 'नियमित सन्तुलित खाना खानुहोस्।' }],
    followUps: [{ ruleId: U(61), suggestedTestCode: 'HBA1C', intervalDays: 90, text: 'चिनी नियन्त्रणको जाँच दोहोर्याउनुहोस्।', suggestedTestName: 'ग्लाइकेटेड हेमोग्लोबिन' }],
  });
}

export const noScore = () => { const s = approved(); delete s.healthScore; return s; };
export const noTrends = () => approved({ trends: [] });
export const emptyFindings = () => approved({ deranged: [], advice: [], followUps: [], trends: [] });

export const HOSTILE = '<b>bold</b> & <script>alert(1)</script> <img src=x onerror=alert(2)> "q" \'s\' <a href="http://evil.invalid/">l</a>';

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
/** Decodes HTML entities the way a browser does for text content. */
export const decode = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e: string) => {
  if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? all;
  return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
});
/** Visible text of a fragment: tags removed (a tag boundary = one space), entities decoded, whitespace collapsed. */
export const textOf = (html: string) => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export interface Tag { name: string; close: boolean; attrs: Record<string, string> }
/** Minimal tag scanner (our output always double-quotes attribute values; anything else fails the shape tests). */
export function tags(html: string): Tag[] {
  const out: Tag[] = [];
  for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s+[^\s=>]+(?:="[^"]*")?)*)\s*\/?>/g)) {
    const attrs: Record<string, string> = {};
    for (const a of m[3]!.matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]!.toLowerCase()] = a[2] ?? '';
    out.push({ name: m[2]!.toLowerCase(), close: m[1] === '/', attrs });
  }
  return out;
}
