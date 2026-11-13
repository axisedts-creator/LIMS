// C14.T29 — SR-02 Phase 3 LLM panel. Fallback layout until TextDiff (CR-C14-008) ships in @lims/ui.
// Text nodes only (REQ-SEC-088/089); a failed item shows the approved template text + "Kept original" + failure codes, never the rejected model output (AB-11).
import { Badge } from '@lims/ui/components/Badge';
import { Card } from '@lims/ui/components/Card';

export interface LlmRunItem {
  item_ref: string;
  template_text: string;
  output_text?: string | null;
  passed: boolean;
  failure_codes: string[];
}
export interface LlmRun {
  items: LlmRunItem[];
  [k: string]: unknown;
}

export function LlmPanel({ run, language = 'en' }: { run: LlmRun; language?: 'en' | 'ne' }) {
  const lang = language === 'ne' ? 'ne' : undefined;
  return (
    <ul aria-label="AI-rephrased wording">
      {run.items.map((item) => (
        <li key={item.item_ref}>
          <Card>
            <div>
              <p>Approved template text</p>
              <p lang={lang}>{item.template_text}</p>
            </div>
            {item.passed && item.output_text ? (
              <div>
                <p>AI-rephrased text</p>
                <p lang={lang}>{item.output_text}</p>
              </div>
            ) : (
              <div>
                <Badge tone="warning">Kept original</Badge>{' '}
                {item.failure_codes.map((c) => (
                  <code key={c}>{c} </code>
                ))}
              </div>
            )}
          </Card>
        </li>
      ))}
    </ul>
  );
}
