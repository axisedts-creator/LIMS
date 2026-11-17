// 03-APP-FLOW §6: after sign-in only a known partner route is honoured; anything else -> '/'. Shared by the login page and loginPartnerAction.
const KNOWN_ROOTS = new Set(['manifests', 'orders', 'reports', 'users', 'account']); // 04-UI-UX §2 route list

export function safeNext(raw: unknown): string {
  if (typeof raw !== 'string' || !/^\/[A-Za-z0-9\-._~/]{0,511}$/.test(raw) || raw.startsWith('//')) return '/';
  const segs = raw.split('/').slice(1);
  if (segs.some((s) => s === '..' || s === '.')) return '/';
  return KNOWN_ROOTS.has(segs[0] ?? '') ? raw : '/';
}
