// C14-T22 — smart section fragment (04-UI-UX §4; C6 02-TRD §5.3). Pure string builder: every input text goes through esc() (07-SECURITY T8),
// no attribute is ever built from input, only smart-* classes from print.css, no style/img/link. Block order = 04-UI-UX §4.2.
import { formatAd, formatBs, instantToBs, type IsoUtc } from '../../../../packages/shared-ts/src/bsdate/index.js';
import type { SmartSectionRenderer } from '../../src/templates/contract.js';
import { esc } from '../../src/templates/lab/shared.js';

const NOTICE = "This summary is prepared from your approved laboratory results using rules approved by the laboratory's pathologist. It is not a diagnosis or a prescription. Please discuss your results with your doctor.";
const STATUS: Record<string, string> = { in_range: 'In range', borderline: 'Borderline', out_of_range: 'Out of range', critical: 'Critical' };
const DIRECTION: Record<string, string> = { high: 'High', low: 'Low', abnormal: 'Abnormal' };
const TREND: Record<string, string> = { improved: 'Improved', worsened: 'Worsened', stable: 'Stable' };
const BAND: Record<string, string> = { good: 'Good', fair: 'Fair', needs_attention: 'Needs attention' };

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): Rec[] => (Array.isArray(v) ? v.filter(isRec) : []);
const str = (v: unknown): string => (typeof v === 'string' || typeof v === 'number' ? String(v) : '');
const word = (m: Record<string, string>, k: unknown): string => (typeof k === 'string' && Object.hasOwn(m, k) ? m[k]! : '');

function date(iso: string, calendarDisplay: string, tz: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '';
  const ad = formatAd(iso as IsoUtc, tz).slice(0, 10);
  if (calendarDisplay === 'AD' || !calendarDisplay) return ad;
  const bs = formatBs(instantToBs(iso as IsoUtc, tz), 'display');
  if (calendarDisplay === 'BS') return bs;
  return calendarDisplay === 'AD_BS' ? `${ad} (${bs})` : `${bs} (${ad})`;
}

function renderSections(input: { summary: unknown; calendarDisplay: string; timezone: string }): string {
  const s = input.summary;
  if (!isRec(s) || s['status'] !== 'approved') {
    console.warn('smart_render_not_approved'); // event name only: no PHI
    return '';
  }
  const tz = input.timezone || 'Asia/Kathmandu';
  const d = (iso: unknown) => esc(date(str(iso), input.calendarDisplay, tz));
  // Block text: Devanagari library language → lang="ne" on the text element (fixed English copy never carries it).
  const t = (v: unknown) => (s['language'] === 'ne' ? `<span lang="ne">${esc(str(v))}</span>` : esc(str(v)));
  const h3 = (x: string) => `<h3 class="smart-subtitle">${x}</h3>`;
  const list = (items: string[]) => (items.length ? `<ul class="smart-list">${items.map((i) => `<li>${i}</li>`).join('')}</ul>` : '');
  let out = `<section class="smart-section"><h2 class="smart-title">Smart summary</h2><p class="smart-notice">${esc(NOTICE)}</p>`;

  const hs = isRec(s['healthScore']) ? s['healthScore'] : undefined;
  if (hs && typeof hs['value'] === 'number') {
    out += `<div class="smart-score"><strong>Health score (not a diagnosis)</strong><span class="smart-score-value">${esc(hs['value'])} / 100</span>` +
      `<span class="smart-score-band">${esc(word(BAND, hs['band']))}</span><span>Based on ${esc(hs['panelsScored'])} body systems</span>` +
      `${hs['explanationText'] ? `<span>${t(hs['explanationText'])}</span>` : ''}</div>`;
  }

  const tiles = arr(s['panels']).filter((p) => word(STATUS, p['status'])).map((p) =>
    `<li class="smart-tile smart-status-${p['status']}"><span class="smart-tile-name">${t(p['displayName'])}</span> <span class="smart-tile-status">${word(STATUS, p['status'])}</span></li>`);
  if (tiles.length) out += `<ul class="smart-tiles">${tiles.join('')}</ul>`;

  const findings = arr(s['deranged']).map((f) =>
    `<strong>${t(f['analyteName'])}</strong> <span>${word(DIRECTION, f['direction'])}</span> <span>${word(STATUS, f['severity'])}</span> <span>${t(f['text'])}</span>`);
  if (findings.length) out += h3('Results outside the reference range') + list(findings);

  const trends = arr(s['trends']).map((x) => {
    const pts = arr(x['points']).sort((a, b) => Date.parse(str(a['approvedAt'])) - Date.parse(str(b['approvedAt'])))
      .map((p) => `<span>${d(p['approvedAt'])}: ${esc(str(p['valueNumeric']))}</span>`).join(' ');
    return `<tr><td>${t(x['analyteName'])}</td><td>${t(x['unitCode'])}</td><td>${pts}</td><td>${word(TREND, x['direction'])}</td></tr>`;
  });
  if (trends.length) {
    out += h3('Your results over time') + '<table class="smart-trends"><thead><tr><th scope="col">Result</th><th scope="col">Unit</th><th scope="col">Values, oldest to newest</th><th scope="col">Trend</th></tr></thead>' +
      `<tbody>${trends.join('')}</tbody></table>`;
  }

  const advice = arr(s['advice']).map((a) => t(a['text']));
  if (advice.length) out += h3('Suggestions') + list(advice);

  const follow = arr(s['followUps']).map((f) => {
    const name = str(f['suggestedTestName']) ? `${t(f['suggestedTestName'])}, ` : '';
    const days = typeof f['intervalDays'] === 'number' ? `after ${esc(f['intervalDays'])} days` : '';
    return `${t(f['text'])}${name || days ? ` (${name}${days})` : ''}`;
  });
  if (follow.length) out += h3('Tests your doctor may consider') + list(follow);

  if (s['disclaimerText']) out += `<p class="smart-disclaimer">${t(s['disclaimerText'])}</p>`;
  const formula = hs && hs['formulaVersion'] ? `; score formula ${esc(str(hs['formulaVersion']))}` : '';
  out += `<p class="smart-meta">Reviewed and approved by the laboratory's pathologist on ${d(s['approvedAt'])}. Summary library version ${esc(str(s['templateLibraryVersion']))}${formula}.</p></section>`;
  return out;
}

export const smartSectionRenderer: SmartSectionRenderer = { libraryVersion: 'smart-section-1', renderSections };
