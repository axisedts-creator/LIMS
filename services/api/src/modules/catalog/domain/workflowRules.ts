// C3 T-06 — workflow-type rule table (PRD AC-02.3–AC-02.5; 02-TRD §5.1 Test.workflow_type). Consumed by publish (T-07) and the health report.

export const WORKFLOW_TYPES = ['standard', 'narrative', 'microbiology', 'anatomic', 'molecular', 'attachment', 'outsourced'] as const;
export type WorkflowType = (typeof WORKFLOW_TYPES)[number];

const RULES = new Map<string, { required?: 'narrative' | 'attachment'; singleNarrative: boolean }>([
  ['standard', { singleNarrative: false }],
  ['narrative', { required: 'narrative', singleNarrative: true }],
  ['microbiology', { required: 'narrative', singleNarrative: true }],
  ['anatomic', { required: 'narrative', singleNarrative: true }],
  ['molecular', { required: 'narrative', singleNarrative: true }],
  ['attachment', { required: 'attachment', singleNarrative: false }],
  ['outsourced', { singleNarrative: false }],
]);

function rule(workflowType: string) {
  const r = RULES.get(workflowType);
  if (!r) throw new Error('unknown workflow_type');
  return r;
}

export const isWorkflowType = (v: unknown): v is WorkflowType => typeof v === 'string' && RULES.has(v);
export const requiredAnalyteResultType = (workflowType: string): 'narrative' | 'attachment' | undefined => rule(workflowType).required;
export const allowsSingleNarrativeOnly = (workflowType: string): boolean => rule(workflowType).singleNarrative;
