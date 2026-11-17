// Default CbmsClient (US-BL-13.1, REQ-SEC-136): answers stub_recorded and nothing else, so a document can never look synced. Persists nothing itself; the service records the attempt.
import type { CbmsClient, CbmsSubmitInput, CbmsSubmitResult } from './CbmsClient.js';

export class RecordingStubCbmsClient implements CbmsClient {
  readonly mode = 'stub' as const;
  async submit(_input: CbmsSubmitInput): Promise<CbmsSubmitResult> {
    return { outcome: 'stub_recorded', rawStatusRedacted: 'stub' };
  }
}
