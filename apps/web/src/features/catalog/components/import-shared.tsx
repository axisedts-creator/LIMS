'use client';
// Shared bits of SCR-18 / SCR-19: status + kind labels, issue message catalog (04-UI-UX SCR-19: `catalog.import.issue.<code>`), error copy, kind permissions.
import type { ImportIssue, ImportKind, ImportStatus } from '../server/types';
import type { Fail, Tone } from './shared';

export const IMPORT_PERM = {
  priceListManage: 'catalog.price_list.manage',
  testManage: 'catalog.test.manage',
  referrerManage: 'catalog.referrer.manage',
  referrerExport: 'catalog.referrer.export',
  publish: 'catalog.reference_range.publish',
} as const;

/** 04-UI-UX SCR-18 / 08 A13 P-10: permission(s) the kind needs. Commit on catalog_master also needs the publish permission (AC-17.5, D-18). */
export const KIND_PERMS: Record<ImportKind, readonly string[]> = {
  price_list: [IMPORT_PERM.priceListManage],
  credit_parties: [IMPORT_PERM.priceListManage],
  catalog_master: [IMPORT_PERM.testManage],
  referrers: [IMPORT_PERM.referrerManage],
};
export const COMMIT_PERMS: Record<ImportKind, readonly string[]> = { ...KIND_PERMS, catalog_master: [IMPORT_PERM.testManage, IMPORT_PERM.publish] };
export const KIND_LABEL: Record<ImportKind, string> = { price_list: 'Price list prices', catalog_master: 'Catalog master', referrers: 'Doctors', credit_parties: 'Credit parties' };

export const IMPORT_STATUS_LABEL: Record<ImportStatus, string> = {
  uploaded: 'Uploaded', scanning: 'Security scan', validating: 'Validating', validated: 'Ready to commit', invalid: 'Invalid', quarantined: 'Quarantined',
  committing: 'Committing', committed: 'Committed', commit_failed: 'Commit failed', discarded: 'Discarded', expired: 'Expired', failed: 'Failed',
};
export const EXPORT_STATUS_LABEL: Record<string, string> = { queued: 'Queued', building: 'Building', ready: 'Ready', failed: 'Failed', expired: 'Expired' };

export const TRANSIENT: readonly ImportStatus[] = ['uploaded', 'scanning', 'validating', 'committing'];
export const isTransient = (s: ImportStatus) => TRANSIENT.includes(s);

/** Texts of the known issue codes (TRD §8.7 import issue codes). Templated ones (`{reason}`) are absent on purpose: the API text is shown. */
const ISSUE_TEXT: Record<string, string> = {
  'row.price_decimals': 'Price has more than 2 decimal places.',
  'row.price_invalid': 'Price is not a valid amount.',
  'row.price_change_large': 'Price changes by more than the usual limit. Check it before you commit.',
  'row.orderable_unknown': 'No test or panel with this code.',
  'row.orderable_inactive': 'This test or panel is inactive.',
  'row.kind_mismatch': 'The kind in this row does not match the item with this code.',
  'row.duplicate_code': 'This code appears more than once in the file.',
  'row.required_missing': 'A required value is missing.',
  'row.code_invalid': 'The code is not valid.',
  'row.reference_unknown': 'This row refers to something that does not exist.',
  'row.range_overlap': 'This reference range overlaps another one.',
  'row.panel_cycle': 'This panel would contain itself.',
  'row.phone_invalid': 'The phone number is not valid. Use international format, for example +9779801234567.',
  'row.email_invalid': 'The email address is not valid.',
  'file.stale_base': 'This price list has a newer version than the one you exported.',
  'file.draft_exists': 'An open draft already exists. Turn on "Replace open drafts" to discard it, then commit again.',
  'file.macro_present': 'The file contains macros and was not read.',
  'file.not_xlsx': 'The file is not a valid .xlsx workbook.',
  'file.external_links': 'The file contains links to other workbooks. Remove them and upload again.',
  'file.meta_missing': 'The file is missing its _meta sheet. Download a fresh template or export.',
  'file.meta_mismatch': 'The file was made for a different kind of import or price list.',
  'file.sheet_missing': 'A required sheet is missing from the file.',
  'file.header_mismatch': 'The column headings do not match the template.',
  'file.unknown_column': 'The file has a column that is not in the template.',
  'file.too_many_rows': 'The file has more rows than one import allows.',
  'file.too_many_issues': 'Too many problems were found; only the first ones are listed.',
  'file.parse_timeout': 'The file took too long to read. Split it into smaller files.',
  'file.zip_unsafe': 'The file structure is not safe and was not read.',
};
export const issueText = (i: ImportIssue) => ISSUE_TEXT[i.issue_code] ?? i.message;

const MESSAGE: Record<string, string> = {
  'common.payload_too_large': 'The file is larger than 15 MB.',
  'common.unsupported_media_type': 'Only Excel .xlsx files are accepted. Macro files (.xlsm) are not.',
  'common.rate_limited': 'Two imports are already running; try again shortly.',
  'auth.mfa_required': 'Verify your identity with your authenticator (two-step verification), then try again.',
  'auth.forbidden': 'You do not have permission to do this.',
  'catalog.import_stale_base': 'The price list changed after this file was exported. Tick the box to replace it anyway, or export again.',
  'catalog.import_not_committable': 'This import can no longer be committed. It was already committed, discarded or changed. Reload the page.',
  'common.version_conflict': 'This import changed while you were looking at it. Reload to see the latest version.',
  'common.precondition_required': 'Reload the page and try again.',
  'common.validation_failed': 'Check the values and try again.',
};
export const failText = (f: Fail) => MESSAGE[f.code] ?? 'Something went wrong. Try again.';

/**
 * role="alert" message. [CONV] The kit Banner prefixes a visually hidden tone word ("Error: …"); here the alert text must be exactly the
 * message (04-UI-UX SCR-18 copy), so this renders the Banner classes without the prefix. The text itself says what happened (never colour alone).
 */
export function ImportNotice({ tone, text }: { tone: Tone; text: string }) {
  return (
    <div role="alert" className={`lims-banner lims-tone-${tone}`} data-tone={tone}>
      <div className="lims-banner-text">
        <p className="lims-banner-title">{text}</p>
      </div>
    </div>
  );
}
