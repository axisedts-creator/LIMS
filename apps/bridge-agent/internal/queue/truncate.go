package queue

import (
	"encoding/json"
	"time"
)

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
	cmdCutoff := now.Add(-outboundRetention).UTC().UnixNano()
	rows, err := tx.Query(`SELECT k, v FROM kv WHERE k LIKE 'cmd:%'`)
	if err != nil {
		return r, err
	}
	var delCmds []string
	for rows.Next() {
		var k string
		var v []byte
		if scanErr := rows.Scan(&k, &v); scanErr != nil {
			_ = rows.Close()
			return r, scanErr
		}
		var meta struct {
			Acked     bool  `json:"acked"`
			UpdatedAt int64 `json:"updated_at"`
		}
		if json.Unmarshal(v, &meta) == nil && meta.Acked && meta.UpdatedAt > 0 && meta.UpdatedAt < cmdCutoff {
			delCmds = append(delCmds, k)
		}
	}
	_ = rows.Close()
	for _, k := range delCmds {
		if _, err := tx.Exec(`DELETE FROM kv WHERE k=?`, k); err != nil {
			return r, err
		}
	}
	if err := tx.Commit(); err != nil {
		return r, err
	}
	if r.ItemsDeleted+r.OutboundDeleted+len(delCmds) > 0 {
		_, err = d.db.Exec("PRAGMA incremental_vacuum")
	}
	return r, err
}
