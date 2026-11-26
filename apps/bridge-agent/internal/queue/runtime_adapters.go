package queue

import (
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"encoding/json"
	"errors"
	"sort"
	"strings"
	"sync"
	"time"
)

// QueueStats summarizes queue counts and oldest pending item age for E03/status.
type QueueStats struct {
	Pending                 int
	Uploading               int
	Rejected                int
	Oversize                int
	UploadedRetained        int
	OldestPendingAgeSeconds int
}

// FreeBytes returns available bytes on the queue directory volume.
func (d *DB) FreeBytes() (int64, error) {
	return d.free(d.dir)
}

// PendingAndRejectedCount returns the count of pending, uploading, and rejected items (for `uninstall --purge`).
func (d *DB) PendingAndRejectedCount() (int, error) {
	var n int
	err := d.db.QueryRow(`SELECT COUNT(*) FROM items WHERE state IN ('pending','uploading','rejected')`).Scan(&n)
	return n, err
}

// RequeueUploadedSince moves uploaded items captured at or after since back to pending.
func (d *DB) RequeueUploadedSince(since time.Time) (int, error) {
	res, err := d.db.Exec(
		`UPDATE items SET state='pending', next_attempt_at=NULL WHERE state='uploaded' AND captured_at_agent >= ?`,
		since.UTC().Format(tsFormat),
	)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	return int(n), nil
}

// QueueStats returns per-state counts and the oldest pending age at now.
func (d *DB) QueueStats(now time.Time) (QueueStats, error) {
	var st QueueStats
	counts, err := d.CountByState()
	if err != nil {
		return st, err
	}
	st.Pending = counts["pending"]
	st.Uploading = counts["uploading"]
	st.Rejected = counts["rejected"]
	st.Oversize = counts["oversize"]
	st.UploadedRetained = counts["uploaded"]

	var oldest sql.NullString
	if err := d.db.QueryRow(`SELECT MIN(captured_at_agent) FROM items WHERE state='pending'`).Scan(&oldest); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return st, err
	}
	if oldest.Valid && oldest.String != "" {
		if t, perr := time.Parse(tsFormat, oldest.String); perr == nil {
			age := int(now.UTC().Sub(t).Seconds())
			if age > 0 {
				st.OldestPendingAgeSeconds = age
			}
		}
	}
	return st, nil
}

