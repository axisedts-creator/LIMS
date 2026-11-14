package serial_test

import (
	"bytes"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/transport/serial"
)

func boolp(b bool) *bool { return &b }

func goodCfg() serial.Config {
	return serial.Config{PortName: "COM3", BaudRate: 9600, DataBits: 8, Parity: "none", StopBits: "1"}
}

// 02-TRD §5.8 serial schema.
func TestValidateConfigAccepts(t *testing.T) {
	if err := serial.ValidateConfig(goodCfg()); err != nil {
		t.Fatalf("valid config rejected: %v", err)
	}
	c := goodCfg()
	c.DTR, c.RTS = boolp(false), boolp(false)
	if err := serial.ValidateConfig(c); err != nil {
		t.Fatalf("dtr/rts opt-outs rejected: %v", err)
	}
	for _, b := range []int{1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200} {
		c := goodCfg()
		c.BaudRate = b
		if err := serial.ValidateConfig(c); err != nil {
			t.Errorf("baud %d rejected: %v", b, err)
		}
	}
	for _, p := range []string{"none", "odd", "even", "mark", "space"} {
		c := goodCfg()
		c.Parity = p
		if err := serial.ValidateConfig(c); err != nil {
			t.Errorf("parity %s rejected: %v", p, err)
		}
	}
	for _, s := range []string{"1", "1.5", "2"} {
		c := goodCfg()
		c.StopBits = s
		if err := serial.ValidateConfig(c); err != nil {
			t.Errorf("stop_bits %s rejected: %v", s, err)
		}
	}
	for _, d := range []int{7, 8} {
		c := goodCfg()
		c.DataBits = d
		if err := serial.ValidateConfig(c); err != nil {
			t.Errorf("data bits %d rejected: %v", d, err)
		}
	}
	for _, p := range []string{"COM1", "COM9", "COM10", "COM999"} {
		c := goodCfg()
		c.PortName = p
		if err := serial.ValidateConfig(c); err != nil {
			t.Errorf("port %s rejected: %v", p, err)
		}
	}
}

func TestValidateConfigRejects(t *testing.T) {
	cases := []struct {
		name string
		mut  func(c *serial.Config)
	}{
		{"empty port", func(c *serial.Config) { c.PortName = "" }},
		{"lowercase com", func(c *serial.Config) { c.PortName = "com3" }},
		{"COM0", func(c *serial.Config) { c.PortName = "COM0" }},
		{"COM1000", func(c *serial.Config) { c.PortName = "COM1000" }},
		{"COM leading zero", func(c *serial.Config) { c.PortName = "COM03" }},
		{"device path prefix", func(c *serial.Config) { c.PortName = `\\.\COM3` }},
		{"path traversal", func(c *serial.Config) { c.PortName = `COM3\..\..\x` }},
		{"trailing newline", func(c *serial.Config) { c.PortName = "COM3\n" }},
		{"trailing space", func(c *serial.Config) { c.PortName = "COM3 " }},
		{"unix tty", func(c *serial.Config) { c.PortName = "/dev/ttyS0" }},
		{"baud zero (no assumed default)", func(c *serial.Config) { c.BaudRate = 0 }},
		{"baud 9601", func(c *serial.Config) { c.BaudRate = 9601 }},
		{"baud 230400", func(c *serial.Config) { c.BaudRate = 230400 }},
		{"baud negative", func(c *serial.Config) { c.BaudRate = -9600 }},
		{"data bits zero", func(c *serial.Config) { c.DataBits = 0 }},
		{"data bits 5", func(c *serial.Config) { c.DataBits = 5 }},
		{"data bits 9", func(c *serial.Config) { c.DataBits = 9 }},
		{"parity empty", func(c *serial.Config) { c.Parity = "" }},
		{"parity wrong case", func(c *serial.Config) { c.Parity = "None" }},
		{"parity bogus", func(c *serial.Config) { c.Parity = "weird" }},
		{"stop bits empty", func(c *serial.Config) { c.StopBits = "" }},
		{"stop bits 3", func(c *serial.Config) { c.StopBits = "3" }},
		{"stop bits 1.0", func(c *serial.Config) { c.StopBits = "1.0" }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := goodCfg()
			tc.mut(&c)
			if err := serial.ValidateConfig(c); err == nil {
				t.Fatalf("expected error for %+v", c)
			}
		})
	}
}

