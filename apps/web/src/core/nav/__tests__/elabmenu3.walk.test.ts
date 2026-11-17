// T0D-ELABMENU-3 (LD-340; founder 2026-11-17 20:37 NPT: keep it aligned with ElabAssist) — the heading of every page a sidebar entry opens is exactly the
// menu label of that entry. Walks the REAL generated manifest (run `pnpm --dir apps/web run build:nav` first) and the page sources (helpers: elabmenu3.helpers.ts).
// Contract the writer must satisfy:
//   (a) every entry whose page heading is statically visible shows a heading (literal or message key) equal to t(entry.label);
//   (b) pages pinned by rs-c2.static (features/admin, features/platform, app/(auth), app/(platform)) are not edited: if their heading differs they are LISTED by path
//       in .orchestra/notes/T0D-ELABMENU-3-impl.md (done_when 6);
//   (c) one shared header: the heading is drawn by PageHeader (or the admin Frame), never a bare <h1> — a page that must keep a bare <h1> is listed in the same notes file;
//   (d) a heading that had to change is a message key, never new hard-coded text (done_when 5);
//   (e) no label, key, route or permission changes (done_when 5, 8).
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { navEntries } from '@/core/nav/generated';
import { t } from '@/core/i18n/messages';
import baseline from './elabmenu3.baseline.json';
import { ROOT, WEB, matches, rows, type Row } from './elabmenu3.helpers';

const implNotes = join(ROOT, '.orchestra', 'notes', 'T0D-ELABMENU-3-impl.md');
const notes = existsSync(implNotes) ? readFileSync(implNotes, 'utf8') : '';
/** done_when (6): a page that cannot change is named (by its app path, e.g. /admin/users) in the writer's notes. */
const listed = (r: Row) => notes.includes(r.path) || (r.page !== null && notes.includes(r.page.replace(/\\/g, '/')));

/** Headings no regex can see (tab / config / state driven): checked by render tests of the writer or the lead, never guessed here. Shrinking this list is welcome. */
const NOT_STATIC = new Set(['lab.verification', 'lab.approval', 'quality.setup', 'admin.branches', 'admin.centres', 'instruments.settings']);

const label = (r: Row) => `${r.id}: menu "${r.label}" (${r.labelKey}) -> ${r.path}; found ${JSON.stringify(r.headings.map((h) => h.text || `<${h.raw}>`))} in ${r.headings.map((h) => h.file.replace(WEB, '')).join(', ')}`;

describe('the manifest is walked', () => {
  it('136 sidebar entries, every one with a translated label and an existing page file', () => {
    expect(rows.length).toBe(navEntries.length);
    expect(rows.length).toBeGreaterThanOrEqual(130);
    for (const r of rows) {
      expect(t(r.labelKey), r.id).not.toBe(r.labelKey);
      expect(r.page, `${r.id} (${r.path}) has no page.tsx`).not.toBeNull();
    }
  });
});

describe('(a) heading text = sidebar label text', () => {
  for (const r of rows) {
    const verifiable = r.headings.some((h) => h.kind !== 'dynamic');
    if (r.pinned) {
      it(`${r.id} [pinned page]: heading equals the label, or the page is listed in T0D-ELABMENU-3-impl.md`, () => {
        expect(matches(r) || listed(r), `${label(r)}\nPinned by rs-c2.static: change only the message value, or name ${r.path} in .orchestra/notes/T0D-ELABMENU-3-impl.md`).toBe(true);
      });
    } else if (!verifiable) {
      it(`${r.id}: heading is not statically visible (allow-listed)`, () => {
        expect(NOT_STATIC.has(r.id), `${r.id} has no static heading and is not allow-listed: ${label(r)}`).toBe(true);
      });
    } else {
      it(`${r.id}: heading is exactly "${r.label}"`, () => {
        expect(matches(r), label(r)).toBe(true);
      });
    }
  }
});

describe('(c) one shared header pattern', () => {
  for (const r of rows.filter((x) => !x.pinned && x.headings.some((h) => h.kind !== 'dynamic'))) {
    it(`${r.id}: the heading comes from PageHeader (title left, actions right), not a bare <h1>`, () => {
      const shared = r.headings.some((h) => h.tag !== 'h1');
      expect(shared || listed(r), `${label(r)}\nuse the shared PageHeader from @lims/ui/components/PageHeader, or name ${r.path} in the impl notes with the reason`).toBe(true);
    });
  }
});

describe('(d) a heading that had to change is a message key, not new hard-coded text', () => {
  for (const id of baseline.mismatched) {
    const r = rows.find((x) => x.id === id)!;
    it(`${id}: heading is drawn from a message key`, () => {
      const hit = r.headings.find((h) => h.kind !== 'dynamic' && h.text === r.label);
      expect(hit, `heading must equal "${r.label}" first: ${label(r)}`).toBeTruthy();
      expect(hit!.kind, `${id}: "${hit!.text}" is a literal in ${hit!.file.replace(WEB, '')}: use t('<existing message key>')`).toBe('key');
    });
  }
});

describe('(e) names only: no key, label, route or permission changes', () => {
  const src = readFileSync(join(WEB, 'src', 'core', 'i18n', 'messages.ts'), 'utf8');
  const keys = new Set([...src.matchAll(/^\s*'([^']+)':/gm)].map((m) => m[1]!));

  it('no message key of core/i18n/messages.ts is removed or renamed', () => {
    expect(baseline.keys.filter((k) => !keys.has(k))).toEqual([]);
  });

  it('every sidebar label keeps its key AND its text (the sidebar is the reference, the headings move to it)', () => {
    const drift = Object.entries(baseline.labels).filter(([id, b]) => {
      const e = navEntries.find((x) => x.id === id);
      return !e || e.label !== b.key || t(e.label) !== b.text;
    });
    expect(drift.map(([id]) => id)).toEqual([]);
  });

  it('no entry added or removed; routeId, path and permission of every entry unchanged (no route, permission, contract or API change)', () => {
    const now = Object.fromEntries(navEntries.map((e) => [e.id, { routeId: e.routeId, path: e.path, permission: e.permission }]));
    expect(now).toEqual(baseline.routes);
  });

  it('messages.ts stays English only: no non-ASCII letter in a heading value of a changed entry', () => {
    for (const r of rows) expect(r.label, r.id).toMatch(/^[\x20-\x7e]+$/);
  });
});
