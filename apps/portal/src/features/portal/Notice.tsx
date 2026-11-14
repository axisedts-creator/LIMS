import type { ReactNode } from 'react';

// Server-safe banner: @lims/ui Banner imports react-aria Button (client-only context), so the portal's
// server-rendered pages reuse its CSS classes with plain markup. Tone is also conveyed in text, not colour alone.
const TONE_TEXT = { success: 'Success', warning: 'Warning', info: 'Information', neutral: 'Note' } as const;

export function Notice({ tone, title, children }: { tone: keyof typeof TONE_TEXT; title: string; children?: ReactNode }) {
  return (
    <div className={`lims-banner lims-tone-${tone} portal-notice`} data-tone={tone}>
      <div className="lims-banner-text">
        <p className="lims-banner-title">
          <span className="portal-sr">{TONE_TEXT[tone]}: </span>
          {title}
        </p>
        {children ? <div className="lims-banner-body">{children}</div> : null}
      </div>
    </div>
  );
}
