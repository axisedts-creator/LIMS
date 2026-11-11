// Test-only env defaults for the identity module (convention: src/__tests__/setup-env.ts). Synthetic value, not a secret.
// LIMS_IDENTITY_EMAIL_HMAC_KEY is a required global secret with no production default (02-TRD s.562; 07-SECURITY s.216).
export default {
  LIMS_IDENTITY_EMAIL_HMAC_KEY: 'test-only-identity-email-hmac-key-0123456789abcdef',
} satisfies Record<string, string>;