// Open must refuse an invalid config before touching any device.
func TestOpenRejectsInvalidConfig(t *testing.T) {
	c := goodCfg()
	c.BaudRate = 12345
	p, err := serial.Open(c)
	if err == nil {
		p.Close()
		t.Fatal("Open accepted invalid baud")
	}
}

// A valid config for a port that does not exist must return an error (no
// panic/hang) so the agent can report link_state=error.
func TestOpenMissingPortReturnsError(t *testing.T) {
	c := goodCfg()
	c.PortName = "COM250"
	done := make(chan error, 1)
	go func() {
		p, err := serial.Open(c)
		if err == nil {
			p.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Skip("COM250 exists on this machine")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Open hung on missing port")
	}
}

// ---- virtual COM pair ([manual] unless the runner provides one) ----
// Set LIMS_SERIAL_PAIR="COM5,COM6" (two ends of a com0com-class null-modem pair
// installed on the CI runner only; not shipped). Otherwise these tests skip and
// serial acceptance is [manual] per 06-IMPLEMENTATION-PLAN AG-T08.

func pair(t *testing.T) (a, b string) {
	t.Helper()
	v := os.Getenv("LIMS_SERIAL_PAIR")
	if v == "" {
		t.Skip("[manual] LIMS_SERIAL_PAIR not set (needs virtual COM pair, e.g. COM5,COM6)")
	}
	parts := strings.Split(v, ",")
	if len(parts) != 2 {
		t.Fatalf("LIMS_SERIAL_PAIR=%q, want \"COMx,COMy\"", v)
	}
	return strings.TrimSpace(parts[0]), strings.TrimSpace(parts[1])
}

func TestSerialPairRoundTripBothDirections(t *testing.T) {
	an, bn := pair(t)
	ca, cb := goodCfg(), goodCfg()
	ca.PortName, cb.PortName = an, bn
	pa, err := serial.Open(ca)
	if err != nil {
		t.Fatalf("open %s: %v", an, err)
	}
	defer pa.Close()
	pb, err := serial.Open(cb)
	if err != nil {
		t.Fatalf("open %s: %v", bn, err)
	}
	defer pb.Close()

	// ENQ ... EOT, raw bytes including control chars must survive untouched.
	msg := append(append([]byte{0x05}, bytes.Repeat([]byte("synthetic"), 40)...), 0x04)
	go pa.Write(msg)
	got := make([]byte, len(msg))
	if _, err := io.ReadFull(pb, got); err != nil {
		t.Fatalf("ReadFull B: %v", err)
	}
	if !bytes.Equal(got, msg) {
		t.Fatal("A->B bytes altered")
	}
	go pb.Write([]byte{0x06})
	ack := make([]byte, 1)
	if _, err := io.ReadFull(pa, ack); err != nil || ack[0] != 0x06 {
		t.Fatalf("B->A ack: %v %v", ack, err)
	}
}

func TestSerialCloseUnblocksReadAndPortIsReopenable(t *testing.T) {
	an, bn := pair(t)
	ca, cb := goodCfg(), goodCfg()
	ca.PortName, cb.PortName = an, bn
	pa, err := serial.Open(ca)
	if err != nil {
		t.Fatal(err)
	}
	pb, err := serial.Open(cb)
	if err != nil {
		t.Fatal(err)
	}
	defer pb.Close()

	done := make(chan struct{})
	go func() { pa.Read(make([]byte, 1)); close(done) }()
	time.Sleep(200 * time.Millisecond)
	pa.Close()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Close did not unblock Read")
	}
	pa2, err := serial.Open(ca) // transport change -> reconnect (03-APP-FLOW §6.3)
	if err != nil {
		t.Fatalf("reopen after Close: %v", err)
	}
	pa2.Close()
}
