'use client';
// Error notice for the report drawer, the reopen dialog and the version viewer (04-UI-UX §10; 03-APP-FLOW §4.6 step 5). LD-140 (2026-11-13): kit components only.
// The raw problem code and the server title are never shown: unknown codes get the generic text. `auth.mfa_required` belongs to the shell (nothing is shown here).
// Conflict-type refusals offer Reload, which refreshes the page (the page is the only source of the culture's state). role="alert" so the message is announced.
import { useRouter } from 'next/navigation';
import { Banner } from '@lims/ui/components/Banner';
import { failText, type Fail } from '../common';

const COPY: Record<string, string> = {
  'micro.report_incomplete': 'Some required information is missing. See the highlighted items.',
  'micro.ast_standard_required': 'Choose the standard and version for this category.',
  'micro.amendment_reason_required': 'Choose a reason for the amendment.',
  'lab.result_locked': 'Only a pathologist can submit a change to an approved result.',
  'lab.result_invalid_transition': 'The lab has cancelled or changed this test. Reload the culture.',
  'lab.module_result_stale': 'A newer report version already exists. Reload the culture.',
  'lab.module_result_invalid': 'The lab did not accept this report (for example, the amendment reason is not valid). Check the reason and try again.',
  'common.not_found': 'This report version was not found.',
};
const RELOAD = new Set(['common.version_conflict', 'common.precondition_required', 'micro.culture_invalid_transition', 'lab.module_result_stale', 'lab.result_invalid_transition']);

export const reportFailText = (f: Fail) => COPY[f.code] ?? failText(f);

export function ReportNotice({ fail }: { fail: Fail | undefined }) {
  const router = useRouter();
  if (!fail || fail.code === 'auth.mfa_required') return null;
  return (
    <div role="alert">
      <Banner tone="danger" title={reportFailText(fail)} {...(RELOAD.has(fail.code) ? { action: { label: 'Reload', onPress: () => router.refresh() } } : {})} />
    </div>
  );
}
