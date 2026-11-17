// C14 T11 — seed/starter-library.v1.json (02-TRD §9.3; AC-02.1, AC-02.5; 08 A19 D-108). Unit: the file equals the TRD §9.3 text (T10 fixture) and passes V1-V13.
// SEAM (spec silent on the file shape; ids are generated at load, so rules point at blocks by key):
//   { "language": "en", "blocks": [{ "block_key", "kind", "text_en" }], "rules": [{ "rule_kind", "trigger_kind", "direction", "min_severity"?, "priority", "block_key" }] }
//   No group settings in the file (one per ACTIVE organ group is derived at load), no mappings, no follow-up rules, no text_ne, no extra keys.
// Fails now: the file does not exist.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateLibrary } from '../domain/library.validate.js';
import { GLOBAL_DENY, sid, starterLibrary, type LibInput } from './t10.fixtures.js';

const file = join(import.meta.dirname, '..', 'seed', 'starter-library.v1.json');
const seed = (): any => JSON.parse(readFileSync(file, 'utf8'));
const tenSeed = starterLibrary();

describe('C14-T11 starter library seed', () => {
  it('top level: only language/blocks/rules; English; 6 blocks, 4 rules', () => {
    const s = seed();
    expect(Object.keys(s).sort()).toEqual(['blocks', 'language', 'rules']);
    expect(s.language).toBe('en');
    expect(s.blocks).toHaveLength(6);
    expect(s.rules).toHaveLength(4);
  });
  it('blocks equal TRD §9.3 verbatim (key, kind, text_en); no text_ne / extra keys', () => {
    const got = seed().blocks.map((b: any) => ({ blockKey: b.block_key, kind: b.kind, textEn: b.text_en })).sort((a: any, b: any) => a.blockKey.localeCompare(b.blockKey));
    const want = tenSeed.blocks.map((b) => ({ blockKey: b.blockKey, kind: b.kind, textEn: b.textEn })).sort((a, b) => a.blockKey.localeCompare(b.blockKey));
    expect(got).toEqual(want);
    for (const b of seed().blocks) expect(Object.keys(b).sort()).toEqual(['block_key', 'kind', 'text_en']);
  });
  it('rules equal TRD §9.3: three deranged any-rules (borderline, priority 900) + advice all_in_range; no follow-up, no analyte/group/test fields', () => {
    const byKey = new Map(tenSeed.blocks.map((b) => [b.id, b.blockKey]));
    const want = tenSeed.rules.map((r) => ({ rule_kind: r.ruleKind, trigger_kind: r.triggerKind, direction: r.direction, priority: r.priority, block_key: byKey.get(r.blockId), ...(r.minSeverity ? { min_severity: r.minSeverity } : {}) }));
    const sortKey = (r: any) => `${r.rule_kind}/${r.direction}`;
    expect([...seed().rules].sort((a: any, b: any) => sortKey(a).localeCompare(sortKey(b)))).toEqual(want.sort((a, b) => sortKey(a).localeCompare(sortKey(b))));
    expect(seed().rules.some((r: any) => r.rule_kind === 'followup')).toBe(false);
  });
  it('no digit anywhere in any text (V5) and no Devanagari', () => {
    for (const b of seed().blocks) { expect(b.text_en).not.toMatch(/[0-9०-९]/); expect(b.text_en).not.toMatch(/[ऀ-ॿ]/); }
  });
  it('passes V1-V13: with the file as the library the ONLY error is no_mappings (V14); adding one mapping makes it valid (AC-02.5, D-108)', () => {
    const s = seed();
    const ids = new Map<string, string>(s.blocks.map((b: any, i: number) => [b.block_key, sid(5000 + i)]));
    const lib: LibInput = {
      language: s.language, scoreEnabled: true,
      blocks: s.blocks.map((b: any) => ({ id: ids.get(b.block_key)!, blockKey: b.block_key, kind: b.kind, textEn: b.text_en })),
      rules: s.rules.map((r: any, i: number) => ({ id: sid(5100 + i), ruleKind: r.rule_kind, triggerKind: r.trigger_kind, direction: r.direction, priority: r.priority,
        ...(r.min_severity ? { minSeverity: r.min_severity } : {}), blockId: ids.get(r.block_key)!, blockKind: r.rule_kind })),
      mappings: [],
    };
    const env = { denyTerms: GLOBAL_DENY.map((term) => ({ term })), inactiveTestIds: new Set<string>(), inactiveAnalyteIds: new Set<string>() };
    const r = validateLibrary(lib, env);
    expect(r.errors.map((i) => i.code)).toEqual(['no_mappings']);
    expect(r.warnings).toEqual([]);
    expect(validateLibrary({ ...lib, mappings: [{ id: sid(5200), analyteId: sid(5201), groupCode: 'blood_counts' }] }, env).valid).toBe(true);
  });
});
