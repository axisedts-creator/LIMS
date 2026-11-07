// Message catalogue (CV §13): keys '<m>.<screen>.<key>', en only in v1. Core keys live here; module catalogues
// are merged in by their owners. Unknown keys render as the key itself (visible, never blank).
const en: Record<string, string> = {
  'core.session.expiring': "You'll be signed out in 2 minutes because of inactivity.",
  'core.session.expiring_title': 'Still there?',
  'core.session.stay': 'Stay signed in',
  'core.session.sign_out': 'Sign out',
  'core.permission_denied.title': "You don't have access to this page",
  'core.permission_denied.body': 'Ask your administrator for the permission this page needs.',
  'core.not_found.title': 'Page not found',
  'core.shell.app_name': 'LIMS',
};

export function t(key: string): string {
  return en[key] ?? key;
}
