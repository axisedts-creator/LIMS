// Default adapter (LIMS_SMARTREPORT_LLM_ADAPTER=disabled): rejects, performs no network IO. Never echoes input.
import { LimsError } from '../../../core/errors.js';
import type { LlmRephraseInput, LlmRephraseOutput, LlmRephraser } from './LlmRephraser.js';

export class DisabledRephraser implements LlmRephraser {
  rephrase(_input: LlmRephraseInput, _opts: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<LlmRephraseOutput> {
    return Promise.reject(new LimsError('smartreport.feature_disabled'));
  }
}