// FileDropSeen reports whether pathSHA256+size+mtime has already been captured for instrumentID.
func (d *DB) FileDropSeen(instrumentID, pathSHA256 string, size int64, mtime time.Time) (bool, error) {
	var x int
	err := d.db.QueryRow(
		`SELECT 1 FROM file_drop_seen WHERE instrument_id=? AND path_sha256=? AND size_bytes=? AND mtime=? LIMIT 1`,
		instrumentID, pathSHA256, size, mtime.UTC().Format(tsFormat),
	).Scan(&x)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// CaptureFileDrop inserts the queued item and file_drop_seen row in one SQLite transaction.
func (d *DB) CaptureFileDrop(in ItemInput, instrumentID, pathSHA256 string, size int64, mtime time.Time, fileSHA256, itemID string, seenAt time.Time) error {
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if _, err := d.insertItem(tx, in); err != nil {
		return err
	}
	if _, err := tx.Exec(
		`INSERT INTO file_drop_seen (instrument_id, path_sha256, size_bytes, mtime, file_sha256, item_id, first_seen_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		instrumentID, pathSHA256, size, mtime.UTC().Format(tsFormat), fileSHA256, itemID, seenAt.UTC().Format(tsFormat),
	); err != nil {
		return err
	}
	return tx.Commit()
}

// OutboundEnqueue records an outbound reply as pending and returns its id.
func (d *DB) OutboundEnqueue(instrumentID string, msg []byte, _ time.Time) (string, error) {
	id := NewUUIDv7(time.Now().UTC())
	nonce, ct, err := d.seal("outbound", id, 0, msg)
	if err != nil {
		return "", err
	}
	_, err = d.db.Exec(
		`INSERT INTO outbound (id, instrument_id, nonce, ct, created_at, attempts, state) VALUES (?, ?, ?, ?, ?, 0, 'pending')`,
		id, instrumentID, nonce, ct, time.Now().UTC().Format(tsFormat),
	)
	return id, err
}

// OutboundMark updates the delivery state of a tracked outbound reply ('sent' or 'failed').
func (d *DB) OutboundMark(id, state string) error {
	if id == "" {
		return nil
	}
	_, err := d.db.Exec(`UPDATE outbound SET state=?, attempts=attempts+1 WHERE id=?`, state, id)
	return err
}

// NewUUIDv7 returns an RFC 9562 UUIDv7 string for t.
func NewUUIDv7(t time.Time) string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	ms := uint64(t.UTC().UnixMilli())
	binary.BigEndian.PutUint16(b[0:2], uint16(ms>>32))
	binary.BigEndian.PutUint32(b[2:6], uint32(ms))
	b[6] = (b[6] & 0x0f) | 0x70
	b[8] = (b[8] & 0x3f) | 0x80
	const hexChars = "0123456789abcdef"
	var out [36]byte
	j := 0
	for i, c := range b {
		if i == 4 || i == 6 || i == 8 || i == 10 {
			out[j] = '-'
			j++
		}
		out[j] = hexChars[c>>4]
		out[j+1] = hexChars[c&0x0f]
		j += 2
	}
	return string(out[:])
}

// KVCommandRecord matches heartbeat.CommandRecord and persists in the encrypted kv table.
type KVCommandRecord struct {
	CommandID  string `json:"command_id"`
	Kind       string `json:"kind"`
	State      string `json:"state"`
	ResultCode string `json:"result_code,omitempty"`
	Acked      bool   `json:"acked"`
	UpdatedAt  int64  `json:"updated_at"`
}

// KVCommandStore persists command records in queue DB's kv table with prefix "cmd:".
type KVCommandStore struct {
	d  *DB
	mu sync.Mutex
}

func NewKVCommandStore(d *DB) *KVCommandStore { return &KVCommandStore{d: d} }

const cmdPrefix = "cmd:"

func (s *KVCommandStore) Get(id string) (KVCommandRecord, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var blob []byte
	err := s.d.db.QueryRow(`SELECT v FROM kv WHERE k=?`, cmdPrefix+id).Scan(&blob)
	if errors.Is(err, sql.ErrNoRows) {
		return KVCommandRecord{}, false, nil
	}
	if err != nil {
		return KVCommandRecord{}, false, err
	}
	var rec KVCommandRecord
	if err := json.Unmarshal(blob, &rec); err != nil {
		return KVCommandRecord{}, false, err
	}
	return rec, true, nil
}

func (s *KVCommandStore) Put(rec KVCommandRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if rec.UpdatedAt == 0 {
		rec.UpdatedAt = time.Now().UTC().UnixNano()
	}
	blob, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	_, err = s.d.db.Exec(`INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)`, cmdPrefix+rec.CommandID, blob)
	return err
}

func (s *KVCommandStore) Unacked(limit int) ([]KVCommandRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.d.db.Query(`SELECT k, v FROM kv WHERE k LIKE 'cmd:%' ORDER BY k`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []KVCommandRecord
	for rows.Next() {
		var k string
		var v []byte
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		if !strings.HasPrefix(k, cmdPrefix) {
			continue
		}
		var rec KVCommandRecord
		if err := json.Unmarshal(v, &rec); err != nil {
			continue
		}
		if !rec.Acked && (rec.State == "completed" || rec.State == "failed") {
			out = append(out, rec)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].UpdatedAt != out[j].UpdatedAt {
			return out[i].UpdatedAt < out[j].UpdatedAt
		}
		return out[i].CommandID < out[j].CommandID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (s *KVCommandStore) Ack(ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		var blob []byte
		err := s.d.db.QueryRow(`SELECT v FROM kv WHERE k=?`, cmdPrefix+id).Scan(&blob)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		var rec KVCommandRecord
		if err := json.Unmarshal(blob, &rec); err != nil {
			continue
		}
		rec.Acked = true
		nb, err := json.Marshal(rec)
		if err != nil {
			return err
		}
		if _, err := s.d.db.Exec(`UPDATE kv SET v=? WHERE k=?`, nb, cmdPrefix+id); err != nil {
			return err
		}
	}
	return nil
}
