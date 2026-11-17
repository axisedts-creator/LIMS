// Package astm implements the ASTM E1381 low-level layer and the E1394 record
// tokeniser (02-TRD §5.2, §5.3).
package astm

// Control characters (TRD §5.2.1).
const (
	STX byte = 0x02
	ETX byte = 0x03
	EOT byte = 0x04
	ENQ byte = 0x05
	ACK byte = 0x06
	NAK byte = 0x15
	ETB byte = 0x17
)

// Checksum is the sum of FN (as ASCII digit), every text byte and the
// terminator, modulo 256, as two uppercase hex characters (TRD §5.2.2).
func Checksum(fn int, text []byte, term byte) string {
	sum := byte('0'+fn) + term
	for _, b := range text {
		sum += b
	}
	const hexd = "0123456789ABCDEF"
	return string([]byte{hexd[sum>>4], hexd[sum&15]})
}
