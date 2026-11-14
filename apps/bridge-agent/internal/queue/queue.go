// Package queue is the agent's local encrypted store (02-TRD 5.6, D-02, D-07, REQ-SEC-117).
// SQLite WAL, synchronous=FULL (a commit is durable before the ACK), AES-256-GCM per payload,
// the data key stored only wrapped by DPAPI.
package queue

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"strconv"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

const (
	schemaVersion = 1
	dataKeyName   = "data_key"
	// defaultMinFree is the disk-guard threshold: 500 MB [CONV]. Binary MiB is used (the larger reading, so the guard errs safe).
	defaultMinFree = 500 << 20
	// tsFormat: every agent timestamp is UTC text in this form, so text order is time order.
	tsFormat = "2006-01-02T15:04:05.000Z"
)

var (
	ErrNotFound = errors.New("queue: not found")
	// ErrTampered: AES-GCM open failed (wrong key, wrong AAD, bad tag or nonce).
	ErrTampered = errors.New("queue: ciphertext failed authentication")
)

// KeyProtector wraps the data key. secrets.DPAPI satisfies it.
type KeyProtector interface {
	Protect(plain []byte) ([]byte, error)
	Unprotect(blob []byte) ([]byte, error)
}

type Options struct {
	MinFreeBytes int64                           // 0 = 500 MB; disk is low when free < MinFreeBytes
	FreeBytes    func(dir string) (int64, error) // nil = real free space of dir
}

type DB struct {
	db      *sql.DB
	aead    cipher.AEAD
	dir     string
	minFree int64
	free    func(string) (int64, error)
}

// querier is satisfied by *sql.DB and *sql.Tx.
type querier interface {
	Exec(q string, args ...any) (sql.Result, error)
	Query(q string, args ...any) (*sql.Rows, error)
	QueryRow(q string, args ...any) *sql.Row
}

// Open creates or opens the queue at path (parent dir must exist), creates the schema and the data key on first use.
// A data key that cannot be unwrapped fails Open; a new key is never minted over existing data.
func Open(path string, p KeyProtector, o Options) (*DB, error) {
	// auto_vacuum must be set before the first table exists, so it comes first.
	dsn := path + "?_pragma=auto_vacuum(2)&_pragma=journal_mode(wal)&_pragma=synchronous(2)&_pragma=secure_delete(1)" +
		"&_pragma=foreign_keys(1)&_pragma=busy_timeout(5000)"
	sdb, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	sdb.SetMaxOpenConns(1) // one writer; pragmas are per connection and the pool never holds a second one
	d := &DB{db: sdb, dir: filepath.Dir(path), minFree: o.MinFreeBytes, free: o.FreeBytes}
	if d.minFree == 0 {
		d.minFree = defaultMinFree
	}
	if d.free == nil {
		d.free = freeBytes
	}
	if err := d.init(p); err != nil {
		_ = sdb.Close()
		return nil, err
	}
	return d, nil
}

func (d *DB) init(p KeyProtector) error {
	var ver int
	if err := d.db.QueryRow("PRAGMA user_version").Scan(&ver); err != nil {
		return err
	}
	if ver == 0 {
		tx, err := d.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(schemaSQL); err != nil {
			_ = tx.Rollback()
			return err
		}
		if _, err := tx.Exec("PRAGMA user_version=" + strconv.Itoa(schemaVersion)); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	} else if ver > schemaVersion {
		return fmt.Errorf("queue: schema version %d is newer than this agent (%d)", ver, schemaVersion)
	}
	key, err := d.loadKey(p)
	if err != nil {
		return err
	}
	blk, err := aes.NewCipher(key)
	if err != nil {
		return err
	}
	d.aead, err = cipher.NewGCM(blk) // 96-bit nonce
	return err
}

func (d *DB) loadKey(p KeyProtector) ([]byte, error) {
	var wrapped []byte
	err := d.db.QueryRow("SELECT v FROM kv WHERE k=?", dataKeyName).Scan(&wrapped)
	switch {
	case err == nil:
		key, err := p.Unprotect(wrapped)
		if err != nil {
			return nil, fmt.Errorf("queue: unwrap data key: %w", err)
		}
		if len(key) != 32 {
			return nil, fmt.Errorf("queue: data key is %d bytes, want 32", len(key))
		}
		return key, nil
	case errors.Is(err, sql.ErrNoRows):
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			return nil, err
		}
		wrapped, err := p.Protect(key)
		if err != nil {
			return nil, fmt.Errorf("queue: wrap data key: %w", err)
		}
		if _, err := d.db.Exec("INSERT INTO kv (k, v) VALUES (?, ?)", dataKeyName, wrapped); err != nil {
			return nil, err
		}
		return key, nil
	default:
		return nil, err
	}
}

func (d *DB) Close() error { return d.db.Close() }

var pragmaName = regexp.MustCompile(`^[a-z_]+$`)

// Pragma returns the value of PRAGMA name on the live connection.
func (d *DB) Pragma(name string) (string, error) {
	if !pragmaName.MatchString(name) {
		return "", fmt.Errorf("queue: bad pragma name %q", name)
	}
	var v string
	err := d.db.QueryRow("PRAGMA " + name).Scan(&v)
	return v, err
}

// DiskLow reports free space on the queue volume below the guard (receivers NAK/AR, heartbeat disk_low).
// It never blocks persisting frames of a session already open.
func (d *DB) DiskLow() (bool, error) {
	n, err := d.free(d.dir)
	if err != nil {
		return false, err
	}
	return n < d.minFree, nil
}

// seal encrypts plain under a fresh random nonce. AAD = table ":" row id ":" seq (TRD 5.6).
func (d *DB) seal(table, id string, seq int, plain []byte) (nonce, ct []byte, err error) {
	nonce = make([]byte, d.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, nil, err
	}
	return nonce, d.aead.Seal(nil, nonce, plain, aad(table, id, seq)), nil
}

func (d *DB) open(table, id string, seq int, nonce, ct []byte) ([]byte, error) {
	if len(nonce) != d.aead.NonceSize() {
		return nil, fmt.Errorf("%w: nonce is %d bytes", ErrTampered, len(nonce))
	}
	plain, err := d.aead.Open(nil, nonce, ct, aad(table, id, seq))
	if err != nil {
		return nil, ErrTampered
	}
	return plain, nil
}

func aad(table, id string, seq int) []byte {
	return []byte(table + ":" + id + ":" + strconv.Itoa(seq))
}
