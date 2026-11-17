// Display text of the instrument exception reasons (04-UI-UX §3.10). Raw codes are never shown.
export const REASON_TEXT: Readonly<Record<string, string>> = {
  unknown_barcode: 'Unknown barcode',
  unmapped_code: 'Code not mapped',
  specimen_rejected: 'Specimen rejected',
  result_locked: 'Result approved',
  result_already_verified: 'Result already verified',
  specimen_not_received: 'Not yet received',
  analyte_not_ordered: 'Test not ordered',
  unit_mismatch: 'Unit mismatch',
};
export const LOCKED_COPY = 'This result is approved. To use the new value, a pathologist must amend it.';
