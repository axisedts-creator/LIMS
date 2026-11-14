// C3 T-06 — workflow-type rules (domain/workflowRules.ts). Spec: PRD AC-02.3 (workflow_type microbiology/anatomic/molecular/narrative: at most ONE
// active reportable analyte of result type `narrative`), AC-02.4 (such a test with NO published narrative analyte is reported as
// `tests_missing_required_analyte`), AC-02.5 (workflow_type `attachment` with no published `attachment` analyte is reported too); 02-TRD §5.1
// `Test.workflow_type` enum (7 values, 03-IC §4.2). Standard and outsourced tests have no such requirement.
// This task owns the RULE TABLE only; the publish-time check (AC-02.3 400 /result_type) is T-07 and the health-report query (AC-02.4/02.5) is the
// health-report task — both must consume these functions rather than re-declaring the sets (that is why the table is pinned here).
// Interface expected from the writer — SEAMS:
//   export const WORKFLOW_TYPES: readonly string[]                                   the 7 values, in the TRD order
//   export function requiredAnalyteResultType(workflowType: string): 'narrative' | 'attachment' | undefined
//   export function allowsSingleNarrativeOnly(workflowType: string): boolean          true for the four narrative-module types (max one narrative analyte)
//   Unknown workflow types throw (LimsError common.validation_failed is not required here; any thrown Error is fine) — never silently "no rule".
import { describe, expect, it } from 'vitest';
import { WORKFLOW_TYPES, allowsSingleNarrativeOnly, requiredAnalyteResultType } from '../workflowRules.js';

describe('workflow-type rules (AC-02.3 – AC-02.5)', () => {
  it('WORKFLOW_TYPES is exactly the TRD enum', () => {
    expect([...WORKFLOW_TYPES]).toEqual(['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced']);
  });

  it.each([
    ['standard', undefined, false], ['outsourced', undefined, false],
    ['narrative', 'narrative', true], ['microbiology', 'narrative', true], ['anatomic', 'narrative', true], ['molecular', 'narrative', true],
    ['attachment', 'attachment', false],
  ])('%s -> required analyte type %s, single-narrative rule %s', (wf, required, single) => {
    expect(requiredAnalyteResultType(wf as string)).toBe(required);
    expect(allowsSingleNarrativeOnly(wf as string)).toBe(single);
  });

  it.each([[''], ['Standard'], ['STANDARD'], ['std'], ['__proto__'], ['constructor'], [' narrative']])('unknown workflow type %j throws instead of meaning "no rule"', (wf) => {
    expect(() => requiredAnalyteResultType(wf)).toThrow();
    expect(() => allowsSingleNarrativeOnly(wf)).toThrow();
  });
});
