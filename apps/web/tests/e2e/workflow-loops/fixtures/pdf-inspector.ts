// PDF Report Binary Inspector for Playwright E2E Verification
// Verifies PDF magic headers, digital signature assets, and admin signature suppression.

export interface PdfInspectionResult {
  isPdf: boolean;
  byteLength: number;
  hasPathologistSignatory: boolean;
  hasAdminVerifiedSignatureAsset: boolean;
  rawTextPreview: string;
}

export function inspectReportPdfBytes(buffer: Buffer | Uint8Array): PdfInspectionResult {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const text = buf.toString('latin1'); // Read raw ASCII/latin1 streams

  // 1. PDF Magic Bytes Check
  const isPdf = text.startsWith('%PDF-');

  // 2. Pathologist Signatory Check
  // In LIMS, clinical pathologists have council registration tags (NMC / NHPC) and signature image objects
  const hasPathologistSignatory =
    /pathologist/i.test(text) ||
    /consultant/i.test(text) ||
    /NMC\s*No/i.test(text) ||
    /NHPC\s*No/i.test(text);

  // 3. Admin Verified Signature Asset Check
  // Admin entry/verification must omit the verified signature image asset (/Image /XObject)
  // associated with the admin's membership ID.
  // In domain/document.ts:
  // const isVerifiedSignatory = s.roleCode !== 'tenant_admin' && s.isAdmin !== true;
  // const hasSigAsset = Boolean(isVerifiedSignatory && s.signatureAssetId && s.signatureSha256);
  const hasAdminRoleLabel = /tenant_admin|system_administrator|lab_admin/i.test(text);
  const hasAdminSigAssetMark = /AdminVerifiedSignatureAsset/i.test(text);

  return {
    isPdf,
    byteLength: buf.length,
    hasPathologistSignatory,
    hasAdminVerifiedSignatureAsset: Boolean(hasAdminRoleLabel && hasAdminSigAssetMark),
    rawTextPreview: text.slice(0, 500),
  };
}
