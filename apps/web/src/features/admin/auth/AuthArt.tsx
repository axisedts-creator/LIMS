// WEB-STYLE-4 (LD-213): inline SVG art for the auth screens. Presentation only; every svg is decoration (aria-hidden).
// CSP img-src 'self' data: allows no remote image, so the art is drawn here. Colours come from currentColor or CSS
// variables only (LD-140); the one lime highlight is styled in shell.css via the accent class below.
import type { ReactNode } from 'react';

/** Lab path line art: sample tube rack, microscope, report sheet with a tick and a barcode. No text, no real brand. */
export function AuthArt() {
  return (
    <svg className="lims-art" viewBox="0 0 320 190" aria-hidden="true" focusable="false">
      <g fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 172H312" />
        <path d="M28 96h20v44a10 10 0 0 1-20 0zM56 96h20v44a10 10 0 0 1-20 0zM84 96h20v44a10 10 0 0 1-20 0z" />
        <path d="M30 122h16M58 112h16M86 126h16" />
        <rect x="20" y="132" width="92" height="8" rx="4" />
        <path d="M30 140v32M102 140v32" />
        <rect x="132" y="158" width="76" height="14" rx="4" />
        <path d="M192 158C214 148 218 100 192 76" />
        <rect x="150" y="48" width="20" height="56" rx="5" transform="rotate(-24 160 76)" />
        <path d="M146 134h44M168 134v24M150 116l-8 12" />
        <rect x="226" y="30" width="76" height="130" rx="6" />
        <path d="M282 30v20h20" />
        <path d="M238 70h36M238 82h52" />
        <path d="M238 144v-14M244 144v-14M248 144v-14M256 144v-14M262 144v-14M266 144v-14M274 144v-14M280 144v-14M284 144v-14M292 144v-14" />
        <path className="lims-art-accent" d="M238 108l9 9 19-20" />
      </g>
    </svg>
  );
}

/** Abstract placeholder mark (ring + diamond) until a real logo exists. */
export function AuthMark() {
  return (
    <svg className="lims-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="13" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <path d="M16 8l8 8-8 8-8-8z" fill="currentColor" stroke="none" />
    </svg>
  );
}

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
