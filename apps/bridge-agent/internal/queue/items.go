package queue

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"time"
)

type ItemInput struct {
	ID, InstrumentID, Kind, Protocol string
	Raw, Meta                        []byte
	CapturedAtAgent                  string
	ClockOffsetMs                    int64
}

type Item struct {
	ItemInput
	RawSHA256       string
	SizeBytes       int64
	State           string
	Attempts        int
	UploadedAt      string
	ServerMessageID string
}

// AAD tables [CONV]: items has no seq, so seq is 0; the metadata blob uses its own table tag so it cannot be swapped with the payload.
const (
	itemTable = "items"
	metaTable = "items_meta"
)

// InsertItem stores a new pending item; sha256 (hex, lower) and size are computed here.
func (d *DB) InsertItem(in ItemInput) error {
	_, err := d.insertItem(d.db, in)
	return err
}

func (d *DB) insertItem(q querier, in ItemInput) (Item, error) {
	nonce, ct, err := d.seal(itemTable, in.ID, 0, in.Raw)
	if err != nil {
		return Item{}, err
	}
	mnonce, mct, err := d.seal(metaTable, in.ID, 0, in.Meta)
	if err != nil {
		return Item{}, err
	}
	sum := sha256.Sum256(in.Raw)
	it := Item{ItemInput: in, RawSHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(in.Raw)), State: "pending"}
	_, err = q.Exec(`INSERT INTO items (id, instrument_id, kind, protocol, nonce, ct, meta_nonce, meta_ct, raw_sha256, size_bytes,
		captured_at_agent, clock_offset_ms, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
		in.ID, in.InstrumentID, in.Kind, in.Protocol, nonce, ct, mnonce, mct, it.RawSHA256, it.SizeBytes, in.CapturedAtAgent, in.ClockOffsetMs)
	if err != nil {
		return Item{}, err
	}
	return it, nil
}

// GetItem returns the item with Raw and Meta decrypted; ErrTampered if either fails authentication.
func (d *DB) GetItem(id string) (Item, error) {
	var it Item
	var nonce, ct, mnonce, mct []byte
	var up, msg sql.NullString
	err := d.db.QueryRow(`SELECT id, instrument_id, kind, protocol, nonce, ct, meta_nonce, meta_ct, raw_sha256, size_bytes,
		captured_at_agent, clock_offset_ms, state, attempts, uploaded_at, server_message_id FROM items WHERE id = ?`, id).Scan(
		&it.ID, &it.InstrumentID, &it.Kind, &it.Protocol, &nonce, &ct, &mnonce, &mct, &it.RawSHA256, &it.SizeBytes,
		&it.CapturedAtAgent, &it.ClockOffsetMs, &it.State, &it.Attempts, &up, &msg)
	if errors.Is(err, sql.ErrNoRows) {
		return Item{}, ErrNotFound
	}
	if err != nil {
		return Item{}, err
	}
	it.UploadedAt, it.ServerMessageID = up.String, msg.String
	if it.Raw, err = d.open(itemTable, id, 0, nonce, ct); err != nil {
		return Item{}, err
	}
	if it.Meta, err = d.open(metaTable, id, 0, mnonce, mct); err != nil {
		return Item{}, err
	}
	return it, nil
}

func one(res sql.Result, err error) error {
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrNotFound
	}
	return nil
}

func (d *DB) MarkUploaded(id, serverMessageID string, at time.Time) error {
	return one(d.db.Exec("UPDATE items SET state='uploaded', uploaded_at=?, server_message_id=? WHERE id=?",
		at.UTC().Format(tsFormat), serverMessageID, id))
}

// SetItemState sets state; a value outside the CHECK list fails.
func (d *DB) SetItemState(id, state string) error {
	return one(d.db.Exec("UPDATE items SET state=? WHERE id=?", state, id))
}

func (d *DB) CountByState() (map[string]int, error) {
	rows, err := d.db.Query("SELECT state, count(*) FROM items GROUP BY state")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var s string
		var n int
		if err := rows.Scan(&s, &n); err != nil {
			return nil, err
		}
		out[s] = n
	}
	return out, rows.Err()
}
