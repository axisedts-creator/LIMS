// Staff shell (02-TRD §12.1; LD-251, spec/program/13-M-SERIES.md s3): PageShell + top bar + 14-group sidebar + SessionTimeoutDialog.
// Nav entries come from the generated manifest (build-nav.ts) filtered by the actor's permissions (UI hint only — the API enforces;
// AC-0D-7.1), grouped by their NavGroup. A staff session never sees `platform`; a platform session sees only `platform`.
import type { ReactNode } from 'react';
import { t } from '../i18n/messages';
import { navEntries } from '../nav/generated';
import { ELAB_GROUPS, ELAB_PLACE, fallbackGroup } from '../nav/elab-menu';
import { RAIL_GROUPS } from '../nav/rail-groups';
import type { ResolvedNavEntry } from '../nav/types';
import { hasPermission } from '../permissions/routes';
import type { ShellSession } from '../session/types';
import { LOGO_ON_DARK } from './brand';
import type { Centre } from './CentreSwitcher';
import type { RailGroup } from './Rail';
import { SessionTimeoutDialog } from './SessionTimeoutDialog';
import { ShellFrame, type Crumb, type ShellNotice } from './ShellFrame';

/** Keeps each section in one run (its first entry's place), so a sub-heading prints once even when manifest orders tie
 *  across modules (micro and anatomic both use 60..63, spec-fixed). Stable: order within a section is unchanged. */
function bySection<T extends { section?: string }>(items: T[]): T[] {
  const first = new Map<string, number>();
  const key = (e: T, i: number) => e.section ?? `#${i}`; // unsectioned entries keep their own place
  items.forEach((e, i) => { if (!first.has(key(e, i))) first.set(key(e, i), i); });
  return items.map((e, i) => ({ e, i, at: first.get(key(e, i))! })).sort((a, b) => a.at - b.at || a.i - b.i).map((x) => x.e);
}

export type ShellCentres ={ options: readonly Centre[]; activeId: string | null };

type Props = {
  session: ShellSession;
  pathname: string;
  centres?: ShellCentres;
  /** optional count badge per entry id; a string (e.g. '50+', T0D-BUILD-5) draws as is, blank = none */
  counts?: Readonly<Record<string, number | string>>;
  /** entry ids shown with the "view only" tag */
  viewOnly?: readonly string[];
  /** bell items; omit when the session has no notification source */
  notifications?: readonly ShellNotice[];
  /** LD-340: 'elab' = ElabAssist menu (the staff layout); default 'modules' = the 14 module groups */
  menu?: 'modules' | 'elab';
  children: ReactNode;
};

const badgeOf = (counts: Props['counts'], id: string): number | string | undefined => {
  const v = counts && Object.hasOwn(counts, id) ? counts[id] : undefined;
  return typeof v === 'number' ? (Number.isFinite(v) ? v : undefined) : typeof v === 'string' && v.trim() ? v.trim() : undefined;
};

export function AppShell({ session, pathname, centres, counts, viewOnly, notifications, menu = 'modules', children }: Props) {
  const perms = session.actor.permissions;
  const platform = session.kind === 'platform';
  const toItem = (e: ResolvedNavEntry, section: string | undefined) => ({
    id: e.id,
    label: t(e.label),
    path: e.path,
    current: pathname === e.path,
    ...(e.icon ? { icon: e.icon } : {}),
    ...(e.chord ? { chord: e.chord } : {}),
    ...(section ? { section: t(section) } : {}),
    ...(e.createPath && e.createLabel && e.createPermission && hasPermission(perms, e.createPermission)
      ? { createPath: e.createPath, createLabel: t(e.createLabel) } : {}),
    ...(badgeOf(counts, e.id) !== undefined ? { badge: badgeOf(counts, e.id)! } : {}),
    ...(viewOnly?.includes(e.id) ? { viewOnly: true } : {}),
  });
  const permitted = navEntries.filter((e) => hasPermission(perms, e.permission));
  // LD-340: staff shell = the ElabAssist menu (core/nav/elab-menu.ts); the platform shell and menu="modules" keep the 14 module groups.
  const base: RailGroup[] = (menu === 'elab' && !platform
    ? ELAB_GROUPS.map((g) => ({
        id: g.id,
        label: t(g.labelKey),
        ...(g.direct ? { direct: true } : {}),
        items: permitted
          .filter((e) => e.group !== 'platform' && (ELAB_PLACE.get(e.id)?.group ?? fallbackGroup(e.group)) === g.id)
          .sort((a, b) => (ELAB_PLACE.get(a.id)?.pos ?? 1e6) - (ELAB_PLACE.get(b.id)?.pos ?? 1e6) || a.order - b.order || a.id.localeCompare(b.id))
          .map((e) => toItem(e, ELAB_PLACE.get(e.id)?.section ?? e.section)),
      }))
    : RAIL_GROUPS.filter((g) => (g.id === 'platform') === platform).map((g) => ({
        id: g.id,
        label: t(g.labelKey),
        items: permitted
          .filter((e) => e.group === g.id)
          .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          .map((e) => toItem(e, e.section)),
      })));
  const groups: RailGroup[] = base.filter((g) => g.items.length > 0).map((g) => ({ ...g, items: bySection(g.items) }));
  const active = groups.flatMap((g) => g.items.filter((e) => e.current).map((e) => ({ group: g.label, entry: e.label })))[0];
  const crumb: Crumb = active ?? null;
  const now = Date.now();
  return (
    <ShellFrame
      groups={groups}
      crumb={crumb}
      tenant={session.actor.tenantCode ?? ''}
      user={{ name: session.actor.displayName, role: session.actor.roles.join(', ').replace(/_/g, ' ') }}
      memberId={session.actor.membershipId}
      logoSrc={LOGO_ON_DARK}
      search={{ canPatients: hasPermission(perms, 'frontdesk.patient.read'), canSpecimens: hasPermission(perms, 'lab.specimen.read') }}
      centres={centres}
      notifications={notifications}
    >
      {children}
      <SessionTimeoutDialog
        idleMs={Date.parse(session.idleExpiresAt) - now}
        absoluteMs={Date.parse(session.absoluteExpiresAt) - now}
      />
    </ShellFrame>
  );
}
