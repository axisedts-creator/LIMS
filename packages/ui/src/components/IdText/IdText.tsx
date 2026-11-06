import { useState } from 'react';
import { IconButton } from '../IconButton/IconButton';
import { msg } from '../_shared/messages';

export interface IdTextProps {
  value: string;
  /** Default 8. */
  truncate?: number;
  copyable?: boolean;
  'data-testid'?: string;
}

/** Mono id (UUIDs, invoice numbers). Never for barcodes in logs. Full value stays in `title`. */
export function IdText({ value, truncate = 8, copyable = false, ...rest }: IdTextProps) {
  const [copied, setCopied] = useState(false);
  const short = value.length > truncate ? `${value.slice(0, truncate)}…` : value;
  return (
    <span className="lims-id" {...rest}>
      <span className="lims-mono" title={value}>
        {short}
      </span>
      {copyable ? (
        <IconButton
          label={copied ? `${msg.copy}: done` : msg.copy}
          icon={copied ? 'check' : 'copy'}
          onPress={() => {
            void navigator.clipboard?.writeText(value).then(() => setCopied(true), () => setCopied(false));
          }}
        />
      ) : null}
    </span>
  );
}
