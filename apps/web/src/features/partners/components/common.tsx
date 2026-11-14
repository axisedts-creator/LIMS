'use client';
// Shared pieces of the staff partner screens: status chips (word + tone), reason sets, staff-language failure texts, notices, URL filters.
// Every status shows a word (04-UI-UX §9); codes are mapped to staff texts here and never shown raw.
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { EmptyState } from '@lims/ui/components/EmptyState';
import { ErrorState } from '@lims/ui/components/ErrorState';
import { StatusChip } from '@lims/ui/components/StatusChip';
import type { Option } from '../server/types';
export { Ad, hasPerm, humanize } from '@/features/billing/components/format';

type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
const CHIPS: Record<string, readonly [Tone, string]> = {
  active: ['success', 'Active'], suspended: ['warning', 'Suspended'], invited: ['info', 'Invited'], deactivated: ['neutral', 'Deactivated'],
  draft: ['neutral', 'Draft'], submitted: ['info', 'Submitted'], partially_received: ['warning', 'Partly received'], received: ['success', 'Received'],
  withdrawn: ['neutral', 'Withdrawn'], discarded: ['neutral', 'Discarded'], cancelled: ['neutral', 'Cancelled'],
  converting: ['info', 'Registering'], converted: ['success', 'Registered'], conversion_failed: ['warning', 'Needs attention'], not_received: ['danger', 'Not received'],
  requested: ['info', 'Requested'], scheduled: ['info', 'Scheduled'], picked_up: ['success', 'Picked up'], rejected: ['danger', 'Rejected'],
  unmapped: ['warning', 'Not confirmed'], mapped: ['success', 'Confirmed'],
};
export const Chip = ({ code }: { code: string }) => {
  const [tone, label] = CHIPS[code] ?? (['neutral', code.replace(/_/g, ' ')] as const);
  return <StatusChip kind="generic" status={code} tone={tone} label={label} />;
};

const seed = (rows: readonly (readonly [string, string])[]): Option[] => rows.map(([code, display]) => ({ code, display, isActive: true }));
/** 05-SCHEMA §7 seed display texts. There is no partners coded-set endpoint (partners.yaml), so the sets are constants here. */
export const REASONS = {
  line_not_received_reasons: seed([['sample_missing', 'Sample missing'], ['label_unreadable', 'Label unreadable'], ['wrong_container', 'Wrong container'], ['leaked_or_broken', 'Leaked or broken'], ['test_not_available', 'Test not available']]),
  pickup_reject_reasons: seed([['outside_service_area', 'Outside service area'], ['no_rider_available', 'No rider available'], ['window_too_short', 'Window too short']]),
  partner_suspend_reasons: seed([['credit_hold', 'Credit hold'], ['agreement_ended', 'Agreement ended'], ['security_concern', 'Security concern']]),
  partner_user_deactivate_reasons: seed([['left_organisation', 'Left organisation'], ['role_changed', 'Role changed'], ['security_concern', 'Security concern']]),
  referrer_mapping_reject_reasons: seed([['not_identifiable', 'Cannot identify this doctor'], ['duplicate_entry', 'Duplicate entry']]),
} as const;

/** 04-UI-UX §4: the six staff failure texts of a line that did not become an order. */
const FAILURE: Record<string, string> = {
  'frontdesk.patient_duplicate_suspected': 'A patient with similar details already exists.',
  'frontdesk.consent_required': 'Consent details are missing for this patient.',
  'catalog.test_inactive': 'A test on this sample is no longer offered.',
  'catalog.no_price': 'A test has no price for this partner.',
  'partners.referrer_not_mapped': 'The referring doctor has not been confirmed.',
};
export const failureText = (code?: string) => (code ? FAILURE[code] : undefined) ?? 'Registration did not complete.';

const ERRORS: Record<string, string> = {
  'common.version_conflict': 'This was changed by someone else. Reload the page and try again.',
  'common.not_found': 'This item was not found. It may have been removed, or it is not available to you.',
  'auth.forbidden': 'You do not have permission for this action.',
  'auth.mfa_required': 'This action needs a second sign-in step. Complete multi-factor verification in your profile, then try again.',
  'partners.code_duplicate': 'A partner with this code already exists.',
  'partners.credit_party_in_use': 'This credit party is already linked to another partner.',
  'partners.credit_party_inactive': 'This credit party is not active.',
  'identity.centre_inactive': 'This receiving centre is not active.',
  'identity.user_exists': 'A user with this email address already exists.',
  'partners.last_partner_admin': 'A partner needs at least one active administrator. Add another administrator first.',
  'partners.manifest_invalid_transition': "This manifest can't be received in its current state. It may already have been received or changed. Refresh the page.",
  'partners.manifest_invalid': 'Some samples could not be received. Refresh the page and check each sample.',
  'partners.manifest_line_invalid_transition': 'This sample has already changed. Refresh the page and try again.',
  'partners.pickup_invalid_transition': 'This pickup request was changed by someone else. Refresh the page and try again.',
  'partners.referrer_doctor_inactive': 'This doctor is no longer active in the catalogue. Choose another doctor.',
};
/** Failure text for banners; unknown codes show only a generic sentence (no raw server codes or messages). */
export const errorText = (code: string, status?: number) => ERRORS[code] ?? (status === 403 ? ERRORS['auth.forbidden']! : status === 404 ? ERRORS['common.not_found']! : 'Something went wrong. Try again; if it keeps failing, contact support.');

export const PermissionNotice = () => <EmptyState title="You do not have permission to open this page." body="Ask an administrator if you need it." />;
/** Page-level failure of an action. */
export const Notice = ({ text }: { text: string }) => (
  <div role="alert">
    <Banner tone="danger" title={text} />
  </div>
);
/** Inside a Dialog: one alert line (client validation and server failures). */
export const DialogError = ({ text }: { text?: string | undefined }) => (text ? <p role="alert" className="lims-error">{text}</p> : null);
export function LoadFailed({ title = 'This list could not be loaded.' }: { title?: string }) {
  const router = useRouter();
  return (
    <div role="alert">
      <Banner tone="danger" title={title} action={{ label: 'Try again', onPress: () => router.refresh() }} />
    </div>
  );
}

export function PartnersError({ digest, reset }: { digest?: string | undefined; reset: () => void }) {
  return (
    <ErrorState
      title="Something went wrong"
      body="This page could not be loaded. Try again; if it keeps failing, contact support with the reference."
      {...(digest ? { requestId: digest } : {})}
      onRetry={reset}
    />
  );
}

/** Filters live in the URL (the page reads them server-side). Empty values are removed. */
export function useUrlFilters() {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (changes: Record<string, string | undefined>) => {
    const p = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) (v ? p.set(k, v) : p.delete(k));
    router.replace(p.size ? `${path}?${p}` : path);
  };
}

export const orderHref = (orderId: string) => `/frontdesk/orders/${orderId}`; // staff.frontdesk.order
