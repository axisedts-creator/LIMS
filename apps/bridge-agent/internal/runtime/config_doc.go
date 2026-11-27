package runtime

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"lims/apps/bridge-agent/internal/transport/serial"
	"lims/apps/bridge-agent/internal/transport/tcp"
)

type Document struct {
	Schema                   string             `json:"schema"`
	AgentID                  string             `json:"agent_id"`
	CentreID                 string             `json:"centre_id"`
	ConfigVersion            int64              `json:"config_version"`
	IssuedAt                 string             `json:"issued_at"`
	HeartbeatIntervalSeconds int                `json:"heartbeat_interval_seconds"`
	Upload                   UploadConfig       `json:"upload"`
	RateBudget               RateBudgetConfig   `json:"rate_budget"`
	TLS                      TLSConfig          `json:"tls"`
	LogLevel                 string             `json:"log_level"`
	Update                   UpdateConfig       `json:"update"`
	Instruments              []InstrumentConfig `json:"instruments"`
}

type UploadConfig struct {
	MaxBatchMessages       int `json:"max_batch_messages"`
	MaxBatchBytes          int `json:"max_batch_bytes"`
	FlushIntervalSeconds   int `json:"flush_interval_seconds"`
	UploadedRetentionHours int `json:"uploaded_retention_hours"`
}

type RateBudgetConfig struct {
	RequestsPerMinute            int `json:"requests_per_minute"`
	ReservedHostQueryPerMinute   int `json:"reserved_host_query_per_minute"`
	ReservedHeartbeatPerMinute   int `json:"reserved_heartbeat_per_minute"`
}

type TLSConfig struct {
	SPKIPinsSHA256 []string `json:"spki_pins_sha256"`
}

type UpdateTarget struct {
	ReleaseID             string `json:"release_id"`
	Version               string `json:"version"`
	PackageSHA256         string `json:"package_sha256"`
	PackageSize           int64  `json:"package_size"`
	Signature             string `json:"signature"`
	KeyID                 string `json:"key_id"`
	AuthenticodePublisher string `json:"authenticode_publisher"`
}

type UpdateWindow struct {
	From     string `json:"from"`
	To       string `json:"to"`
	Timezone string `json:"timezone"`
}

type UpdateConfig struct {
	Channel        string        `json:"channel"`
	Target         *UpdateTarget `json:"target"`
	AllowDowngrade bool          `json:"allow_downgrade"`
	Window         *UpdateWindow `json:"window"`
}

type CapabilitiesConfig struct {
	HostQuery        bool `json:"host_query"`
	WorklistDownload bool `json:"worklist_download"`
}

type TransportConfig struct {
	Kind                 string   `json:"kind"`
	BindAddress          string   `json:"bind_address"`
	Host                 string   `json:"host"`
	Port                 int      `json:"port"`
	AllowedPeers         []string `json:"allowed_peers"`
	ConnectTimeoutS      int      `json:"connect_timeout_s"`
	ReconnectMaxBackoffS int      `json:"reconnect_max_backoff_s"`
	PortName             string   `json:"port_name"`
	BaudRate             int      `json:"baud_rate"`
	DataBits             int      `json:"data_bits"`
	Parity               string   `json:"parity"`
	StopBits             string   `json:"stop_bits"`
	DTR                  *bool    `json:"dtr"`
	RTS                  *bool    `json:"rts"`
	Directory            string   `json:"directory"`
	FilenamePattern      string   `json:"filename_pattern"`
	AllowedTypes         []string `json:"allowed_types"`
	StableSeconds        int      `json:"stable_seconds"`
	BarcodeRegex         string   `json:"barcode_regex"`
	MoveAfterCapture     bool     `json:"move_after_capture"`
	CapturedSubdirectory string   `json:"captured_subdirectory"`
}

type HL7v2ProtocolOptions struct {
	AckMode            string `json:"ack_mode"`
	AckSendingApp      string `json:"ack_sending_app"`
	AckSendingFacility string `json:"ack_sending_facility"`
	AckTimeoutS        int    `json:"ack_timeout_s"`
	SendRetries        *int   `json:"send_retries"`
	MaxMessageBytes    int    `json:"max_message_bytes"`
}

type ASTMProtocolOptions struct {
	EnqWaitS            int  `json:"enq_wait_s"`
	EstablishReplyS     int  `json:"establish_reply_s"`
	NakRetryDelayS      int  `json:"nak_retry_delay_s"`
	ReceiveIdleTimeoutS int  `json:"receive_idle_timeout_s"`
	ReceiverFrameWaitS  int  `json:"receiver_frame_wait_s"`
	MaxFrameSends       int  `json:"max_frame_sends"`
	MaxEnqAttempts      int  `json:"max_enq_attempts"`
	IdleBeforeEnqS      int  `json:"idle_before_enq_s"`
	ContentionBackoffS  int  `json:"contention_backoff_s"`
	MaxFrameBytes       int  `json:"max_frame_bytes"`
	StrictChecksum      bool `json:"strict_checksum"`
	EscapeCheck         bool `json:"escape_check"`
}

type ProtocolOptions struct {
	ASTM  *ASTMProtocolOptions  `json:"astm"`
	HL7v2 *HL7v2ProtocolOptions `json:"hl7v2"`
}

