package queue

import (
	"encoding/json"
	"time"

	"lims/apps/bridge-agent/internal/uploader"
)

// UploadStore adapts the queue to uploader.Store (TRD 5.7). ponytail: Claim is not one transaction; correct because
// exactly one uploader (serialised by its Tick lock) owns the queue. Make it a tx if a second consumer ever appears.
type UploadStore struct{ d *DB }

var _ uploader.Store = UploadStore{}

func NewUploadStore(d *DB) UploadStore { return UploadStore{d} }

func ts(t time.Time) string { return t.UTC().Format(tsFormat) }

// Claim marks up to limit due pending items uploading, oldest captured first, and returns them decrypted.
func (s UploadStore) Claim(now time.Time, limit int) ([]uploader.Item, error) {
	rows, err := s.d.db.Query(`SELECT id FROM items WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
		ORDER BY captured_at_agent, id LIMIT ?`, ts(now), limit)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	out := make([]uploader.Item, 0, len(ids))
	for _, id := range ids {
		it, err := s.d.GetItem(id)
		if err != nil {
			return out, err // tampered/unreadable item: the ones already claimed are returned for upload
		}
		captured, err := time.Parse(tsFormat, it.CapturedAtAgent)
		if err != nil {
			return out, err
		}
		var m struct {
			LinkMeta json.RawMessage `json:"link_meta"`
		}
		_ = json.Unmarshal(it.Meta, &m) // meta without link_meta (or unreadable) simply carries none
		if err := one(s.d.db.Exec("UPDATE items SET state='uploading' WHERE id=?", id)); err != nil {
			return out, err
		}
		out = append(out, uploader.Item{ID: it.ID, InstrumentID: it.InstrumentID, Kind: it.Kind, Protocol: it.Protocol, Raw: it.Raw,
			RawSHA256: it.RawSHA256, CapturedAtAgent: captured, ClockOffsetMs: it.ClockOffsetMs, LinkMeta: m.LinkMeta, Attempts: it.Attempts})
	}
	return out, nil
}

// Release returns items to pending, due at next; an attempt counts only when errCode != "".
func (s UploadStore) Release(ids []string, next time.Time, errCode string) error {
	inc := 0
	if errCode != "" {
		inc = 1
	}
	for _, id := range ids {
		if err := one(s.d.db.Exec("UPDATE items SET state='pending', next_attempt_at=?, last_error_code=NULLIF(?, ''), attempts=attempts+? WHERE id=?",
			ts(next), errCode, inc, id)); err != nil {
			return err
		}
	}
	return nil
}

// Resolve records the outcome of one item: uploaded, rejected, or pending (retry, counts an attempt).
func (s UploadStore) Resolve(r uploader.Resolution) error {
	switch r.State {
	case "uploaded":
		return one(s.d.db.Exec("UPDATE items SET state='uploaded', uploaded_at=?, server_message_id=?, last_error_code=NULL WHERE id=?",
			ts(r.UploadedAt), r.ServerMessageID, r.ID))
	case "rejected":
		return one(s.d.db.Exec("UPDATE items SET state='rejected', last_error_code=?, rejected_config_version=? WHERE id=?",
			r.ErrorCode, r.RejectedConfigVersion, r.ID))
	default:
		return one(s.d.db.Exec("UPDATE items SET state='pending', last_error_code=NULLIF(?, ''), next_attempt_at=?, attempts=attempts+1 WHERE id=?",
			r.ErrorCode, ts(r.NextAttempt), r.ID))
	}
}

// RequeueRejected moves items rejected under an older config version back to pending, once per new version.
func (s UploadStore) RequeueRejected(appliedConfigVersion int) (int, error) {
	res, err := s.d.db.Exec("UPDATE items SET state='pending', next_attempt_at=NULL WHERE state='rejected' AND rejected_config_version < ?", appliedConfigVersion)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}
