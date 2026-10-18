package main

import (
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Config comes from the environment only. SIP_* are the extension's credentials (deploy/local/.env, never in
// code, image, logs or Git). Everything else is non-secret wiring set in docker-compose.yml.
type Config struct {
	// Extension (secrets: SIP_USERNAME, SIP_PASSWORD)
	Realm    string
	Username string
	Password string
	AORUser  string
	Expires  time.Duration

	// Signalling: TLS to the PBX's proxies, certificate verified against the system roots and the one
	// explicitly allowed certificate name (the Titan proxies present kam001.phl.wlcomm.net, not their own name).
	Proxies       []string // host:port, tried in order
	TLSServerName string

	// Media
	MediaPolicy string // srtp-required | srtp-preferred-synthetic-only
	PublicIP    string // optional override; else STUN
	StunServer  string // host:port; empty = no STUN (SDP carries the container address)
	RTPMin      int
	RTPMax      int
	MaxCalls    int

	// Harness link
	Mode           string // harness | greeting-echo
	HarnessURL     string // ws://unity:3010/voice-gw (internal Docker network only)
	Secret         string // VOICE_GW_SECRET (shared with the Drawbridge harness)
	GreetingWAV    string
	FallbackTarget string // REFER target if the harness drops mid-call (optional)

	StatusFile string
	UserAgent  string
}

const (
	PolicySRTPRequired  = "srtp-required"
	PolicySRTPPreferred = "srtp-preferred-synthetic-only"
	ModeHarness         = "harness"
	ModeGreetingEcho    = "greeting-echo"
)

var (
	hostRe      = regexp.MustCompile(`^[A-Za-z0-9.\-]{1,253}$`)
	aorUserRe   = regexp.MustCompile(`^[A-Za-z0-9._\-+]{1,64}$`)
	hostPortRe  = regexp.MustCompile(`^[A-Za-z0-9.\-]{1,253}:[0-9]{1,5}$`)
	referUserRe = regexp.MustCompile(`^[0-9*#]{1,20}$`)
)

func env(k, d string) string {
	if v := strings.TrimSpace(os.Getenv(k)); v != "" {
		return v
	}
	return d
}

func envInt(k string, d int) int {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return d
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return d
	}
	return n
}

// LoadConfig reads and validates the configuration. Errors never contain secret values.
func LoadConfig() (*Config, error) {
	c := &Config{
		Realm:          env("SIP_REALM", env("SIP_SERVER", "")),
		Username:       os.Getenv("SIP_USERNAME"),
		Password:       os.Getenv("SIP_PASSWORD"),
		AORUser:        env("VOICE_SIP_AOR_USER", os.Getenv("SIP_USERNAME")),
		Expires:        time.Duration(envInt("SIP_EXPIRES", 300)) * time.Second,
		TLSServerName:  env("VOICE_SIP_TLS_SERVER_NAME", ""),
		MediaPolicy:    env("VOICE_MEDIA_ENCRYPTION", PolicySRTPRequired),
		PublicIP:       env("VOICE_PUBLIC_IP", ""),
		StunServer:     env("VOICE_STUN_SERVER", ""),
		RTPMin:         envInt("VOICE_RTP_PORT_MIN", 20000),
		RTPMax:         envInt("VOICE_RTP_PORT_MAX", 20199),
		MaxCalls:       envInt("VOICE_MAX_CALLS", 4),
		Mode:           env("VOICE_GW_MODE", ModeHarness),
		HarnessURL:     env("VOICE_HARNESS_URL", "ws://unity:3010/voice-gw"),
		Secret:         os.Getenv("VOICE_GW_SECRET"),
		GreetingWAV:    env("VOICE_GW_GREETING_WAV", "/app/clips/stage2-greeting.wav"),
		FallbackTarget: env("VOICE_GW_FALLBACK_TARGET", ""),
		StatusFile:     env("VOICE_GW_STATUS_FILE", "/tmp/voice-gw-status.json"),
		UserAgent:      env("VOICE_GW_USER_AGENT", "Drawbridge-voice-gw/0.1"),
	}
	for _, p := range strings.Split(env("VOICE_SIP_PROXIES", ""), ",") {
		if p = strings.TrimSpace(p); p != "" {
			c.Proxies = append(c.Proxies, p)
		}
	}
	return c, c.Validate()
}

