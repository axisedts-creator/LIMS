// Sidebar groups (LD-251, spec/program/13-M-SERIES.md s3): the 14 NavGroups of C0 04-UI-UX s3, in this order.
// Replaces the 8-heading fold of 10-DESIGN-SYSTEM s3 / LD-140. `platform` only appears in the platform shell.
import { NAV_GROUPS, type NavGroup } from './types';

export const RAIL_GROUPS: readonly { id: NavGroup; labelKey: string }[] = NAV_GROUPS.map((id) => ({ id, labelKey: `core.nav.group.${id}` }));
