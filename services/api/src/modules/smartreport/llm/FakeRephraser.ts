// CI test double: echoes each template text back, records requests. No network.
import type { LlmRephraseInput, LlmRephraseOutput, LlmRephraser } from './LlmRephraser.js';

export class FakeRephraser implements LlmRephraser {
  readonly calls: { input: LlmRephraseInput; opts: { readonly timeoutMs: number; readonly signal: AbortSignal } }[] = [];

  rephrase(input: LlmRephraseInput, opts: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<LlmRephraseOutput> {
    this.calls.push({ input, opts });
    return Promise.resolve({
      items: input.items.map((i) => ({ itemRef: i.itemRef, text: i.templateText })),
      modelRef: 'fake-rephraser',
    });
  }
}
