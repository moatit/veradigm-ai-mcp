package main

import (
	"encoding/json"
	"os"
	"sync"
	"time"
)

// Status is the registration state: written to VOICE_GW_STATUS_FILE (container healthcheck) and sent to the
// harness on the control link (system status + security events there). No secrets, no caller data.
type Status struct {
	mu   sync.Mutex
	file string
	S    StatusSnapshot
	sub  func(StatusSnapshot)
}

type StatusSnapshot struct {
	Type            string `json:"type"` // status
	Registered      bool   `json:"registered"`
	Proxy           string `json:"proxy"`
	Transport       string `json:"transport"`
	TLSVersion      string `json:"tls_version"`
	TLSCipher       string `json:"tls_cipher"`
	TLSVerifiedName string `json:"tls_verified_name"`
	PublicIP        string `json:"public_ip"`
	SeenAs          string `json:"seen_as"` // address the PBX saw (REGISTER Via received/rport)
	ExpiresSec      int    `json:"expires_sec"`
	LastError       string `json:"last_error"`
	RegisteredAt    string `json:"registered_at"`
	UpdatedAt       string `json:"updated_at"`
	ActiveCalls     int    `json:"active_calls"`
	Panics          int64  `json:"panics_recovered"`
	MediaRule       string `json:"media_rule"`
	Mode            string `json:"mode"`
}

func NewStatus(file string) *Status { return &Status{file: file, S: StatusSnapshot{Type: "status"}} }

func (s *Status) Update(f func(*StatusSnapshot)) StatusSnapshot {
	s.mu.Lock()
	f(&s.S)
	s.S.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	snap := s.S
	sub := s.sub
	s.mu.Unlock()
	if b, err := json.Marshal(snap); err == nil {
		tmp := s.file + ".tmp"
		if os.WriteFile(tmp, b, 0o600) == nil {
			_ = os.Rename(tmp, s.file)
		}
	}
	if sub != nil {
		sub(snap)
	}
	return snap
}

func (s *Status) Snapshot() StatusSnapshot {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.S
}

func (s *Status) Subscribe(f func(StatusSnapshot)) {
	s.mu.Lock()
	s.sub = f
	s.mu.Unlock()
}

// Healthcheck (docker HEALTHCHECK, distroless: no shell): healthy when registered and the file was updated in
// the last 90 s (the keepalive refreshes it every 25 s).
func Healthcheck(file string) int {
	b, err := os.ReadFile(file)
	if err != nil {
		return 1
	}
	var s StatusSnapshot
	if json.Unmarshal(b, &s) != nil || !s.Registered {
		return 1
	}
	t, err := time.Parse(time.RFC3339, s.UpdatedAt)
	if err != nil || time.Since(t) > 90*time.Second {
		return 1
	}
	return 0
}
