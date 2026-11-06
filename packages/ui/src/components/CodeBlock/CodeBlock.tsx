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

/** C7 02-TRD:1093. */
export interface CodeBlockProps {
  /** Accessible name of the region. */
  label: string;
  text: string;
  renderControlChars?: boolean;
  /** Pixels; the region scrolls beyond this. */
  maxHeight?: number;
  /** true: pre-wrap; false (default): pre. */
  wrap?: boolean;
  /** Default false (PHI). false: no Copy button and copy/cut from the block is blocked. */
  allowCopy?: boolean;
  'data-testid'?: string;
}

/** Verbatim monospace text (C7 raw messages, agent logs). Content is text nodes only (REQ-SEC-088). */
export function CodeBlock({ label, text, renderControlChars = false, maxHeight, wrap = false, allowCopy = false, ...rest }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);
  const block = (e: SyntheticEvent) => {
    if (!allowCopy) e.preventDefault();
  };
  return (
    <div className="lims-codeblock" {...rest}>
      <div
        role="region"
        aria-label={label}
        tabIndex={0}
        className="lims-codeblock-body"
        style={maxHeight !== undefined && Number.isFinite(maxHeight) ? { maxHeight: `${maxHeight}px`, overflow: 'auto' } : undefined}
        onCopy={block}
        onCut={block}
      >
        <pre className="lims-mono" style={{ whiteSpace: wrap ? 'pre-wrap' : 'pre' }}>
          {renderControlChars ? withBadges(text) : text}
        </pre>
      </div>
      {allowCopy ? (
        <Button
          size="sm"
          onPress={() => {
            void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => setCopied(false));
          }}
        >
          {copied ? msg.copied : msg.copy}
        </Button>
      ) : null}
    </div>
  );
}
