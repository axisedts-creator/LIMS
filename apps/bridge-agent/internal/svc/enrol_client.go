package svc

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

const enrolPath = "/v1/instruments/agent/enrolments"

// HTTPEnroller executes E01 enrolAgent over verified HTTPS (TLS >= 1.2, no redirects, no proxy fallback).
type HTTPEnroller struct {
	ProxyURL string
	RootCAs  *x509.CertPool
	Timeout  time.Duration
}

func (e HTTPEnroller) Enrol(ctx context.Context, r EnrolRequest) (EnrolResult, error) {
	u, err := url.Parse(r.Server)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return EnrolResult{}, errors.New("enrol: server URL must be https://")
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: e.RootCAs}
	tr := &http.Transport{TLSClientConfig: tlsCfg, DisableCompression: true}
	proxyURL := e.ProxyURL
	if r.Proxy != "" {
		proxyURL = r.Proxy
	}
	if proxyURL != "" {
		p, err := url.Parse(proxyURL)
		if err != nil || (p.Scheme != "http" && p.Scheme != "https") || p.Host == "" {
			return EnrolResult{}, errors.New("enrol: invalid proxy URL")
		}
		tr.Proxy = http.ProxyURL(p)
	}
	timeout := e.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	hc := &http.Client{
		Transport: tr,
		Timeout:   timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	payload, err := json.Marshal(struct {
		HostFingerprintSHA256 string `json:"host_fingerprint_sha256"`
		AgentVersion          string `json:"agent_version"`
		LauncherVersion       string `json:"launcher_version"`
		OSVersion             string `json:"os_version"`
	}{
		HostFingerprintSHA256: r.HostFingerprintSHA256,
		AgentVersion:          r.AgentVersion,
		LauncherVersion:       r.LauncherVersion,
		OSVersion:             r.OSVersion,
	})
	if err != nil {
		return EnrolResult{}, err
	}
	target := strings.TrimRight(r.Server, "/") + enrolPath
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(payload))
	if err != nil {
		return EnrolResult{}, err
	}
	req.Header.Set("Authorization", "Bearer "+r.Code)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := hc.Do(req)
	if err != nil {
		return EnrolResult{}, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return EnrolResult{}, err
	}
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		var p struct {
			Code  string `json:"code"`
			Error *struct {
				Code string `json:"code"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &p)
		code := p.Code
		if code == "" && p.Error != nil {
			code = p.Error.Code
		}
		if code != "" {
			return EnrolResult{}, fmt.Errorf("HTTP %d (%s)", resp.StatusCode, code)
		}
		return EnrolResult{}, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var res struct {
		AgentID       string `json:"agent_id"`
		CentreID      string `json:"centre_id"`
		DeviceToken   string `json:"device_token"`
		ServerTime    string `json:"server_time"`
		ConfigVersion int    `json:"config_version"`
	}
	if err := json.Unmarshal(body, &res); err != nil {
		return EnrolResult{}, errors.New("enrol: malformed response")
	}
	return EnrolResult{
		AgentID:       res.AgentID,
		CentreID:      res.CentreID,
		DeviceToken:   res.DeviceToken,
		ServerTime:    res.ServerTime,
		ConfigVersion: res.ConfigVersion,
	}, nil
}
