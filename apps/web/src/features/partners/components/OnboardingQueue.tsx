'use client';
// T0D-PARTYSET-1 (LD-321, LD-353 template 1 LIST): ElabAssist franchise approval queue (Approve and Hold, plus Reject). Columns Party, Type, Requested By,
// Requested On, Status, Reason. The Status filter defaults to Pending; ?status= (empty) shows all. Pending rows: Approve, Hold, Reject; held rows:
// Approve, Reject; approved and rejected are final. Hold and Reject need a reason. The person who created the record cannot decide: the server answers
// 403, after which the row's buttons are disabled with the visible reason. [CONV] CONTRACT GAP (CR T0D-PARTYSET-1): PartyOnboarding has no creator
// field, so Requested By shows a dash and the rule can only be shown after the server's answer.
import { useId, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { FilterBar } from '@lims/ui/components/FilterBar';
import { PageHeader } from '@lims/ui/components/PageHeader';
import { useToast } from '@lims/ui/components/Toast';
import { t } from '@/core/i18n/messages';
import type { PartyOnboarding } from '../server/partyset.server';
import { decidePartyOnboardingAction, type PartysetResult } from '../server/partysetActions';
import { Ad, Notice } from './common';
import { ReasonDialog, Status, kindText } from './PartysetCommon';
import { Gated, SalesTable, failure, newKey, useOnce, useUrl, type Col } from './SalesCommon';

const STATUSES = ['pending', 'held', 'approved', 'rejected'] as const;
const statusText = (s: string) => t(`partners.onboarding.status.${s}`);
const ALL = 'all';

export function OnboardingQueue({ rows, status, failed, nextCursor }: { rows: readonly PartyOnboarding[]; status: string; failed?: string | undefined; nextCursor?: string | undefined }) {
  const url = useUrl();
  const toast = useToast();
  const once = useOnce();
  const reasonId = useId();
  const [blocked, setBlocked] = useState<ReadonlySet<string>>(new Set());
  const [banner, setBanner] = useState<string | 'conflict' | null>(null);
  const [asking, setAsking] = useState<{ row: PartyOnboarding; decision: 'hold' | 'reject' } | null>(null);
  const [busy, setBusy] = useState<string>();
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  /** ?status= (empty) means All, so the empty value is kept in the URL; no status = the default Pending. */
  const goStatus = (s: string | undefined) => {
    const p = new URLSearchParams(params.toString());
    p.delete('cursor');
    if (s === undefined) p.delete('status');
    else p.set('status', s);
    router.replace(p.size ? `${path}?${p}` : path);
  };

  /** One answer of the server, for Approve and for the reason dialog. */
  const settle = (row: PartyOnboarding, decision: string, r: PartysetResult) => {
    if (r.ok) {
      setBanner(null);
      toast.show({ tone: 'success', title: t(`partners.onboarding.done.${decision}`) });
      url.refresh();
    } else if (r.status === 403 && r.code === 'auth.forbidden') setBlocked((b) => new Set(b).add(row.id));
    else if (r.code === 'common.version_conflict') setBanner('conflict');
    else setBanner(failure(r, []).text ?? null);
  };
  const decide = (row: PartyOnboarding, decision: 'approve' | 'hold' | 'reject', reason?: string) =>
    decidePartyOnboardingAction(row.id, row.version, decision, reason, newKey());
  const approve = (row: PartyOnboarding) => once(async () => {
    setBusy(row.id);
    try { settle(row, 'approve', await decide(row, 'approve')); } finally { setBusy(undefined); }
  });

  const columns: Col<PartyOnboarding>[] = [
    { id: 'party', header: t('partners.onboarding.col.party'), isRowHeader: true, cell: (r) => r.party_name ?? '—' },
    { id: 'type', header: t('partners.onboarding.col.type'), cell: (r) => kindText(r.party_kind) },
    { id: 'by', header: t('partners.onboarding.col.requested_by'), cell: () => '—' },
    { id: 'on', header: t('partners.onboarding.col.requested_on'), cell: (r) => <Ad value={r.created_at} /> },
    { id: 'status', header: t('partners.onboarding.col.status'), cell: (r) => <Status code={r.status} label={statusText(r.status)} /> },
    { id: 'reason', header: t('partners.onboarding.col.reason'), cell: (r) => r.reason ?? '—' },
    {
      id: 'actions', header: t('partners.partyset.col.actions'),
      cell: (r) => {
        if (r.status !== 'pending' && r.status !== 'held') return null;
        const reason = blocked.has(r.id) ? reasonId : undefined;
        return (
          <span className="lims-inline">
            <Gated size="sm" variant="primary" reasonId={reason} isLoading={busy === r.id} onPress={() => void approve(r)}>{t('partners.onboarding.approve')}</Gated>
            {r.status === 'pending' ? <Gated size="sm" variant="ghost" reasonId={reason} onPress={() => setAsking({ row: r, decision: 'hold' })}>{t('partners.onboarding.hold')}</Gated> : null}
            <Gated size="sm" variant="ghost" reasonId={reason} onPress={() => setAsking({ row: r, decision: 'reject' })}>{t('partners.onboarding.reject')}</Gated>
          </span>
        );
      },
    },
  ];
  const options = [{ value: ALL, label: t('partners.onboarding.status.all') }, ...STATUSES.map((s) => ({ value: s, label: statusText(s) }))];
  const current = status === '' ? ALL : status;

  return (
    <section className="lims-stack">
      <PageHeader title={t('partners.nav.onboarding')} helpKey="partners.onboarding" />
      {banner === 'conflict' ? (
        <div role="alert"><Banner tone="warning" title={t('partners.onboarding.conflict')} action={{ label: t('partners.partyset.refresh'), onPress: url.refresh }} /></div>
      ) : banner ? <Notice text={banner} /> : null}
      {blocked.size ? <p id={reasonId} className="lims-description">{t('partners.onboarding.reason.creator')}</p> : null}
      <FilterBar
        filters={[{ id: 'status', label: t('partners.onboarding.filter.status'), kind: 'select', options }]}
        value={{ status: current }}
        onChange={(v) => { const s = typeof v['status'] === 'string' ? v['status'] : 'pending'; if (s !== current) goStatus(s === ALL ? '' : s); }}
        onReset={() => goStatus(undefined)}
      />
      <SalesTable caption={t('partners.onboarding.caption')} columns={columns} rows={rows} getRowId={(r) => r.id} failed={failed} nextCursor={nextCursor}
        empty={{ title: t('partners.onboarding.empty'), body: t('partners.onboarding.empty_hint') }} />
      {asking ? (
        <ReasonDialog
          title={`${t(`partners.onboarding.${asking.decision}_title`)}: ${asking.row.party_name ?? ''}`}
          confirm={t(`partners.onboarding.${asking.decision}`)}
          onClose={() => setAsking(null)}
          onDone={() => setAsking(null)}
          act={async (reason) => {
            const r = await decide(asking.row, asking.decision, reason);
            // a validation refusal stays in the dialog; everything else is shown on the page
            if (!r.ok && r.status === 422) return r;
            settle(asking.row, asking.decision, r);
            return { ok: true };
          }}
        />
      ) : null}
    </section>
  );
}
