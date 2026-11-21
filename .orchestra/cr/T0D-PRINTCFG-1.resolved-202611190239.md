Title: CR-C0-PRINTCFG-1-WEB: a read route for a signatory's signature image
From chunk: C0-0D            To owner: C0-0C (contract), then C0-0B (handler)
Type: api
Blocking? no. T0D-PRINTCFG-1 shows "Signature on file" instead of a thumbnail (review T0D-PRINTCFG-1 item 2).
Problem: done_when (2) asks the Signatories editor to "show the image" so the admin can check it before replacing or removing it. uploadUserSignature (identity.yaml, POST /v1/identity/users/{membership_id}/signature) stores the image and returns signatory.signature_asset_id, but the contract has no route that returns that asset's bytes. getBrandingAssetContent serves branding kinds only (identity core-admin.repo.ts, port filter D-26), so the branding image proxy cannot show it.
Proposed change (exact): owner to name and add one GET operation returning the signature image bytes for a membership, gated by identity.user.manage (the same permission as uploadUserSignature), tenant scoped by RLS. No operation id, path or field name is invented here.
Backward compatible? yes (additive endpoint).
Tenant/security impact: new read surface for a staff signature image (not PHI). Must be tenant scoped and permission gated; signature images are sensitive (forgery risk), so no public or cached URL.
IRD/regulatory impact: none.
Alternatives considered: reuse the branding proxy (refused: wrong kind, D-26 filter); upload with kind logo (refused: replaces the lab logo, review item 1).
Tests that will prove it: contract test pins the new operation and its x-permission; web test: the Signatories editor shows an <img> served by the new route when signature_asset_id is set.