type FileDropConfig struct {
	Directory            string   `json:"directory"`
	FilenamePattern      string   `json:"filename_pattern"`
	AllowedTypes         []string `json:"allowed_types"`
	StableSeconds        int      `json:"stable_seconds"`
	BarcodeRegex         string   `json:"barcode_regex"`
	MoveAfterCapture     bool     `json:"move_after_capture"`
	CapturedSubdirectory string   `json:"captured_subdirectory"`
}

// EffectiveFileDrop resolves the active FileDropConfig from Transport (when protocol == "file_drop") or FileDrop.
func (ic InstrumentConfig) EffectiveFileDrop() *FileDropConfig {
	if ic.Protocol == "file_drop" && ic.Transport.Kind == "file_drop" && strings.TrimSpace(ic.Transport.Directory) != "" {
		return &FileDropConfig{
			Directory:            ic.Transport.Directory,
			FilenamePattern:      ic.Transport.FilenamePattern,
			AllowedTypes:         ic.Transport.AllowedTypes,
			StableSeconds:        ic.Transport.StableSeconds,
			BarcodeRegex:         ic.Transport.BarcodeRegex,
			MoveAfterCapture:     ic.Transport.MoveAfterCapture,
			CapturedSubdirectory: ic.Transport.CapturedSubdirectory,
		}
	}
	if ic.FileDrop != nil && strings.TrimSpace(ic.FileDrop.Directory) != "" {
		return ic.FileDrop
	}
	return nil
}

type InstrumentConfig struct {
	InstrumentID    string             `json:"instrument_id"`
	InstrumentCode  string             `json:"instrument_code"`
	DriverCode      string             `json:"driver_code"`
	Protocol        string             `json:"protocol"`
	State           string             `json:"state"`
	Enabled         bool               `json:"enabled"`
	Capabilities    CapabilitiesConfig `json:"capabilities"`
	Transport       TransportConfig    `json:"transport"`
	ProtocolOptions ProtocolOptions    `json:"protocol_options"`
	ParserOptions   map[string]any     `json:"parser_options"`
	FileDrop        *FileDropConfig    `json:"file_drop"`
	Timezone        string             `json:"timezone"`
}

func ParseDocument(raw []byte) (Document, error) {
	var d Document
	if err := json.Unmarshal(raw, &d); err != nil {
		return Document{}, fmt.Errorf("runtime: decode config document: %w", err)
	}
	if d.HeartbeatIntervalSeconds <= 0 {
		d.HeartbeatIntervalSeconds = 60
	}
	if d.Upload.FlushIntervalSeconds <= 0 {
		d.Upload.FlushIntervalSeconds = 5
	}
	if d.Upload.UploadedRetentionHours <= 0 {
		d.Upload.UploadedRetentionHours = 24
	}
	for _, p := range d.TLS.SPKIPinsSHA256 {
		if b, err := hex.DecodeString(p); err != nil || len(b) != sha256.Size {
			return Document{}, fmt.Errorf("runtime: invalid tls.spki_pins_sha256 entry")
		}
	}
	for _, ic := range d.Instruments {
		if err := validateInstrumentConfig(ic); err != nil {
			return Document{}, fmt.Errorf("runtime: instrument %s: %w", ic.InstrumentCode, err)
		}
	}
	return d, nil
}

func validateInstrumentConfig(ic InstrumentConfig) error {
	if !ic.Enabled {
		return nil
	}
	switch ic.Protocol {
	case "astm", "hl7v2", "file_drop":
	default:
		return fmt.Errorf("unsupported protocol %q", ic.Protocol)
	}
	switch ic.Transport.Kind {
	case "tcp_server":
		if err := tcp.ValidateListenConfig(tcp.ListenConfig{
			BindAddress:  ic.Transport.BindAddress,
			Port:         ic.Transport.Port,
			AllowedPeers: ic.Transport.AllowedPeers,
		}); err != nil {
			return err
		}
	case "tcp_client":
		ct := ic.Transport.ConnectTimeoutS
		if ct == 0 {
			ct = 5
		}
		mb := ic.Transport.ReconnectMaxBackoffS
		if mb == 0 {
			mb = 30
		}
		if err := tcp.ValidateClientConfig(tcp.ClientConfig{
			Host:                ic.Transport.Host,
			Port:                ic.Transport.Port,
			ConnectTimeout:      time.Duration(ct) * time.Second,
			ReconnectMaxBackoff: time.Duration(mb) * time.Second,
		}); err != nil {
			return err
		}
	case "serial":
		if err := serial.ValidateConfig(serial.Config{
			PortName: ic.Transport.PortName,
			BaudRate: ic.Transport.BaudRate,
			DataBits: ic.Transport.DataBits,
			Parity:   ic.Transport.Parity,
			StopBits: ic.Transport.StopBits,
			DTR:      ic.Transport.DTR,
			RTS:      ic.Transport.RTS,
		}); err != nil {
			return err
		}
	case "file_drop":
		if fd := ic.EffectiveFileDrop(); fd == nil || strings.TrimSpace(fd.Directory) == "" {
			return fmt.Errorf("file_drop directory is required")
		}
	default:
		return fmt.Errorf("unsupported transport.kind %q", ic.Transport.Kind)
	}
	return nil
}
