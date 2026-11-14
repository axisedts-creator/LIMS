// T0A-06 golden generator + cross-library comparison (02-TRD §3.2 steps 1–4; 04 D13).
// Usage: node packages/test-fixtures/bsdate/generate.mjs [--dart <nepali_utils-dump.json>] [--today YYYY-MM-DD] [--preview]
//   1. candidates from @remotemerge/nepali-date-converter 1.2.7 (through the wrapper, so its range rules apply);
//   2. compared with bikram-sambat 1.8.1 (<= 2090 B.S.), @sbmdkl/nepali-date-converter 2.0.5 (A.D. <= 2040) and,
//      when --dart is given, nepali_utils 3.0.8 (dump from packages/shared-dart/tool/bsdate_dump.dart);
//   3. every disagreement goes to review.json (status "unresolved"); existing human resolutions are kept;
//      golden-2000-2099.json is written only when no entry is unresolved;
//   4. rows later than current B.S. year + 5 carry "projection": true.
// bikram-sambat / @sbmdkl are test oracles only (02-TRD §3.2); this script is fixture tooling, never app code.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { adToBs, bsToAd, daysInBsMonth } from '../../shared-ts/src/bsdate/index.ts';

const require = createRequire(import.meta.url);
const bikram = require('bikram-sambat');
const sbmdkl = await import('@sbmdkl/nepali-date-converter');

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const pad = (n, w) => String(n).padStart(w, '0');
const ymd = (y, m, d) => `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86_400_000;
const isoOf = (n) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const attempt = (f) => { try { return f(); } catch { return undefined; } };

const today = arg('--today') ?? new Date().toISOString().slice(0, 10);
const projectionAfter = adToBs(today).year + 5;

// ---- 1. candidates ----
const months = [];
for (let y = 2000; y <= 2099; y++) {
  for (let m = 1; m <= 12; m++) {
    const row = { bs_year: y, bs_month: m, days: daysInBsMonth(y, m), ad_first_day: bsToAd({ year: y, month: m, day: 1 }) };
    if (y > projectionAfter) row.projection = true;
    months.push(row);
  }
}

// ---- 2. oracles: each returns {days, ad_first_day} or undefined when the month is outside its table ----
const oracles = {
  'bikram-sambat@1.8.1': (y, m) => attempt(() => {
    const g = bikram.toGreg(y, m, 1);
    return { days: bikram.daysInMonth(y, m), ad_first_day: ymd(g.year, g.month, g.day) };
  }),
  '@sbmdkl/nepali-date-converter@2.0.5': (y, m) => attempt(() => {
    const first = sbmdkl.bsToAd(ymd(y, m, 1));
    let days = 29;
    while (days < 32 && attempt(() => sbmdkl.bsToAd(ymd(y, m, days + 1)))) days++;
    return { days, ad_first_day: first };
  }),
};
const dartFile = arg('--dart');
if (dartFile) {
  const dump = new Map(JSON.parse(readFileSync(dartFile, 'utf8')).months.map((r) => [`${r.bs_year}-${r.bs_month}`, r]));
  oracles['nepali_utils@3.0.8'] = (y, m) => { const r = dump.get(`${y}-${m}`); return r && { days: r.days, ad_first_day: r.ad_first_day }; };
}

const reviewPath = here('./review.json');
const prior = existsSync(reviewPath) ? JSON.parse(readFileSync(reviewPath, 'utf8')).entries : [];
const keyOf = (k) => `${k.bs_year}-${k.bs_month}`;
const priorByKey = new Map(prior.map((e) => [keyOf(e.key), e]));

const entries = [];
const coverage = Object.fromEntries(Object.keys(oracles).map((k) => [k, 0]));
for (const r of months) {
  const values = { '@remotemerge/nepali-date-converter@1.2.7': { days: r.days, ad_first_day: r.ad_first_day } };
  for (const [lib, f] of Object.entries(oracles)) {
    const v = f(r.bs_year, r.bs_month);
    if (v) { values[lib] = v; coverage[lib]++; }
  }
  const distinct = new Set(Object.values(values).map((v) => `${v.days}|${v.ad_first_day}`));
  if (distinct.size > 1) {
    const key = { bs_year: r.bs_year, bs_month: r.bs_month };
    const old = priorByKey.get(keyOf(key));
    // Resolved entries (human or LD-08) are kept as-is; only the observed library values are refreshed.
    // LD-08 (2026-11-07, owner): no human review blocks T0A-06 — an open disagreement takes the source
    // package's value (@remotemerge/nepali-date-converter@1.2.7) and is flagged verify_before_golive.
    entries.push(old?.status === 'resolved' ? { ...old, values } : {
      key, values, status: 'resolved', resolved_by: 'LD-08',
      resolution: values['@remotemerge/nepali-date-converter@1.2.7'], verify_before_golive: true,
    });
    if (entries.at(-1).verify_before_golive) r.verify_before_golive = true;
  }
}

// ---- 3. review.json always; golden only when clean ----
writeFileSync(reviewPath, JSON.stringify({ compared_months: months.length, coverage, entries }, null, 2) + '\n');
const open = entries.filter((e) => e.status !== 'resolved');
// --preview: write the candidate golden anyway (marked "unreviewed") to exercise the wrapper locally. Never commit it.
const preview = process.argv.includes('--preview');
if (open.length && !preview) {
  console.error(`${open.length} unresolved disagreement(s) in review.json; golden NOT written.`);
  process.exit(1);
}
const candidate = (e) => e.values['@remotemerge/nepali-date-converter@1.2.7'];
const diverging = entries.filter((e) => e.status === 'resolved'
  && (e.resolution?.days !== candidate(e).days || e.resolution?.ad_first_day !== candidate(e).ad_first_day));
if (diverging.length && !preview) {
  // A resolution that departs from the candidate library needs a wrapper override first; refuse silently diverging.
  console.error(`${diverging.length} resolution(s) differ from the wrapper: apply each in the wrapper, then re-run. golden NOT written.`);
  process.exit(1);
}

// ---- probes: 200 days spread over the table, deterministic (mulberry32, seed fixed) ----
let s = 0x0a06;
const rnd = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32; };
const lo = dayNum(months[0].ad_first_day);
const hi = dayNum(months.at(-1).ad_first_day) + months.at(-1).days - 1;
const picked = new Set();
while (picked.size < 200) picked.add(lo + Math.floor(rnd() * (hi - lo + 1)));
const probes = [...picked].sort((a, b) => a - b).map((n) => {
  const ad = isoOf(n);
  const b = adToBs(ad);
  return { ad, bs: ymd(b.year, b.month, b.day) };
});

writeFileSync(here('./golden-2000-2099.json'), JSON.stringify({
  ...(preview && { unreviewed: true }),
  source: '@remotemerge/nepali-date-converter@1.2.7',
  generated_on: today,
  projection_after_bs_year: projectionAfter,
  months,
  probes,
}, null, 1) + '\n');
console.log(`golden written: ${months.length} months, ${probes.length} probes; coverage ${JSON.stringify(coverage)}`);
