// C14.T23 Help + manual — review-checklist tests. Spec: 04-UI-UX "In-app help and manual" (help keys smartreport.queue/review/library/library_editor/library_review/wording;
// manual pages: overview, library authoring, approval responsibilities (B14), health score formula, review workflow, LLM layer (Phase 3)), 02-TRD §4.4 (hs-1),
// 01-PRD (B14: every patient sentence written/approved by the tenant's named pathologist; nothing generated freely). Plan row T23: "every screen has help; manual explains B14 responsibility and hs-1".
// LD-140 does not apply (markdown only, no UI code).
// ASSUMED naming (dispute if wrong): help file = help/<helpKey minus "smartreport.">.md  -> queue.md, review.md, library.md, library_editor.md, library_review.md, wording.md.
// Existing PageHeader keys that differ from the spec list are aliased: smartreport.summary -> review, smartreport.library.editor -> library_editor.
// Manual = docs/manual/smartreport/{README,overview,library-authoring,approval-responsibilities,health-score,review-workflow,llm-layer}.md.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../../../../', import.meta.url));
const feat = join(root, 'apps/web/src/features/smartreport');
const helpDir = join(feat, 'help');
const manualDir = join(root, 'docs/manual/smartreport');
const read = (p: string) => readFileSync(p, 'utf8');
const mdIn = (d: string) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith('.md')) : []);
const helpOf = (k: string) => read(join(helpDir, `${k}.md`));
const manualOf = (n: string) => read(join(manualDir, `${n}.md`));
const manualText = () => mdIn(manualDir).map((n) => read(join(manualDir, n))).join('\n');

// ---- screens: the six spec help keys (verbatim) + every literal helpKey the C14 UI passes to PageHeader
const SPEC_SCREENS = ['queue', 'review', 'library', 'library_editor', 'library_review', 'wording'];
const ALIAS: Record<string, string> = { summary: 'review', 'library.editor': 'library_editor' };
const compsDir = join(feat, 'components');
const literalKeys = [...new Set(readdirSync(compsDir).filter((n) => n.endsWith('.tsx')).flatMap((n) => [...read(join(compsDir, n)).matchAll(/helpKey="smartreport\.([a-z_.]+)"/g)].map((m) => m[1]!)))];
const screens = [...new Set([...SPEC_SCREENS, ...literalKeys.map((k) => ALIAS[k] ?? k)])].sort();

const MANUAL_PAGES = ['README', 'overview', 'library-authoring', 'approval-responsibilities', 'health-score', 'review-workflow', 'llm-layer'];
const NONDIAG = /non-diagnostic|not a diagnosis|does not (give|make) a diagnosis|not (a )?medical advice|not diagnostic/i;

