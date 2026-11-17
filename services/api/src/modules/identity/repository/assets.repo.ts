// identity.branding_assets rows of kind signature (02-TRD §5.3 uploadUserSignature; 01-PRD US-B6; 08 A17 P-19). SQL on the request tx;
// every statement names tenant_id on top of RLS (REQ-SEC-040). Old signature rows are kept but inactive (only the newest is referenced).
type Tx = { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> };

export function createAssetsRepo() {
  return {
    async insertSignatureAsset(tx: unknown, tenantId: string, a: {
      id: string; membershipId: string; bucket: string; objectPath: string; contentType: string; sizeBytes: number; widthPx: number; heightPx: number;
      sha256: string; scanState: string; actorId: string;
    }): Promise<void> {
      await (tx as Tx).query(`INSERT INTO identity.branding_assets (id, tenant_id, kind, membership_id, bucket, object_path, content_type, size_bytes,
          width_px, height_px, sha256, scan_state, created_by, updated_by)
        VALUES ($2, $1, 'signature', $3, $4, $5, $6, $7, $8, $9, decode($10, 'hex'), $11, $12, $12)`,
      [tenantId, a.id, a.membershipId, a.bucket, a.objectPath, a.contentType, a.sizeBytes, a.widthPx, a.heightPx, a.sha256, a.scanState, a.actorId]);
    },
    async deactivateOtherSignatureAssets(tx: unknown, tenantId: string, membershipId: string, keepId: string, actorId: string): Promise<void> {
      await (tx as Tx).query(`UPDATE identity.branding_assets SET is_active = false, version = version + 1, updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND membership_id = $2 AND kind = 'signature' AND id <> $3 AND is_active`, [tenantId, membershipId, keepId, actorId]);
    },
  };
}
