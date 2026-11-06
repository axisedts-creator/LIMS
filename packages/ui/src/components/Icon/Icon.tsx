// Inline SVG icons (no icon font, no network). Always decorative: the owning control carries the text.
const PATHS = {
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M5 12l5 5L20 7',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 100 18 9 9 0 000-18z',
  warning: 'M12 4l9 16H3L12 4zM12 10v4M12 17h.01',
  danger: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9 9l6 6M15 9l-6 6',
  critical: 'M12 2l10 18H2L12 2zM12 9v5M12 17h.01',
  'chevron-down': 'M6 9l6 6 6-6',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  help: 'M12 3a9 9 0 100 18 9 9 0 000-18zM9.5 9.5a2.5 2.5 0 115 0c0 2-2.5 2-2.5 4M12 17h.01',
  plus: 'M12 5v14M5 12h14',
  menu: 'M4 6h16M4 12h16M4 18h16',
  empty: 'M4 7h16v12H4zM4 7l3-3h10l3 3',
  spinner: 'M12 3a9 9 0 109 9',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `lims-icon ${className}` : 'lims-icon'}
    >
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}
