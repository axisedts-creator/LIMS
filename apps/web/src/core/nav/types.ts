// 04-UI-UX §3 (nav manifest). RouteId / PermissionCode / ModuleName / IconName are plain strings here;
// build-nav.ts validates them against contracts/routes.yaml at build time.
export type RouteId = string;
export type PermissionCode = string;
export type ModuleName = string;
export type IconName = string;

export const NAV_GROUPS = [
  'front_desk', 'laboratory', 'reporting', 'billing', 'catalog', 'instruments', 'analytics',
  'quality', 'inventory', 'partners', 'engagement', 'home_collection', 'admin', 'platform',
] as const;
export type NavGroup = (typeof NAV_GROUPS)[number];

export interface NavEntry {
  readonly id: string;              // '<module>.<snake>' unique across all manifests
  readonly label: string;           // message key
  readonly routeId: RouteId;        // must exist in contracts/routes.yaml with origin staff_web and the same permission
  readonly permission: PermissionCode;
  readonly group: NavGroup;
  readonly order: number;           // ascending within group
  readonly icon?: IconName;
  readonly chord?: `g ${string}`;   // two-key navigation chord, unique across all manifests
  readonly phase?: '1' | '1.5' | '2' | '3';
}
export interface NavManifest { readonly module: ModuleName; readonly entries: readonly NavEntry[] }

/** Emitted by build-nav.ts into generated.ts. */
export interface ResolvedNavEntry extends NavEntry { readonly module: ModuleName; readonly path: string }
/** Every staff_web route from routes.yaml — the shell gates direct visits on `permission` (AC-0D-7.1). */
export interface StaffRoute { readonly id: RouteId; readonly path: string; readonly permission: PermissionCode }
