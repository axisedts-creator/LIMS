package runtime

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"lims/apps/bridge-agent/internal/config"
	"lims/apps/bridge-agent/internal/mllp"
	"lims/apps/bridge-agent/internal/secrets"
	"lims/apps/bridge-agent/internal/status"
	"lims/apps/bridge-agent/internal/svc"
)

func pickNonLoopbackIPv4(t *testing.T) string {
	t.Helper()
	ifaces, err := net.Interfaces()
	if err != nil {
		t.Skipf("net.Interfaces: %v", err)
	}
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			ipn, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			v4 := ipn.IP.To4()
			if v4 == nil || v4.IsLoopback() || v4.IsLinkLocalUnicast() || v4.IsUnspecified() {
				continue
			}
			return v4.String()
		}
	}
	t.Skip("no active non-loopback IPv4 interface available")
	return ""
}

func freeTCPPort(t *testing.T, ip string) int {
	t.Helper()
	ln, err := net.Listen("tcp", net.JoinHostPort(ip, "0"))
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	_ = ln.Close()
	return port
}

func waitPortListening(t *testing.T, ip string, port int, deadline time.Duration) net.Conn {
	t.Helper()
	end := time.Now().Add(deadline)
	d := net.Dialer{Timeout: 200 * time.Millisecond, LocalAddr: &net.TCPAddr{IP: net.ParseIP(ip)}}
	for time.Now().Before(end) {
		c, err := d.Dial("tcp", net.JoinHostPort(ip, itoa(port)))
		if err == nil {
			_ = c.SetDeadline(time.Now().Add(8 * time.Second))
			return c
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for TCP listener %s:%d", ip, port)
	return nil
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [12]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

func TestRuntimeEndToEnd_TruthH80E_And_GeteinMetis(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	const (
		keyID     = "e2e-runtime-key-1"
		agentID   = "0190a000-0000-7000-8000-00000000d101"
		centreID  = "0190a000-0000-7000-8000-00000000c101"
		h80eID    = "0190a000-0000-7000-8000-00000000180e"
		metisID   = "0190a000-0000-7000-8000-000000002600"
		dropID    = "0190a000-0000-7000-8000-00000000f1de"
		enrolCode = "lmse_AbCdEfGhIjKlMnOpQrStUv"
		deviceTok = "lmsd_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCde"
	)

	lanIP := pickNonLoopbackIPv4(t)
	h80Port := freeTCPPort(t, lanIP)
	metisPort := freeTCPPort(t, lanIP)
	dropDir := t.TempDir()

	var (
		mu          sync.Mutex
		heartbeats  int
		lastHBVer   int
		batches     []map[string]any
		uploadedIDs = map[string]string{}
		hqCalls     []map[string]any
		envBytes    []byte
	)

	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/instruments/agent/enrolments":
			if r.Header.Get("Authorization") != "Bearer "+enrolCode {
				http.Error(w, `{"code":"auth.device_token_invalid"}`, http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"agent_id":"` + agentID + `","centre_id":"` + centreID + `","device_token":"` + deviceTok + `","server_time":"2026-11-25T06:00:00.000Z","config_version":1}`))

		case r.Method == http.MethodGet && r.URL.Path == "/v1/instruments/agent/config":
			if r.Header.Get("Authorization") != "Bearer "+deviceTok {
				http.Error(w, `{"code":"auth.device_token_invalid"}`, http.StatusUnauthorized)
				return
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(envBytes)

		case r.Method == http.MethodPost && r.URL.Path == "/v1/instruments/agent/heartbeats":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			mu.Lock()
			heartbeats++
			if cfg, ok := body["config"].(map[string]any); ok {
				if v, ok := cfg["applied_version"].(float64); ok {
					lastHBVer = int(v)
				}
			}
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"server_time":"` + time.Now().UTC().Format(tsUTC) + `","latest_config_version":1,"health_state":"online","commands":[]}`))

		case r.Method == http.MethodPost && r.URL.Path == "/v1/instruments/agent/host-queries":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			rawB64, _ := body["raw_base64"].(string)
			decoded, _ := base64.StdEncoding.DecodeString(rawB64)
			instID, _ := body["instrument_id"].(string)
			mu.Lock()
			hqCalls = append(hqCalls, body)
			mu.Unlock()

			var replies []string
			if instID == h80eID {
				qck := "MSH|^~\\&|LIS|LIMS|||20261125114500||QCK^Q02|12601|P|2.3|||||UTF-8||||\rMSA|AA|126|Message accepted|||0|\rERR|0|\rQAK|SR|OK||||||\r"
				dsr := "MSH|^~\\&|LIS|LIMS|||20261125114500||DSR^Q03|12602|P|2.3||||||UTF-8||||\rMSA|AA|126|Message accepted|||0|\rERR|0|\rQAK|1|OK||||||\rQRD|20261125114500|R|D|65|||RD||OTH|||T|\rDSP|1||SYN-P1|||\rDSP|5||2|||\rDSP|21||H80SYN001|||\rDSP|22||0|||\rDSC|0|\r"
				replies = []string{qck, dsr}
			} else {
				_ = decoded
				qck := "MSH|^~\\&|||||20261125114500||QCK^Q02|61|P|2.3.1||||||UTF8|||\rMSA|AA|61|Message accepted|||0|\rERR|0|\rQAK|SR|OK|\r"
				dsr := "MSH|^~\\&|||||20261125114500||DSR^Q03|61|P|2.3.1||||||UTF8|||\rMSA|AA|61|Message accepted|||0|\rERR|0|\rQAK|SR|OK|\rQRD|20261125114500|R|D|9|||RD|MTSYN001|OTH|||T|\rQRF||||||RCT|COR|ALL||\rDSP|21||MTSYN001|||\rDSP|26||serum|||\rDSP|29||100^^^|||\rDSC||\r"
				replies = []string{qck, dsr}
			}
			outReplies := make([]map[string]string, 0, len(replies))
			for _, m := range replies {
				outReplies = append(outReplies, map[string]string{"raw_base64": base64.StdEncoding.EncodeToString([]byte(m))})
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"server_time":           time.Now().UTC().Format(tsUTC),
				"instrument_message_id": "0190a000-0000-7000-8000-000000009999",
				"reply_messages":        outReplies,
				"answer_summary":        []map[string]any{{"index": 0, "status": "found", "test_count": 1}},
			})

		case r.Method == http.MethodPost && r.URL.Path == "/v1/instruments/agent/message-batches":
			rawBody, _ := io.ReadAll(r.Body)
			var body struct {
				Messages []struct {
					AgentMessageID string `json:"agent_message_id"`
					InstrumentID   string `json:"instrument_id"`
					Protocol       string `json:"protocol"`
					Kind           string `json:"kind"`
					RawBase64      string `json:"raw_base64"`
				} `json:"messages"`
			}
			_ = json.Unmarshal(rawBody, &body)
			results := make([]map[string]any, 0, len(body.Messages))
			mu.Lock()
			batches = append(batches, map[string]any{"count": len(body.Messages)})
			for _, msg := range body.Messages {
				if msg.Protocol == "file_drop" || msg.Kind == "attachment" {
					mu.Unlock()
					http.Error(w, `{"error":{"code":"common.validation_failed"}}`, http.StatusBadRequest)
					return
				}
				uploadedIDs[msg.AgentMessageID] = msg.InstrumentID + ":" + msg.Kind
				results = append(results, map[string]any{
					"agent_message_id":      msg.AgentMessageID,
					"outcome":               "accepted",
					"instrument_message_id": "0190a000-0000-7000-8000-000000008888",
				})
			}
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"server_time": time.Now().UTC().Format(tsUTC),
				"results":     results,
			})

		case r.Method == http.MethodPost && r.URL.Path == "/v1/instruments/agent/attachments":
			if err := r.ParseMultipartForm(4 << 20); err != nil {
				http.Error(w, `{"error":{"code":"common.validation_failed"}}`, http.StatusBadRequest)
				return
			}
			var meta struct {
				AgentMessageID string `json:"agent_message_id"`
				InstrumentID   string `json:"instrument_id"`
				FileName       string `json:"file_name"`
			}
			if err := json.Unmarshal([]byte(r.FormValue("metadata")), &meta); err != nil || meta.AgentMessageID == "" || meta.FileName == "" {
				http.Error(w, `{"error":{"code":"common.validation_failed"}}`, http.StatusBadRequest)
				return
			}
			mu.Lock()
			uploadedIDs[meta.AgentMessageID] = meta.InstrumentID + ":attachment:" + meta.FileName
			mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"outcome":               "accepted",
				"instrument_message_id": "0190a000-0000-7000-8000-000000007777",
				"attachment_id":         "0190a000-0000-7000-8000-000000007778",
				"scan_state":            "pending",
			})

		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	pool := x509.NewCertPool()
	pool.AddCert(srv.Certificate())
	spkiSum := sha256.Sum256(srv.Certificate().RawSubjectPublicKeyInfo)
	spkiPin := hex.EncodeToString(spkiSum[:])

	doc := Document{
		Schema:                   "lims.bridge.config.v1",
		AgentID:                  agentID,
		CentreID:                 centreID,
		ConfigVersion:            1,
		IssuedAt:                 "2026-11-25T06:00:00.000Z",
		HeartbeatIntervalSeconds: 2,
		Upload: UploadConfig{
			MaxBatchMessages:       50,
			MaxBatchBytes:          2097152,
			FlushIntervalSeconds:   1,
			UploadedRetentionHours: 24,
		},
		RateBudget: RateBudgetConfig{
			RequestsPerMinute:          120,
			ReservedHostQueryPerMinute: 60,
			ReservedHeartbeatPerMinute: 2,
		},
		TLS:      TLSConfig{SPKIPinsSHA256: []string{spkiPin}},
		LogLevel: "info",
		Update:   UpdateConfig{Channel: "stable", Target: nil, AllowDowngrade: false, Window: nil},
		Instruments: []InstrumentConfig{
			{
				InstrumentID:   h80eID,
				InstrumentCode: "SYN-H80E-01",
				DriverCode:     "truth_h80e",
				Protocol:       "hl7v2",
				State:          "live",
				Enabled:        true,
				Capabilities:   CapabilitiesConfig{HostQuery: true, WorklistDownload: false},
				Transport: TransportConfig{
					Kind:         "tcp_server",
					BindAddress:  lanIP,
					Port:         h80Port,
					AllowedPeers: []string{lanIP},
				},
				Timezone: "Asia/Kathmandu",
			},
			{
				InstrumentID:   metisID,
				InstrumentCode: "SYN-METIS-01",
				DriverCode:     "getein_metis",
				Protocol:       "hl7v2",
				State:          "live",
				Enabled:        true,
				Capabilities:   CapabilitiesConfig{HostQuery: true, WorklistDownload: false},
				Transport: TransportConfig{
					Kind:         "tcp_server",
					BindAddress:  lanIP,
					Port:         metisPort,
					AllowedPeers: []string{lanIP},
				},
				Timezone: "Asia/Kathmandu",
			},
			{
				InstrumentID:   dropID,
				InstrumentCode: "SYN-DROP-01",
				DriverCode:     "generic_csv",
				Protocol:       "file_drop",
				State:          "live",
				Enabled:        true,
				Transport: TransportConfig{
					Kind:          "file_drop",
					Directory:     dropDir,
					AllowedTypes:  []string{"pdf"},
					StableSeconds: 2,
				},
				Timezone: "Asia/Kathmandu",
			},
		},
	}

	rawDoc, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	canon, err := config.Canonicalize(rawDoc)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(priv, canon)
	envBytes, err = json.Marshal(map[string]any{
		"alg":       "Ed25519",
		"key_id":    keyID,
		"signature": base64.RawURLEncoding.EncodeToString(sig),
		"document":  json.RawMessage(rawDoc),
	})
	if err != nil {
		t.Fatal(err)
	}

	dir := t.TempDir()
	layout := svc.NewLayout(dir, dir)
	layout.DataRoot = filepath.Join(dir, "LIMS", "BridgeAgent")
	for _, d := range layout.Dirs() {
		if err := os.MkdirAll(d, 0o700); err != nil {
			t.Fatal(err)
		}
	}

	// Simulate real E01 enrolment via HTTPEnroller + DPAPI token wrapping
	enr := svc.HTTPEnroller{RootCAs: pool, Timeout: 5 * time.Second}
	res, err := enr.Enrol(context.Background(), svc.EnrolRequest{
		Server:                srv.URL,
		Code:                  enrolCode,
		HostFingerprintSHA256: strings.Repeat("a", 64),
		AgentVersion:          "1.0.0",
		LauncherVersion:       "1.0.0",
		OSVersion:             "Windows 11",
	})
	if err != nil {
		t.Fatalf("enrol failed: %v", err)
	}
	if err := svc.WriteConfigLocal(layout, srv.URL, "", res.AgentID); err != nil {
		t.Fatal(err)
	}
	if err := secrets.SaveToken(layout.SecretsDir(), res.DeviceToken, secrets.NewDPAPI(secrets.ScopeMachine, []byte(res.AgentID))); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runErr := make(chan error, 1)
	ready := make(chan struct{})
	var once sync.Once
	go func() {
		runErr <- Run(ctx, Options{
			Layout:          layout,
			AgentVersion:    "1.0.0",
			LauncherVersion: "1.0.0",
			OSVersion:       "Windows 11",
			Out:             &bytes.Buffer{},
			OnReady:         func(func(uint32) bool) { once.Do(func() { close(ready) }) },
			trustedKeys:     config.TrustedKeys{keyID: pub},
			rootCAs:         pool,
		})
	}()

	select {
	case <-ready:
	case <-time.After(10 * time.Second):
		t.Fatal("runtime did not become ready")
	}

	// 1. Truth-H80E flow: ORU result + QRY host query
	h80Conn := waitPortListening(t, lanIP, h80Port, 10*time.Second)
	defer h80Conn.Close()
	h80ORU := "MSH|^~\\&|Truth|Truth-H80E|||20261125114500||ORU^R01|101|P|2.3||||||UTF-8||||\rPID|1||SYN-P1|\rOBR|1||H80SYN001|\rOBX|1|NM|HbA1c_NGSP||6.4|%|\r"
	if _, err := h80Conn.Write(mllp.Encode([]byte(h80ORU))); err != nil {
		t.Fatal(err)
	}
	h80Rd := mllp.NewReader(h80Conn, 0, nil)
	ackEv, err := h80Rd.Next()
	if err != nil || !strings.Contains(string(ackEv.Data), "MSA|AA|101") {
		t.Fatalf("unexpected H80E ACK: %q err=%v", string(ackEv.Data), err)
	}

	h80QRY := "MSH|^~\\&|Truth|Truth-H80E|||20261125114500||QRY^Q02|126|P|2.3||||||UTF-8||||\rQRD|20261125114500|R|D|65|||RD|H80SYN001||||\rQRF|||||RCT|COR|ALL|||\r"
	if _, err := h80Conn.Write(mllp.Encode([]byte(h80QRY))); err != nil {
		t.Fatal(err)
	}
	qckEv, err := h80Rd.Next()
	if err != nil || !strings.Contains(string(qckEv.Data), "QCK^Q02") || !strings.Contains(string(qckEv.Data), "QAK|SR|OK") {
		t.Fatalf("unexpected H80E QCK: %q err=%v", string(qckEv.Data), err)
	}
	dsrEv, err := h80Rd.Next()
	if err != nil || !strings.Contains(string(dsrEv.Data), "DSR^Q03") {
		t.Fatalf("unexpected H80E DSR: %q err=%v", string(dsrEv.Data), err)
	}
	// Reply with ACK^Q03 to conclude H80E host-query exchange
	_, _ = h80Conn.Write(mllp.Encode([]byte("MSH|^~\\&|Truth|Truth-H80E|||20261125114501||ACK^Q03|12602|P|2.3||||||UTF-8||||\rMSA|AA|12602|\r")))

	// 2. Getein Metis 6000 flow: ORU result (MSH-16=0) + QRY host query
	metConn := waitPortListening(t, lanIP, metisPort, 10*time.Second)
	defer metConn.Close()
	metORU := "MSH|^~\\&|Getein|Metis6000|||20261125114500||ORU^R01|601|P|2.3.1||||0||UTF8|||\rPID|1||SYN-P2|\rOBR|1||MTSYN001|\rOBX|1|NM|100||5.2|mmol/L|\r"
	if _, err := metConn.Write(mllp.Encode([]byte(metORU))); err != nil {
		t.Fatal(err)
	}
	metRd := mllp.NewReader(metConn, 0, nil)
	metAck, err := metRd.Next()
	if err != nil || !strings.HasPrefix(string(metAck.Data), "MSH|^~\\&|LIS|LIMS|") || !strings.Contains(string(metAck.Data), "MSA|AA|601|Message accepted|||0|") || !strings.Contains(string(metAck.Data), "||||0||UTF8") {
		t.Fatalf("unexpected Metis full-form ACK: %q err=%v", string(metAck.Data), err)
	}

	metQRY := "MSH|^~\\&|||||20261125114500||QRY^Q02|61|P|2.3.1||||||UTF8|||\rQRD|20261125114500|R|D|9|||RD|MTSYN001|OTH|||T|\rQRF||||||RCT|COR|ALL||\r"
	if _, err := metConn.Write(mllp.Encode([]byte(metQRY))); err != nil {
		t.Fatal(err)
	}
	metQCK, err := metRd.Next()
	if err != nil || !strings.Contains(string(metQCK.Data), "QCK^Q02") || !strings.Contains(string(metQCK.Data), "QAK|SR|OK") {
		t.Fatalf("unexpected Metis QCK: %q err=%v", string(metQCK.Data), err)
	}
	metDSR, err := metRd.Next()
	if err != nil || !strings.Contains(string(metDSR.Data), "DSR^Q03") || !strings.Contains(string(metDSR.Data), "DSP|29||100^^^") {
		t.Fatalf("unexpected Metis DSR: %q err=%v", string(metDSR.Data), err)
	}
	_, _ = metConn.Write(mllp.Encode([]byte("MSH|^~\\&|||||20261125114501||ACK^Q03|61|P|2.3.1||||||UTF8|||\rMSA|AA|61|Message accepted|||0|\r")))

	// 3. File-drop flow: write synthetic file and confirm upload via /message-batches
	if err := os.WriteFile(filepath.Join(dropDir, "DROP001.pdf"), []byte("%PDF-1.4\nsynthetic-report\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Wait for batch uploader & heartbeat ticks to flush data items
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		mu.Lock()
		nUploaded := len(uploadedIDs)
		nHQ := len(hqCalls)
		nHB := heartbeats
		hbVer := lastHBVer
		mu.Unlock()
		if nUploaded >= 3 && nHQ == 2 && nHB >= 1 && hbVer == 1 {
			break
		}
		time.Sleep(150 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(uploadedIDs) != 3 {
		t.Fatalf("expected 3 uploaded data items (2 ORU + 1 file_drop), got %d (%v)", len(uploadedIDs), uploadedIDs)
	}
	if len(hqCalls) != 2 {
		t.Fatalf("expected 2 host-query relay calls, got %d", len(hqCalls))
	}
	if heartbeats < 1 || lastHBVer != 1 {
		t.Fatalf("expected >=1 heartbeat with applied_version=1, got count=%d ver=%d", heartbeats, lastHBVer)
	}
	st, err := status.Read(layout.StatusDir())
	if err != nil || st.ServiceState != "running" || st.ConfigVersion != 1 {
		t.Fatalf("unexpected status.json: %+v err=%v", st, err)
	}
	if _, err := os.Stat(filepath.Join(layout.DataRoot, "healthy.json")); err != nil {
		t.Fatalf("expected healthy.json after first heartbeat: %v", err)
	}

	cancel()
	if rerr := <-runErr; rerr != nil {
		t.Fatalf("runtime exited with error: %v", rerr)
	}
}