// Validate fails closed: no TLS proxy, no allowed certificate name, or no credentials -> no start.
func (c *Config) Validate() error {
	var errs []string
	if c.Realm == "" || !hostRe.MatchString(c.Realm) {
		errs = append(errs, "SIP_REALM/SIP_SERVER missing or not a host name")
	}
	if c.Username == "" || c.Password == "" {
		errs = append(errs, "SIP_USERNAME/SIP_PASSWORD missing")
	}
	if !aorUserRe.MatchString(c.AORUser) {
		errs = append(errs, "SIP AOR user has unexpected characters")
	}
	if c.Expires < 60*time.Second || c.Expires > 3600*time.Second {
		errs = append(errs, "SIP_EXPIRES must be 60..3600")
	}
	if len(c.Proxies) == 0 {
		errs = append(errs, "VOICE_SIP_PROXIES missing (TLS proxy host:port list)")
	}
	for _, p := range c.Proxies {
		if !hostPortRe.MatchString(p) {
			errs = append(errs, "VOICE_SIP_PROXIES entry is not host:port")
		}
	}
	if c.TLSServerName == "" || !hostRe.MatchString(c.TLSServerName) {
		errs = append(errs, "VOICE_SIP_TLS_SERVER_NAME missing (the certificate name the proxies present)")
	}
	if c.MediaPolicy != PolicySRTPRequired && c.MediaPolicy != PolicySRTPPreferred {
		errs = append(errs, "VOICE_MEDIA_ENCRYPTION must be srtp-required or srtp-preferred-synthetic-only")
	}
	if c.PublicIP != "" && net.ParseIP(c.PublicIP) == nil {
		errs = append(errs, "VOICE_PUBLIC_IP is not an IP")
	}
	if c.RTPMin < 1024 || c.RTPMax <= c.RTPMin || c.RTPMax > 65535 || (c.RTPMax-c.RTPMin) < 8 {
		errs = append(errs, "VOICE_RTP_PORT_MIN/MAX invalid")
	}
	if c.MaxCalls < 1 || c.MaxCalls > 50 {
		errs = append(errs, "VOICE_MAX_CALLS must be 1..50")
	}
	switch c.Mode {
	case ModeHarness:
		if len(c.Secret) < 32 {
			errs = append(errs, "VOICE_GW_SECRET missing or shorter than 32 characters")
		}
		if !strings.HasPrefix(c.HarnessURL, "ws://") && !strings.HasPrefix(c.HarnessURL, "wss://") {
			errs = append(errs, "VOICE_HARNESS_URL must be ws:// (internal network) or wss://")
		}
	case ModeGreetingEcho:
	default:
		errs = append(errs, "VOICE_GW_MODE must be harness or greeting-echo")
	}
	if c.FallbackTarget != "" {
		if _, err := ValidateReferTarget(c.FallbackTarget, c.Realm); err != nil {
			errs = append(errs, "VOICE_GW_FALLBACK_TARGET: "+err.Error())
		}
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

// ValidateReferTarget accepts only sip:<digits/*/#>@<realm>: an extension, ring group, queue, voicemail (**ext)
// or park code on our own PBX. Never an external host or a dial string with letters (toll-fraud guard; the
// harness checks the agent's allow-list first, this is the second gate).
func ValidateReferTarget(target, realm string) (string, error) {
	t := strings.TrimSpace(target)
	if !strings.HasPrefix(t, "sip:") {
		return "", fmt.Errorf("target must be a sip: URI")
	}
	rest := strings.TrimPrefix(t, "sip:")
	at := strings.LastIndex(rest, "@")
	if at <= 0 {
		return "", fmt.Errorf("target needs user@host")
	}
	user, host := rest[:at], rest[at+1:]
	if !referUserRe.MatchString(user) {
		return "", fmt.Errorf("target user must be digits, * or # only")
	}
	if !strings.EqualFold(host, realm) {
		return "", fmt.Errorf("target host must be the PBX realm")
	}
	return "sip:" + user + "@" + strings.ToLower(host), nil
}
