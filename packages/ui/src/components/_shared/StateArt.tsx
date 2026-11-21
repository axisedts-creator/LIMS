// T0D-UIKIT-2 (LD-436 R16, done_when 4): one small illustration per calm state, drawn in code from the tokens.
// Stroke only (accent + neutral), aria-hidden, no stock picture, no animation.
import type { ReactNode } from 'react';

const A = 'var(--lims-accent)';
const N = 'var(--lims-neutral-300)';
const S = 'var(--lims-accent-subtle)';

export type StateArtKind = 'empty' | 'error' | 'not-available';

const ART: Record<StateArtKind, ReactNode> = {
  // an open tray with nothing in it
  empty: (
    <>
      <path d="M12 30h40l-6 -12H18z" stroke={N} />
      <path d="M12 30v16h40V30" stroke={N} />
      <path d="M24 38h16" stroke={A} />
      <circle cx="32" cy="12" r="3" stroke={S} />
    </>
  ),
  // a sheet with a broken line and a warning mark
  error: (
    <>
      <rect x="16" y="10" width="32" height="40" rx="4" stroke={N} />
      <path d="M22 20h12M22 27h8" stroke={N} />
      <path d="M32 34l7 12H25z" stroke={A} />
      <path d="M32 39v3" stroke={A} />
    </>
  ),
  // a box with a clock: being built, comes later
  'not-available': (
    <>
      <rect x="12" y="18" width="28" height="28" rx="4" stroke={N} />
      <path d="M12 26h28" stroke={N} />
      <circle cx="44" cy="40" r="10" stroke={A} />
      <path d="M44 35v5l3 2" stroke={A} />
    </>
  ),
};

export function StateArt({ kind }: { kind: StateArtKind }) {
  return (
    <svg
      className="lims-state-art"
      data-art={kind}
      aria-hidden="true"
      focusable="false"
      width={64}
      height={64}
      viewBox="0 0 64 64"
      fill="none"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ART[kind]}
    </svg>
  );
}
