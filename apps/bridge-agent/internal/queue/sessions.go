package queue

import (
	"database/sql"
	"errors"
	"fmt"
)

type Session struct {
	ID, InstrumentID, Protocol, StartedAtAgent, LastFrameAtAgent string
	ExpectedFN, Frames                                           int
}

const chunkTable = "session_chunks"

func (d *DB) BeginSession(s Session) error {
	if s.StartedAtAgent == "" || s.LastFrameAtAgent == "" {
		return errors.New("queue: session needs started_at_agent and last_frame_at_agent")
	}
	_, err := d.db.Exec(`INSERT INTO sessions (id, instrument_id, protocol, started_at_agent, last_frame_at_agent, expected_fn)
		VALUES (?, ?, ?, ?, ?, ?)`, s.ID, s.InstrumentID, s.Protocol, s.StartedAtAgent, s.LastFrameAtAgent, s.ExpectedFN)
	return err
}

// AppendChunk persists one frame in ONE committed transaction (chunk + counters); the caller ACKs only after it returns (D-02, AC-05.2).
func (d *DB) AppendChunk(sessionID string, seq, expectedFN int, text []byte, lastFrameAt string) error {
	nonce, ct, err := d.seal(chunkTable, sessionID, seq, text)
	if err != nil {
		return err
	}
	tx, err := d.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	if _, err := tx.Exec("INSERT INTO session_chunks (session_id, seq, nonce, ct) VALUES (?, ?, ?, ?)", sessionID, seq, nonce, ct); err != nil {
		return err
	}
	res, err := tx.Exec("UPDATE sessions SET frames = frames + 1, expected_fn = ?, last_frame_at_agent = ? WHERE id = ?", expectedFN, lastFrameAt, sessionID)
	if err != nil {
		return err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return ErrNotFound
	}
	return tx.Commit()
}

const sessionCols = "id, instrument_id, protocol, started_at_agent, last_frame_at_agent, COALESCE(expected_fn, 0), frames"

func scanSession(r interface{ Scan(...any) error }) (Session, error) {
	var s Session
	err := r.Scan(&s.ID, &s.InstrumentID, &s.Protocol, &s.StartedAtAgent, &s.LastFrameAtAgent, &s.ExpectedFN, &s.Frames)
	return s, err
}

func (d *DB) GetSession(id string) (Session, error) {
	s, err := scanSession(d.db.QueryRow("SELECT "+sessionCols+" FROM sessions WHERE id = ?", id))
	if errors.Is(err, sql.ErrNoRows) {
		return s, ErrNotFound
	}
	return s, err
}

// OpenSessions lists sessions not yet finalised or deleted (restart recovery).
func (d *DB) OpenSessions() ([]Session, error) {
	rows, err := d.db.Query("SELECT " + sessionCols + " FROM sessions ORDER BY started_at_agent, id")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Session
	for rows.Next() {
		s, err := scanSession(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

// Chunks returns the decrypted frames of a session ordered by seq.
func (d *DB) Chunks(sessionID string) ([][]byte, error) { return d.chunks(d.db, sessionID) }

func (d *DB) chunks(q querier, sessionID string) ([][]byte, error) {
	rows, err := q.Query("SELECT seq, nonce, ct FROM session_chunks WHERE session_id = ? ORDER BY seq", sessionID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var seq int
		var nonce, ct []byte
		if err := rows.Scan(&seq, &nonce, &ct); err != nil {
			return nil, err
		}
		p, err := d.open(chunkTable, sessionID, seq, nonce, ct)
		if err != nil {
			return nil, fmt.Errorf("session %s chunk %d: %w", sessionID, seq, err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// DeleteSession removes a session; its chunks cascade.
func (d *DB) DeleteSession(sessionID string) error {
	_, err := d.db.Exec("DELETE FROM sessions WHERE id = ?", sessionID)
	return err
}

// FinalizeSession builds the item from the session's decrypted chunks (in.Raw is ignored), inserts it and deletes the
// chunks and the session in ONE transaction. A tampered chunk or a failed insert leaves the session untouched.
func (d *DB) FinalizeSession(sessionID string, in ItemInput) (Item, error) {
	tx, err := d.db.Begin()
	if err != nil {
		return Item{}, err
	}
	defer tx.Rollback() //nolint:errcheck // no-op after Commit
	var one int
	if err := tx.QueryRow("SELECT 1 FROM sessions WHERE id = ?", sessionID).Scan(&one); errors.Is(err, sql.ErrNoRows) {
		return Item{}, ErrNotFound
	} else if err != nil {
		return Item{}, err
	}
	parts, err := d.chunks(tx, sessionID)
	if err != nil {
		return Item{}, err
	}
	var raw []byte
	for _, p := range parts {
		raw = append(raw, p...)
	}
	in.Raw = raw
	it, err := d.insertItem(tx, in)
	if err != nil {
		return Item{}, err
	}
	if _, err := tx.Exec("DELETE FROM sessions WHERE id = ?", sessionID); err != nil { // chunks cascade
		return Item{}, err
	}
	if err := tx.Commit(); err != nil {
		return Item{}, err
	}
	return it, nil
}
