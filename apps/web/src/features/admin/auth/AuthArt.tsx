// WEB-STYLE-4 (LD-213): inline SVG icons for the auth screens. Presentation only; every svg is decoration (aria-hidden).
// T0D-MSERIES-5 (LD-276): the line art and the placeholder mark are gone (board M1-entry hero replaces them).
import type { ReactNode } from 'react';

const ICONS: Record<'mail' | 'lock' | 'shield' | 'arrow', ReactNode> = {
  'mail': (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2.5" />
      <path d="M4 7.5l8 6 8-6" />
    </>
  ),
  'lock': (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  'shield': (
    <>
      <path d="M12 3l7.5 3v5.5c0 4.5-3.2 7.8-7.5 9.5-4.3-1.7-7.5-5-7.5-9.5V6z" />
      <path d="M8.8 12l2.4 2.4 4-4.4" />
    </>
  ),
  'arrow': <path d="M5 12h14M13 6l6 6-6 6" />,
};

/** Field and button icons; decorative, so the field label and the button text stay the accessible names. */
export function AuthIcon({ kind, className }: { kind: 'mail' | 'lock' | 'shield' | 'arrow'; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      {ICONS[kind]}
    </svg>
  );
}
