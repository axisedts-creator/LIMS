package queue

import "time"

type TruncateResult struct{ ItemsDeleted, OutboundDeleted int }

const (
	minRetention      = time.Hour
	maxRetention      = 72 * time.Hour
	outboundRetention = 24 * time.Hour
)

// Truncate deletes `uploaded` items older than retention (clamped to 1-72 h) and `sent`/`failed` outbound rows older than 24 h,
// then returns the freed pages (AC-08.4, TRD 5.6). Pending, uploading, rejected and oversize items are never deleted here.
// Deleted rows are overwritten because secure_delete is on (REQ-SEC-117). Chunks of finalised sessions are already gone.
func (d *DB) Truncate(now time.Time, retention time.Duration) (TruncateResult, error) {
	retention = min(max(retention, minRetention), maxRetention)
	var r TruncateResult
	tx, err := d.db.Begin()
	if err != nil {
		return r, err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	res, err := tx.Exec("DELETE FROM items WHERE state='uploaded' AND uploaded_at < ?", now.Add(-retention).UTC().Format(tsFormat))
	if err != nil {
		return r, err
	}
	n, _ := res.RowsAffected()
	r.ItemsDeleted = int(n)
	res, err = tx.Exec("DELETE FROM outbound WHERE state IN ('sent','failed') AND created_at < ?", now.Add(-outboundRetention).UTC().Format(tsFormat))
	if err != nil {
		return r, err
	}
	n, _ = res.RowsAffected()
	r.OutboundDeleted = int(n)
	if err := tx.Commit(); err != nil {
		return r, err
	}
	if r.ItemsDeleted+r.OutboundDeleted > 0 {
		_, err = d.db.Exec("PRAGMA incremental_vacuum")
	}
	return r, err
}
