// Sidebar icons (LD-251, 13-M-SERIES s3: 20 px stroke icon). Decorative only (aria-hidden); the entry text is the name.
// Names are the manifest IconName values in use; an unknown or missing name falls back to a neutral dot.
// ponytail: a small path table, not an icon library (LD-251: no new UI dependency); add a path when a manifest names a new icon.
const PATHS: Record<string, string> = {
  table: 'M3 4h14v12H3zM3 8h14M3 12h14M8 4v12',
  inbox: 'M3 11l2-7h10l2 7v5H3zM3 11h4l1 2h4l1-2h4',
  settings: 'M10 7a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4',
  flask: 'M8 2h4M9 2v5l-5 9h12l-5-9V2',
  chart: 'M3 17h14M5 14V9M9 14V5M13 14v-7',
  users: 'M7 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 17c0-3 2-5 5-5s5 2 5 5M13 4a3 3 0 0 1 0 5M15 12c2 .5 3 2.5 3 5',
  'user-plus': 'M8 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 17c0-3 2.5-5 6-5s6 2 6 5M16 6v6M13 9h6',
  truck: 'M2 5h10v9H2zM12 8h3l3 3v3h-6M5 17a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM15 17a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  building: 'M4 18V3h8v15M12 8h4v10M2 18h16M7 6h2M7 9h2M7 12h2',
  check: 'M4 10l4 4 8-8',
  clock: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM10 6v4l3 2',
  download: 'M10 3v9M6 8l4 4 4-4M3 15v2h14v-2',
  calendar: 'M3 5h14v12H3zM3 9h14M7 3v4M13 3v4',
  desk: 'M2 8h16M4 8v9M16 8v9M7 4h6v4H7z',
  report: 'M5 2h7l4 4v12H5zM12 2v4h4M8 10h5M8 13h5',
  cash: 'M2 5h16v10H2zM10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  book: 'M4 3h10a2 2 0 0 1 2 2v12H6a2 2 0 0 1-2-2zM4 15a2 2 0 0 1 2-2h10',
  box: 'M10 2l7 4v8l-7 4-7-4V6zM3 6l7 4 7-4M10 10v8',
  chat: 'M3 4h14v9H8l-4 3v-3H3z',
  home: 'M3 9l7-6 7 6v8H3zM8 17v-5h4v5',
  shield: 'M10 2l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V5z',
  globe: 'M10 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16zM2 10h16M10 2c2.5 2.5 2.5 13.5 0 16M10 2c-2.5 2.5-2.5 13.5 0 16',
  dot: 'M10 8a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  chevron: 'M7 4l6 6-6 6',
  plus: 'M10 4v12M4 10h12',
  menu: 'M3 5h14M3 10h14M3 15h14',
  close: 'M5 5l10 10M15 5L5 15',
  bell: 'M5 14V9a5 5 0 0 1 10 0v5l2 2H3zM8 18h4',
};

/** One icon per sidebar group (13-M-SERIES s3: a closed group row shows its icon). */
export const GROUP_ICON: Record<string, string> = {
  front_desk: 'desk', laboratory: 'flask', reporting: 'report', billing: 'cash', catalog: 'book', instruments: 'inbox', analytics: 'chart',
  quality: 'check', inventory: 'box', partners: 'building', engagement: 'chat', home_collection: 'home', admin: 'shield', platform: 'globe',
  // LD-340 (ElabAssist menu groups, core/nav/elab-menu.ts)
  dashboard: 'chart', daily_work: 'desk', accounts: 'cash', reports: 'report', administration: 'shield', machine: 'inbox', other: 'dot',
};

export function NavIcon({ name, className }: { name?: string | undefined; className?: string }) {
  return (
    <svg className={className ?? 'lims-rail-icon'} aria-hidden="true" focusable="false" viewBox="0 0 20 20" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name ?? ''] ?? PATHS['dot']} />
    </svg>
  );
}
