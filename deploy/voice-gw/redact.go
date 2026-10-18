package main

import (
	"fmt"
	"log/slog"
	"regexp"
	"strings"
)

var (
	// Long digit runs in SIP lines (caller numbers in From/PAI) keep only their last 4 digits.
	digitsRe = regexp.MustCompile(`\+?\d{5,}`)
	// Digest Authorization values never reach the log.
	digestRe = regexp.MustCompile(`(?i)(response|nonce|cnonce)="[^"]*"`)
)

// Redact removes secrets and identifiers from a log string: the SIP auth user / AOR user and password, the
// harness secret, digest fields, and phone numbers (last 4 digits kept).
func Redact(cfg *Config, s string) string {
	if cfg != nil {
		for _, v := range []string{cfg.Password, cfg.Secret, cfg.Username, cfg.AORUser} {
			if len(v) >= 3 {
				s = strings.ReplaceAll(s, v, "[redacted]")
			}
		}
	}
	s = digestRe.ReplaceAllString(s, `$1="[redacted]"`)
	return digitsRe.ReplaceAllStringFunc(s, func(m string) string { return "…" + m[len(m)-4:] })
}

func redactAttr(cfg *Config) func(groups []string, a slog.Attr) slog.Attr {
	return func(groups []string, a slog.Attr) slog.Attr {
		switch a.Value.Kind() {
		case slog.KindString:
			if a.Key == slog.TimeKey || a.Key == slog.LevelKey {
				return a
			}
			return slog.String(a.Key, Redact(cfg, a.Value.String()))
		case slog.KindAny:
			v := a.Value.Any()
			if err, ok := v.(error); ok {
				return slog.String(a.Key, Redact(cfg, err.Error()))
			}
			if st, ok := v.(fmt.Stringer); ok {
				return slog.String(a.Key, Redact(cfg, st.String()))
			}
			return slog.String(a.Key, Redact(cfg, fmt.Sprint(v)))
		}
		return a
	}
}
