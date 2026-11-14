// C6-T02 version.ts: version kind (02-TRD §4.5 = 08 R1 four-step rule + rule 0 D-33 + D-61; AC-02.6, AC-02.8). Pure.
// Assumed API: versionKind({regeneration?, earlierReleased, sections, complete}), regenerationNote(code, text?), EXCLUDED_AMENDMENT_REASONS.
import { describe, expect, it } from 'vitest';
import { EXCLUDED_AMENDMENT_REASONS, regenerationNote, versionKind, type KindInput } from '../version.js';

const base: KindInput = { earlierReleased: false, sections: [], complete: true };
const k = (over: Partial<KindInput>) => versionKind({ ...base, ...over });

describe('rule 4: final / partial', () => {
  it('complete -> final', () => expect(k({})).toBe('final'));
  it('not complete -> partial', () => expect(k({ complete: false })).toBe('partial'));
  it('unamended lab/micro-final sections -> final', () => {
    expect(k({ sections: [{ kind: 'lab' }, { kind: 'micro', phase: 'final' }] })).toBe('final');
  });
});

describe('rule 1: amended', () => {
  it('amendment reason outside the exclusion set + earlier version released -> amended (AC-02.6)', () => {
    expect(k({ earlierReleased: true, sections: [{ kind: 'lab', amendmentReason: 'corrected_value' }] })).toBe('amended');
  });
  it('same reason but no earlier released version -> falls through', () => {
    expect(k({ earlierReleased: false, sections: [{ kind: 'lab', amendmentReason: 'corrected_value' }] })).toBe('final');
    expect(k({ earlierReleased: false, complete: false, sections: [{ kind: 'lab', amendmentReason: 'corrected_value' }] })).toBe('partial');
  });
  it('narrative amendment always counts, even with an excluded code (N5)', () => {
    expect(k({ earlierReleased: true, sections: [{ kind: 'narrative', amendmentReason: 'supplementary_report' }] })).toBe('amended');
  });
  it('amended wins over addendum and preliminary (first match)', () => {
    expect(k({ earlierReleased: true, sections: [
      { kind: 'anatomic', amendmentReason: 'supplementary_report' },
      { kind: 'lab', amendmentReason: 'corrected_value' },
      { kind: 'micro', phase: 'preliminary' },
    ] })).toBe('amended');
  });
});

describe('exclusion set (08 A17 D-61)', () => {
  it('is exactly module_phase_progression, module_preliminary_update, supplementary_report', () => {
    expect([...EXCLUDED_AMENDMENT_REASONS].sort()).toEqual(['module_phase_progression', 'module_preliminary_update', 'supplementary_report']);
  });
  it.each(['module_phase_progression', 'module_preliminary_update', 'supplementary_report'])('%s never yields amended', (r) => {
    expect(k({ earlierReleased: true, sections: [{ kind: 'micro', phase: 'final', amendmentReason: r }] })).not.toBe('amended');
  });
});

describe('rule 2: addendum', () => {
  it('supplementary_report -> addendum, with or without an earlier released version', () => {
    expect(k({ earlierReleased: true, sections: [{ kind: 'anatomic', amendmentReason: 'supplementary_report' }] })).toBe('addendum');
    expect(k({ earlierReleased: false, sections: [{ kind: 'anatomic', amendmentReason: 'supplementary_report' }] })).toBe('addendum');
  });
  it('addendum wins over preliminary', () => {
    expect(k({ earlierReleased: true, sections: [{ kind: 'anatomic', amendmentReason: 'supplementary_report' }, { kind: 'micro', phase: 'preliminary' }] })).toBe('addendum');
  });
});

describe('rule 3: preliminary (AC-02.8)', () => {
  it('micro preliminary -> preliminary', () => {
    expect(k({ sections: [{ kind: 'micro', phase: 'preliminary' }] })).toBe('preliminary');
  });
  it('preliminary replacing an approved preliminary (module_preliminary_update) -> preliminary, not amended', () => {
    expect(k({ earlierReleased: true, sections: [{ kind: 'micro', phase: 'preliminary', amendmentReason: 'module_preliminary_update' }] })).toBe('preliminary');
  });
  it('final replacing a preliminary (module_phase_progression) -> final', () => {
    expect(k({ earlierReleased: true, sections: [{ kind: 'micro', phase: 'final', amendmentReason: 'module_phase_progression' }] })).toBe('final');
  });
  it('preliminary wins over partial', () => {
    expect(k({ complete: false, sections: [{ kind: 'micro', phase: 'preliminary' }] })).toBe('preliminary');
  });
  it('phase on a non-micro section is ignored', () => {
    expect(k({ sections: [{ kind: 'anatomic', phase: 'preliminary' }] })).toBe('final');
  });
});

describe('rule 0: Regenerate (D-33)', () => {
  const regen = (reasonCode: string) => ({ reasonCode });
  it('after a release -> amended, whatever the sections say', () => {
    expect(k({ regeneration: regen('demographic_correction'), earlierReleased: true })).toBe('amended');
    expect(k({ regeneration: regen('template_correction'), earlierReleased: true, complete: false })).toBe('amended');
    expect(k({ regeneration: regen('other'), earlierReleased: true, sections: [{ kind: 'micro', phase: 'preliminary' }] })).toBe('amended');
  });
  it('smart_summary_added takes its kind from rules 1-4 (no changed section -> final)', () => {
    expect(k({ regeneration: regen('smart_summary_added'), earlierReleased: true })).toBe('final');
    expect(k({ regeneration: regen('smart_summary_added'), earlierReleased: true, complete: false })).toBe('partial');
    expect(k({ regeneration: regen('smart_summary_added'), earlierReleased: true, sections: [{ kind: 'lab', amendmentReason: 'corrected_value' }] })).toBe('amended');
  });
  it('no earlier released version -> rule 0 does not apply', () => {
    expect(k({ regeneration: regen('demographic_correction'), earlierReleased: false })).toBe('final');
  });
});

describe('regenerationNote (rule 0 amendment box)', () => {
  it('names the reason under "Report details"', () => {
    const n = regenerationNote('demographic_correction');
    expect(n.analyteOrSection).toBe('Report details');
    expect(n.reasonCode).toBe('demographic_correction');
    expect(n.reasonText).toBeUndefined();
  });
  it('carries reason_text when present', () => {
    expect(regenerationNote('other', 'Synthetic note').reasonText).toBe('Synthetic note');
  });
});
