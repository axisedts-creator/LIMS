import { useState, type ReactNode, type SyntheticEvent } from 'react';
import { Button } from '../Button/Button';
import { msg } from '../_shared/messages';

const C0 = ['NUL', 'SOH', 'STX', 'ETX', 'EOT', 'ENQ', 'ACK', 'BEL', 'BS', 'HT', 'LF', 'VT', 'FF', 'CR', 'SO', 'SI', 'DLE', 'DC1', 'DC2', 'DC3', 'DC4', 'NAK', 'SYN', 'ETB', 'CAN', 'EM', 'SUB', 'ESC', 'FS', 'GS', 'RS', 'US'];

/** Control characters -> text badges (<STX>); \t and \n stay; \r becomes <CR> plus a line break (HL7 segment ends). */
function withBadges(value: string): ReactNode[] {
  const out: ReactNode[] = [];
  let buf = '';
  for (const ch of value) {
    const c = ch.charCodeAt(0);
    if ((c < 0x20 && ch !== '\t' && ch !== '\n') || c === 0x7f) {
      if (buf) out.push(buf);
      buf = '';
      out.push(
        <span key={out.length} className="lims-ctrl">
          {`<${c === 0x7f ? 'DEL' : C0[c]}>`}
        </span>,
      );
      if (ch === '\r') out.push('\n');
    } else buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

export interface CodeBlockProps {
  value: string;
  /** Accessible name of the region. */
  label: string;
  renderControlChars?: boolean;
  /** Default true. false: no Copy button and copy/cut from the block is blocked. */
  allowCopy?: boolean;
  caption?: string;
  'data-testid'?: string;
}

/** Verbatim monospace text (C7 raw messages, agent logs). Content is text nodes only (REQ-SEC-088). */
export function CodeBlock({ value, label, renderControlChars = false, allowCopy = true, caption, ...rest }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const block = (e: SyntheticEvent) => {
    if (!allowCopy) e.preventDefault();
  };
  return (
    <div className="lims-codeblock" {...rest}>
      <div role="region" aria-label={label} tabIndex={0} className="lims-codeblock-body" onCopy={block} onCut={block}>
        <pre className="lims-mono">{renderControlChars ? withBadges(value) : value}</pre>
      </div>
      {caption ? <p className="lims-description">{caption}</p> : null}
      {allowCopy ? (
        <Button
          size="sm"
          onPress={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? msg.copied : msg.copy}
        </Button>
      ) : null}
    </div>
  );
}
