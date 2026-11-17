import { Notice } from '@/features/portal/Notice';

// AC-10.3: unknown / revoked / unreleased / malformed QR tokens -> HTTP 404 with one token-independent page.
export default function VerifyNotFound() {
  return (
    <>
      <h1>Verify a lab report</h1>
      <Notice tone="neutral" title="We couldn't verify this report.">
        Check that you scanned the QR code on the report, or contact the laboratory.
      </Notice>
    </>
  );
}
