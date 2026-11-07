// English text for kit message keys (04-UI-UX §2.2, §2.6, §1.3). Moves to packages/ui/src/i18n/en.json when the i18n loader lands.
export const msg = {
  required: (label: string) => `Enter ${label}`, // ui.validation.required
  maxLength: (label: string, max: number) => `${label} must be ${max} characters or fewer`, // ui.validation.max_length
  decimals: (label: string, decimals: number) => `${label} can have at most ${decimals} decimal places`, // ui.validation.decimals
  range: (label: string, min: string, max: string) => `${label} must be between ${min} and ${max}`, // ui.validation.range
  working: 'Working…',
  close: 'Close',
  cancel: 'Cancel',
  dismiss: 'Dismiss',
  retry: 'Retry',
  help: 'Help',
  copy: 'Copy',
  copied: 'Copied',
  reason: 'Reason',
  details: 'Details',
  loading: 'Loading…',
  breadcrumb: 'Breadcrumb',
  errorSummaryTitle: 'There is a problem',
  reference: (id: string) => `Reference: ${id}`,
  toneText: { neutral: 'Note', info: 'Information', success: 'Success', warning: 'Warning', danger: 'Error', critical: 'Critical' },
} as const;

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'critical';
