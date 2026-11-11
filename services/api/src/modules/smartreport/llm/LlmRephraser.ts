// C14 TRD §4.11 — LLM fluency layer interface. Only the worker task smartreport.llm_rephrase calls it.
export interface LlmRephraseItem {
  readonly itemRef: string; // 'deranged:<resultId>' | 'advice:<blockId>' | 'followup:<ruleId>'
  readonly templateText: string; // approved block text, placeholders NOT filled
}
export interface LlmRephraseInput {
  readonly language: 'en' | 'ne';
  readonly promptTemplateVersion: 'p1';
  readonly items: readonly LlmRephraseItem[]; // ≤ 30
}
export interface LlmRephraseOutput {
  readonly items: readonly { readonly itemRef: string; readonly text: string }[];
  readonly modelRef: string; // configured label, LIMS_SMARTREPORT_LLM_MODEL_REF
}
export interface LlmRephraser {
  rephrase(
    input: LlmRephraseInput,
    opts: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<LlmRephraseOutput>;
}
