package update_test

import (
	"encoding/json"
	"os"

	"lims/apps/bridge-agent/internal/update"
)

func removeFile(p string) error { return os.Remove(p) }

// pendingJSON is the on-disk pending.json the tests forge: the release row the agent staged (contract: Release fields as snake_case).
func pendingJSON(rel update.Release) []byte {
	b, _ := json.Marshal(map[string]any{
		"version": rel.Version, "package_sha256": rel.PackageSHA256, "package_size": rel.PackageSize,
		"signature": rel.Signature, "key_id": rel.KeyID, "authenticode_publisher": rel.AuthenticodePublisher,
	})
	return b
}
