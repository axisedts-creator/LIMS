import { t } from '../i18n/messages';

export function PermissionDenied() {
  return (
    <section data-testid="permission-denied" role="alert">
      <h1>{t('core.permission_denied.title')}</h1>
      <p>{t('core.permission_denied.body')}</p>
    </section>
  );
}

export function NotFound() {
  return (
    <section data-testid="not-found">
      <h1>{t('core.not_found.title')}</h1>
    </section>
  );
}
