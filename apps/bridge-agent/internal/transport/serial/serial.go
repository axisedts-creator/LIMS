// Package serial opens the agent's COM-port transport (TRD §5.8 kind=serial)
// on top of go.bug.st/serial. Bytes pass through untouched.
package serial

import (
	"fmt"
	"io"
	"regexp"

	bug "go.bug.st/serial"
)

// Config is the decoded transport for kind=serial. DTR/RTS nil = true [CONV].
type Config struct {
	PortName string
	BaudRate int
	DataBits int
	Parity   string
	StopBits string
	DTR, RTS *bool
}

var portRE = regexp.MustCompile(`^COM[1-9][0-9]{0,2}$`)

var parities = map[string]bug.Parity{
	"none": bug.NoParity, "odd": bug.OddParity, "even": bug.EvenParity,
	"mark": bug.MarkParity, "space": bug.SpaceParity,
}

var stopBits = map[string]bug.StopBits{
	"1": bug.OneStopBit, "1.5": bug.OnePointFiveStopBits, "2": bug.TwoStopBits,
}

var bauds = map[int]bool{1200: true, 2400: true, 4800: true, 9600: true, 19200: true, 38400: true, 57600: true, 115200: true}

// ValidateConfig applies the TRD §5.8 serial rules; nothing is defaulted.
func ValidateConfig(c Config) error {
	if !portRE.MatchString(c.PortName) {
		return fmt.Errorf("serial: port_name %q must match ^COM[1-9][0-9]{0,2}$", c.PortName)
	}
	if !bauds[c.BaudRate] {
		return fmt.Errorf("serial: baud_rate %d not allowed", c.BaudRate)
	}
	if c.DataBits != 7 && c.DataBits != 8 {
		return fmt.Errorf("serial: data_bits %d must be 7 or 8", c.DataBits)
	}
	if _, ok := parities[c.Parity]; !ok {
		return fmt.Errorf("serial: parity %q invalid", c.Parity)
	}
	if _, ok := stopBits[c.StopBits]; !ok {
		return fmt.Errorf("serial: stop_bits %q invalid", c.StopBits)
	}
	return nil
}

// Open validates cfg, then opens the port. Close unblocks a pending Read.
func Open(cfg Config) (io.ReadWriteCloser, error) {
	if err := ValidateConfig(cfg); err != nil {
		return nil, err
	}
	p, err := bug.Open(cfg.PortName, &bug.Mode{
		BaudRate: cfg.BaudRate,
		DataBits: cfg.DataBits,
		Parity:   parities[cfg.Parity],
		StopBits: stopBits[cfg.StopBits],
	})
	if err != nil {
		return nil, fmt.Errorf("serial: open %s: %w", cfg.PortName, err)
	}
	if err := p.SetDTR(cfg.DTR == nil || *cfg.DTR); err != nil {
		p.Close()
		return nil, fmt.Errorf("serial: set DTR: %w", err)
	}
	if err := p.SetRTS(cfg.RTS == nil || *cfg.RTS); err != nil {
		p.Close()
		return nil, fmt.Errorf("serial: set RTS: %w", err)
	}
	return p, nil
}
