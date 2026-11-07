// UI hint only — the API enforces (AC-0D-7.1). Matches a pathname to its staff_web route from routes.yaml.
import { staffRoutes } from '../nav/generated';
import type { StaffRoute } from '../nav/types';

const toRegex = (path: string) =>
  new RegExp(`^${path.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\\?\{[a-z_]+\\?\}/g, '[^/]+')}/?$`);
const compiled = staffRoutes.map((r) => ({ r, re: toRegex(r.path) }));

export function matchStaffRoute(pathname: string): StaffRoute | undefined {
  return compiled.find((c) => c.re.test(pathname))?.r;
}

export const hasPermission = (permissions: readonly string[], code: string) => permissions.includes(code);
