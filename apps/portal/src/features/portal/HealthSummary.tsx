// "Health summary" (08 A4.7, C6 04-UI-UX §4.1): read-only text from the version snapshot; no controls, no links.
import type { SmartSummary } from '@/server/api';

const N1 =
  "This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor.";
const STATUS: Record<string, string> = { in_range: 'In range', borderline: 'Borderline', out_of_range: 'Out of range', critical: 'Critical' };
const DIRECTION: Record<string, string> = { high: 'High', low: 'Low', abnormal: 'Abnormal' };
const BAND: Record<string, string> = { good: 'Good', fair: 'Fair', needs_attention: 'Needs attention' };
const word = (m: Record<string, string>, k: string) => m[k] ?? k.replace(/_/g, ' ');

const renderable = (s: SmartSummary): boolean =>
  typeof s.disclaimerText === 'string' && Array.isArray(s.panels) && Array.isArray(s.deranged) && Array.isArray(s.advice) && Array.isArray(s.followUps);

export function HealthSummary({ summary }: { summary: SmartSummary }) {
  if (!renderable(summary)) {
    return (
      <section aria-labelledby="hs-h" className="portal-card">
        <h2 id="hs-h">Health summary</h2>
        <p>Your health summary cannot be shown right now. Your full report is available to download above.</p>
      </section>
    );
  }
  const lang = summary.language === 'ne' ? 'ne' : undefined;
  const { healthScore: score, panels = [], deranged = [], advice = [], followUps = [] } = summary;
  return (
    <section aria-labelledby="hs-h" className="portal-card">
      <h2 id="hs-h">Health summary</h2>
      <p>{N1}</p>
      {score ? (
        <p>
          Health score (not a diagnosis): {score.value} / 100 · {word(BAND, score.band)}
        </p>
      ) : null}
      <ul>
        {panels.map((p) => (
          <li key={p.panelCode} lang={lang}>
            {p.displayName}: {word(STATUS, p.status)}
          </li>
        ))}
      </ul>
      {deranged.length ? (
        <>
          <h3>Results outside the reference range</h3>
          <ul>
            {deranged.map((d, i) => (
              <li key={i} lang={lang}>
                {d.analyteName}: {word(DIRECTION, d.direction)}, {word(STATUS, d.severity)}. {d.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {advice.length ? (
        <>
          <h3>Suggestions</h3>
          <ul>
            {advice.map((a, i) => (
              <li key={i} lang={lang}>
                {a.text}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {followUps.length ? (
        <>
          <h3>Tests your doctor may consider</h3>
          <ul>
            {followUps.map((f, i) => (
              <li key={i} lang={lang}>
                {f.text} ({f.suggestedTestName}, after {f.intervalDays} days)
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <p lang={lang}>{summary.disclaimerText}</p>
      <p>Reviewed and approved by the laboratory&apos;s pathologist.</p>
    </section>
  );
}
