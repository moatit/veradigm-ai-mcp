package main

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// Link to the Drawbridge voice harness (src/platform/modules/voice/gw-server.ts): a WebSocket on the internal
// Docker network, never published on the host. Authenticated per connection with an HMAC over a fresh
// timestamp + nonce under VOICE_GW_SECRET (the harness refuses stale timestamps and replayed nonces).
//
// Text frames: JSON control messages (protocol below). Binary frames: byte 0 = leg index, then PCM s16le mono at
// the rate the harness chose in "accept". gw->harness: each human leg's inbound audio, 20 ms frames, leg 0 =
// the inbound caller, 1.. = legs this session dialled. harness->gw: agent audio for one leg (any size), or
// leg 255 = every leg currently in the local conference.

const authHeader = "X-Voice-Gw-Auth"

// AuthToken builds the header value: v1,kind=<call|control>,ts=<unix>,nonce=<hex>,mac=<hex>.
func AuthToken(secret, kind string, now time.Time) string {
	nb := make([]byte, 16)
	_, _ = rand.Read(nb)
	nonce := hex.EncodeToString(nb)
	ts := now.Unix()
	return fmt.Sprintf("v1,kind=%s,ts=%d,nonce=%s,mac=%s", kind, ts, nonce, authMAC(secret, kind, ts, nonce))
}

func authMAC(secret, kind string, ts int64, nonce string) string {
	m := hmac.New(sha256.New, []byte(secret))
	fmt.Fprintf(m, "drawbridge-voice-gw|v1|%s|%d|%s", kind, ts, nonce)
	return hex.EncodeToString(m.Sum(nil))
}

func DialHarness(ctx context.Context, cfg *Config, kind string) (*websocket.Conn, error) {
	h := http.Header{}
	h.Set(authHeader, AuthToken(cfg.Secret, kind, time.Now()))
	dctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(dctx, cfg.HarnessURL, &websocket.DialOptions{HTTPHeader: h})
	if resp != nil && resp.Body != nil {
		resp.Body.Close()
	}
	if err != nil {
		code := 0
		if resp != nil {
			code = resp.StatusCode
		}
		return nil, fmt.Errorf("harness dial failed (http %d)", code)
	}
	c.SetReadLimit(4 << 20)
	return c, nil
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────────────

// gw -> harness
type CallStart struct {
	Type       string   `json:"type"` // call_start
	CallRef    string   `json:"call_ref"`
	From       string   `json:"from"`       // caller number as the PBX presented it (P-Asserted-Identity, else From)
	FromName   string   `json:"from_name"`  // display name as presented (unverified)
	To         string   `json:"to"`         // dialled user
	SRTP       bool     `json:"srtp"`       // offer carried SRTP (RTP/SAVP + crypto)
	Codecs     []string `json:"codecs"`     // offered audio codecs
	MediaRule  string   `json:"media_rule"` // srtp-required | srtp-preferred-synthetic-only
	Registered bool     `json:"registered"`
}

// harness -> gw
type Control struct {
	Type      string `json:"type"` // accept | reject | segment | segment_end | clear | transfer | hangup | dial | hold | resume | conference | ping
	Leg       int    `json:"leg"`
	Legs      []int  `json:"legs,omitempty"`
	RequestID string `json:"request_id,omitempty"`
	TimeoutS  int    `json:"timeout_s,omitempty"`
	// transfer: attended (REFER with Replaces) towards the party on ReplacesLeg instead of a blind REFER
	ReplacesLeg *int   `json:"replaces_leg,omitempty"`
	CallID      string `json:"call_id,omitempty"`
	PCMRate     int    `json:"pcm_rate,omitempty"`
	Code        int    `json:"code,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Segment     string `json:"segment,omitempty"`
	Target      string `json:"target,omitempty"`
	Announce    string `json:"announce,omitempty"`
}

// gw -> harness, during the call
type Event struct {
	Type      string   `json:"type"`
	At        int64    `json:"at"` // unix ms
	Leg       int      `json:"leg"`
	RequestID string   `json:"request_id,omitempty"`
	Codec     string   `json:"codec,omitempty"`
	SRTP      *bool    `json:"srtp,omitempty"`
	Digit     string   `json:"digit,omitempty"`
	Segment   string   `json:"segment,omitempty"`
	PlayedMs  *int     `json:"played_ms,omitempty"`
	LatencyMs *int     `json:"latency_ms,omitempty"` // playout_started: caller end-of-speech -> first agent audio out
	Code      int      `json:"code,omitempty"`
	Reason    string   `json:"reason,omitempty"`
	By        string   `json:"by,omitempty"`
	PktsIn    int      `json:"pkts_in,omitempty"`
	PktsOut   int      `json:"pkts_out,omitempty"`
	FirstInMs *int     `json:"first_in_ms,omitempty"`
	Target    string   `json:"target,omitempty"`
	Quality   *Quality `json:"quality,omitempty"`
}

func writeJSON(ctx context.Context, c *websocket.Conn, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return c.Write(wctx, websocket.MessageText, b)
}

func nowMs() int64 { return time.Now().UnixMilli() }

func intp(v int) *int    { return &v }
func boolp(v bool) *bool { return &v }
