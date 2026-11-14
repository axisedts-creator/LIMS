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
  'core.nav.group.front_desk': 'Front desk',
  'core.nav.group.lab': 'Lab',
  'core.nav.group.reports': 'Reports',
  'core.nav.group.accounts': 'Accounts',
  'core.nav.group.catalog': 'Catalog',
  'core.nav.group.instruments': 'Instruments',
  'core.nav.group.people_access': 'People & access',
  'core.nav.group.settings': 'Settings',
  'core.nav.collapse': 'Collapse navigation',
  'core.nav.expand': 'Expand navigation',
  'core.shell.search_label': 'Search patients and samples',
  'core.shell.search_placeholder': 'Search name · lab code · mobile · patient id · barcode',
  'core.shell.search_hint': 'Ctrl+K',
  'core.shell.search_results': 'Search results',
  'core.shell.search_none': 'No results',
  'core.shell.search_failed': 'Search failed. Try again.',
  'core.shell.centre': 'Centre',
  'core.shell.centre_none': 'Select centre',
};

export function t(key: string): string {
  return en[key] ?? key;
}
