'use client';
// T0D-PARTYSET-1 (LD-321, 07-SECURITY): masked PAN and National ID number. Every read shows the value masked (last four characters); "Show" asks the
// server (revealPartyIdNumber, partners.party_id_number.read, audited by the server on every call) and keeps the full value in this component's state
// only: never in storage, the URL, the title or an attribute, and nothing is cached between presses. "Hide", leaving the tab or any refresh masks it again.
import { useId, useRef, useState } from 'react';
import { Button } from '@lims/ui/components/Button';
import { t } from '@/core/i18n/messages';
import { revealPartyIdNumberAction } from '../server/partysetActions';

export const ID_READ = 'partners.party_id_number.read';
export type IdField = 'tax_number' | 'national_id_number';
export const idLabel = (field: IdField) => t(field === 'tax_number' ? 'partners.idnumber.pan' : 'partners.idnumber.national_id');

function revealError(status: number, code: string) {
  if (code === 'auth.mfa_required') return t('partners.idnumber.mfa_required');
  if (status === 403) return t('partners.idnumber.reason.read');
  if (status === 404) return t('partners.idnumber.not_found');
  return t('partners.idnumber.failed');
}

/** The reveal state of one field and its Show / Hide button (disabled with the visible reason without the permission). */
export function useReveal(partyKind: string, partyId: string, field: IdField, permissions: readonly string[]) {
  const allowed = permissions.includes(ID_READ);
  const [full, setFull] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const reasonId = useId();
  const label = idLabel(field);

  const show = async () => {
    if (!allowed || running.current) return;
    running.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const r = await revealPartyIdNumberAction(partyKind, partyId, field);
      if (r.ok) setFull(r.value);
      else setError(revealError(r.status, r.code));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const button = full !== undefined ? (
    <Button size="sm" variant="ghost" onPress={() => setFull(undefined)}>{`${t('partners.idnumber.hide')} ${label}`}</Button>
  ) : allowed ? (
    <Button size="sm" variant="ghost" isLoading={busy} onPress={() => void show()}>{`${t('partners.idnumber.show')} ${label}`}</Button>
  ) : (
    <Button size="sm" variant="ghost" isDisabled ref={(el) => el?.setAttribute('aria-describedby', reasonId)}>{`${t('partners.idnumber.show')} ${label}`}</Button>
  );
  const notes = (
    <>
      {allowed ? null : <span id={reasonId} className="lims-description">{t('partners.idnumber.reason.read')}</span>}
      {error ? <span role="alert" className="lims-error">{error}</span> : null}
    </>
  );
  return { full, button, notes };
}

/** One masked value with its button (partner Overview). A party without the field shows a dash and no button. */
export function MaskedId({ partyKind, partyId, field, masked, permissions }: { partyKind: string; partyId: string; field: IdField; masked: string | undefined; permissions: readonly string[] }) {
  const r = useReveal(partyKind, partyId, field, permissions);
  if (!masked) return <span>—</span>;
  return (
    <span className="lims-inline">
      <span className="lims-mono">{r.full ?? masked}</span>
      {r.button}
      {r.notes}
    </span>
  );
}