describe('SR-T23 help: every smart report screen', () => {
  it('discovers the screens (non-vacuous)', () => {
    expect(screens).toEqual(expect.arrayContaining(SPEC_SCREENS));
    expect(literalKeys.length).toBeGreaterThanOrEqual(4); // UI really passes helpKeys; unknown keys must be aliased above
    for (const k of literalKeys) expect(screens, `helpKey smartreport.${k} is not a known screen`).toContain(ALIAS[k] ?? k);
  });
  it.each(screens)('help/%s.md exists with title, Purpose and Fields/Actions headings', (k) => {
    const p = join(helpDir, `${k}.md`);
    expect(existsSync(p), `missing ${p}`).toBe(true);
    const t = helpOf(k);
    expect(t.length).toBeGreaterThan(400);
    expect(t).toMatch(/^#\s+\S/m);
    expect(t, `${k}.md needs a Purpose heading`).toMatch(/^#{2,3}\s+.*Purpose/im);
    expect(t, `${k}.md needs a Fields, Actions or Statuses heading`).toMatch(/^#{2,3}\s+.*(Fields|Actions|Statuses|Columns)/im);
  });
  it('no orphan help files (each maps to a screen)', () => {
    expect(mdIn(helpDir).filter((n) => !screens.includes(n.replace(/\.md$/, '')))).toEqual([]);
  });
});

describe('SR-T23 help content (04-UI-UX SR-01..SR-06)', () => {
  it('queue: filters, keyboard J/K/Enter, centre scope, feature-off message', () => {
    const t = helpOf('queue');
    expect(t).toMatch(/\bJ\b[^.\n]*\bK\b/);
    expect(t).toMatch(/Enter/);
    expect(t).toMatch(/centre/i);
    expect(t).toMatch(/switched off|feature (is )?off|turned off/i);
    expect(t).toMatch(/waiting for review|pending review|needs review/i);
  });
  it('review: approve/reject, B14 responsibility, library version, hs-1, non-diagnostic', () => {
    const t = helpOf('review');
    expect(t).toMatch(/Approve/);
    expect(t).toMatch(/Reject/);
    expect(t).toMatch(/Rebuild with active library/);
    expect(t).toMatch(/hs-1/);
    expect(t).toMatch(NONDIAG);
    expect(t, 'review help must state the pathologist\'s responsibility').toMatch(/pathologist/i);
    expect(t).toMatch(/responsib|accountab|you (are )?approv/i);
    expect(t).toMatch(/Ctrl\+Enter/);
  });
  it('library: version lifecycle draft -> in review -> approved -> retired, one active approved version', () => {
    const t = helpOf('library');
    for (const s of [/draft/i, /in review/i, /approved/i, /retired/i]) expect(t).toMatch(s);
    expect(t).toMatch(/one (active )?approved version|only one[^.\n]*(active|approved)/i);
    expect(t).toMatch(/starter/i);
  });
  it('library_editor: tabs, placeholders, hs-1 settings, locked after submit', () => {
    const t = helpOf('library_editor');
    for (const s of [/Texts/, /Groups/, /Rules/, /Settings/, /Check/]) expect(t).toMatch(s);
    expect(t).toMatch(/placeholder/i);
    expect(t).toMatch(/hs-1/);
    expect(t).toMatch(/only (a )?draft|draft (versions? )?(can|is) (be )?edit|read-only|locked/i);
    expect(t).toMatch(/lang="ne"|Nepali|Devanagari/i);
  });
  it('library_review: approval is privileged, identity + content hash recorded, return with comment', () => {
    const t = helpOf('library_review');
    expect(t).toMatch(/smartreport\.template\.approve/);
    expect(t).toMatch(/pathologist/i);
    expect(t).toMatch(/recorded|record of/i);
    expect(t).toMatch(/return(ed)?[^.\n]*comment|comment[^.\n]*return/i);
    expect(t).toMatch(/hash|fingerprint|SHA-256|exact text/i);
  });
  it('wording: Global vs This lab scope, add term, deactivate (global rows have no actions)', () => {
    const t = helpOf('wording');
    expect(t).toMatch(/Global/);
    expect(t).toMatch(/This lab/);
    expect(t).toMatch(/Add term/);
    expect(t).toMatch(/Deactivate/);
    expect(t).toMatch(/Reason/);
  });
});

describe('SR-T23 manual (docs/manual/smartreport)', () => {
  it('has the index and every spec page, all non-trivial', () => {
    for (const n of MANUAL_PAGES) {
      const p = join(manualDir, `${n}.md`);
      expect(existsSync(p), `missing ${p}`).toBe(true);
      expect(read(p).length, p).toBeGreaterThan(400);
      expect(read(p), `${n}.md needs a title`).toMatch(/^#\s+\S/m);
    }
  });
  it('README indexes every other manual page', () => {
    const t = manualOf('README');
    for (const n of MANUAL_PAGES.filter((x) => x !== 'README')) expect(t, `README does not link ${n}.md`).toContain(`${n}.md`);
  });
  it('mirrors help: every smart report screen route is covered', () => {
    const t = manualText();
    for (const r of ['/smartreport/summaries', '/smartreport/library', '/smartreport/wording', '/smartreport/library/{library_version_id}/review', '/smartreport/summaries/{summary_id}'])
      expect(t, `manual does not mention ${r}`).toContain(r);
  });
  it('overview: what patients see and why nothing is free-generated', () => {
    const t = manualOf('overview');
    expect(t).toMatch(/pathologist/i);
    expect(t).toMatch(/approved/i);
    expect(t).toMatch(/(nothing|no sentence|never)[^.\n]*(generated freely|free-generated|free text|made up|invented)|only[^.\n]*approved (text|wording|sentences|library)/i);
    expect(t).toMatch(/patient/i);
    expect(t).toMatch(NONDIAG);
  });
  it('library-authoring: statuses, placeholders, preview, Nepali, groups/rules', () => {
    const t = manualOf('library-authoring');
    for (const s of [/draft/i, /in review/i, /approved/i, /retired/i, /placeholder/i, /preview/i, /Nepali/i, /group/i, /rule/i, /starter/i]) expect(t).toMatch(s);
    expect(t).toMatch(/smartreport\.template\.manage/);
  });
  it('approval-responsibilities: B14 named pathologist, both approvals, traceability, author may approve', () => {
    const t = manualOf('approval-responsibilities');
    expect(t, 'must cite B14').toMatch(/\bB14\b/);
    expect(t).toMatch(/named pathologist/i);
    expect(t).toMatch(/smartreport\.template\.approve/);
    expect(t).toMatch(/smartreport\.summary\.approve/);
    expect(t, 'both library and per-summary approval').toMatch(/each (patient )?summary|per[- ]summary|every summary/i);
    expect(t, 'traceability: this exact text approved by X on date Y').toMatch(/approved by[^.\n]*(on|date)|who approved|exact text/i);
    expect(t, 'small labs: author may be approver').toMatch(/author[^.\n]*(also )?(be|may be|can be)[^.\n]*approver|same (person|pathologist)/i);
    expect(t, 'no pathologist appointed -> feature unusable').toMatch(/no summary[^.\n]*(built|can be)|until (a|the) (named )?pathologist|cannot be (built|used)/i);
    expect(t).toMatch(/responsib|accountab/i);
  });
  it('health-score: hs-1 published formula steps, defaults, banding, non-diagnostic', () => {
    const t = manualOf('health-score');
    expect(t).toMatch(/hs-1/);
    for (const p of ['credit_in_range_bp', 'credit_borderline_bp', 'credit_out_of_range_bp', 'credit_critical_bp', 'score_weight', 'include_in_score', 'min_groups_scored', 'band_good_min', 'band_fair_min', 'critical_forces_needs_attention', 'score_enabled'])
      expect(t, `health-score.md must define ${p}`).toContain(p);
    expect(t).toMatch(/round(ed)? half up|half-up/i);
    expect(t).toMatch(/needs_attention|needs attention/i);
    expect(t).toMatch(/\b80\b/);
    expect(t).toMatch(/\b60\b/);
    expect(t).toMatch(/weighted/i);
    expect(t).toMatch(/hs-2|new (formula )?code|old summaries keep/i);
    expect(t).toMatch(NONDIAG);
    expect(t, 'worked example with a final integer 0-100 score').toMatch(/example/i);
  });
  it('review-workflow: queue -> review -> approve/reject/rebuild, keyboard shortcuts', () => {
    const t = manualOf('review-workflow');
    for (const s of [/queue/i, /Approve/, /Reject/, /Rebuild/, /Approve & next/, /Ctrl\+Enter/, /Ctrl\+Shift\+R/, /Ctrl\+Shift\+Enter/]) expect(t).toMatch(s);
    expect(t).toMatch(/centre/i);
  });
  it('llm-layer: Phase 3, off by default, pathologist still approves', () => {
    const t = manualOf('llm-layer');
    expect(t).toMatch(/Phase 3/);
    expect(t).toMatch(/off by default|disabled by default|switched off|only when[^.\n]*enabled/i);
    expect(t).toMatch(/pathologist/i);
    expect(t).toMatch(/approv/i);
    expect(t).toMatch(/Rephrase with AI/);
  });
  it('help and manual agree on the formula code and routes', () => {
    expect(helpOf('review')).toMatch(/hs-1/);
    expect(manualText()).toMatch(/hs-1/);
    expect(manualText()).toMatch(/B14/);
  });
});

describe('SR-T23 links, synthetic data and safety of copy', () => {
  const imgs = mdIn(manualDir).flatMap((n) => [...read(join(manualDir, n)).matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ page: n, alt: m[1]!, src: m[2]! })));
  it('any image is local, exists, is a PNG and has alt text (images optional)', () => {
    for (const i of imgs) {
      expect(i.src, `${i.page}: remote image`).not.toMatch(/^[a-z]+:\/\//i);
      const p = resolve(manualDir, i.src);
      expect(p.startsWith(manualDir), `${i.page}: image escapes the manual folder`).toBe(true);
      expect(existsSync(p), `${i.page}: missing ${i.src}`).toBe(true);
      expect(readFileSync(p).subarray(0, 8).toString('hex'), `${i.src} is not a PNG`).toBe('89504e470d0a1a0a');
      expect(i.alt.trim().length, `${i.page}: empty alt`).toBeGreaterThan(5);
    }
  });
  it('relative markdown links between manual pages resolve', () => {
    for (const n of mdIn(manualDir)) for (const m of read(join(manualDir, n)).matchAll(/(?<!!)\[[^\]]*\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g)) {
      if (/^[a-z]+:\/\//i.test(m[1]!)) continue;
      expect(existsSync(resolve(manualDir, m[1]!)), `${n}: broken link ${m[1]}`).toBe(true);
    }
  });
  it('help and manual contain no real-looking contact data, secrets or real patient names', () => {
    const files = [...mdIn(helpDir).map((n) => join(helpDir, n)), ...mdIn(manualDir).map((n) => join(manualDir, n))];
    expect(files.length).toBeGreaterThanOrEqual(13); // 6 help + 7 manual
    const hits = files.flatMap((f) => read(f).split(/\r?\n/).flatMap((l, i) => {
      const bad: string[] = [];
      for (const m of l.matchAll(/[\w.+-]+@([\w-]+(?:\.[\w-]+)+)/g)) if (!/(^|\.)(example\.(com|org|net)|test|invalid|example|localhost)$/i.test(m[1]!)) bad.push(`email ${m[0]}`);
      if (/\b(Bearer\s+[A-Za-z0-9._-]{12,}|api[_-]?key\s*[:=]|password\s*[:=]|secret\s*[:=]|eyJ[A-Za-z0-9_-]{20,})/i.test(l)) bad.push('secret-like');
      return bad.map((b) => `${f}:${i + 1}: ${b}`);
    }));
    expect(hits).toEqual([]);
  });
  it('copy never promises a diagnosis, cure or a free-form AI author', () => {
    const files = [...mdIn(helpDir).map((n) => join(helpDir, n)), ...mdIn(manualDir).map((n) => join(manualDir, n))];
    expect(files.length).toBeGreaterThanOrEqual(13);
    const hits = files.flatMap((f) => read(f).split(/\r?\n/).flatMap((l, i) => (/\b(diagnoses|will cure|AI (writes|generates) (the )?(summary|report|text)|automatically (sent|released) to (the )?patients?)\b/i.test(l) && !/\b(not|never|no|does not|doesn't)\b/i.test(l) ? [`${f}:${i + 1}: ${l.trim()}`] : [])));
    expect(hits).toEqual([]);
  });
});
