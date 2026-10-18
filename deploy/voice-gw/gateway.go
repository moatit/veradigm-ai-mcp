package main

import (
	"context"
	"crypto/rand"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/emiago/diago"
	"github.com/emiago/diago/media"
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

type Gateway struct {
	cfg     *Config
	log     *slog.Logger
	ua      *sipgo.UserAgent
	dg      *diago.Diago
	cli     *sipgo.Client
	tlsConf *tls.Config
	st      *Status

	allowedMu sync.RWMutex
	allowed   map[string]bool // proxy IPs: the only sources a request is accepted from

	active   atomic.Int32
	greeting []int16

	probed sync.Map // proxy -> true once its TLS handshake was checked (once per process: no reconnect storms)
}

func newRef() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return "gw" + hex.EncodeToString(b)
}

// ── Registration ─────────────────────────────────────────────────────────────────────────────────────────

func (g *Gateway) resolveAllowed(ctx context.Context) {
	set := map[string]bool{}
	for _, p := range g.cfg.Proxies {
		host, _, _ := net.SplitHostPort(p)
		ips, err := net.DefaultResolver.LookupIP(ctx, "ip4", host)
		if err != nil {
			continue
		}
		for _, ip := range ips {
			set[ip.String()] = true
		}
	}
	if len(set) > 0 {
		g.allowedMu.Lock()
		g.allowed = set
		g.allowedMu.Unlock()
	}
}

func (g *Gateway) isAllowed(ip string) bool {
	g.allowedMu.RLock()
	defer g.allowedMu.RUnlock()
	return g.allowed[ip]
}

// probeTLS opens one TLS connection with the same settings as signalling to record the negotiated protocol
// and cipher, and to fail early (with a clear reason) on a certificate problem. Verification is never off.
func (g *Gateway) probeTLS(proxy string) error {
	d := &net.Dialer{Timeout: 6 * time.Second}
	c, err := tls.DialWithDialer(d, "tcp", proxy, g.tlsConf)
	if err != nil {
		var cv *tls.CertificateVerificationError
		code := "tls_connect_failed"
		if errors.As(err, &cv) {
			code = "tls_certificate_rejected"
		}
		g.st.Update(func(s *StatusSnapshot) { s.LastError = code })
		g.log.Error("TLS to proxy failed", "proxy", proxy, "code", code, "err", err.Error())
		return err
	}
	st := c.ConnectionState()
	_ = c.Close()
	g.st.Update(func(s *StatusSnapshot) {
		s.TLSVersion = tls.VersionName(st.Version)
		s.TLSCipher = tls.CipherSuiteName(st.CipherSuite)
		s.TLSVerifiedName = g.cfg.TLSServerName
	})
	return nil
}

func (g *Gateway) recipient() sip.Uri {
	u := sip.Uri{Scheme: "sip", User: g.cfg.AORUser, Host: g.cfg.Realm, UriParams: sip.NewParams(), Headers: sip.NewParams()}
	u.UriParams.Add("transport", "tls")
	return u
}

func statusCodeOf(err error) int {
	var rr *diago.RegisterResponseError
	if errors.As(err, &rr) && rr.RegisterRes != nil {
		return rr.RegisterRes.StatusCode
	}
	return 0
}

// RegisterLoop keeps the extension registered: re-REGISTER at 45% of the expiry, an OPTIONS keepalive every
// 25 s on the same TLS connection (keeps the NAT binding and the PBX's connection alias alive), immediate
// re-registration when the keepalive fails twice, proxy rotation with back-off on failure, and a long pause
// after the PBX rejects the credentials (no hammering that could lock the extension).
func (g *Gateway) RegisterLoop(ctx context.Context) {
	backoff := 5 * time.Second
	for i := 0; ctx.Err() == nil; i++ {
		proxy := g.cfg.Proxies[i%len(g.cfg.Proxies)]
		g.resolveAllowed(ctx)
		if _, done := g.probed.Load(proxy); !done {
			if err := g.probeTLS(proxy); err != nil {
				g.sleep(ctx, backoff)
				backoff = minDur(backoff*2, 2*time.Minute)
				continue
			}
			g.probed.Store(proxy, true)
		}
		t, err := g.dg.RegisterTransaction(ctx, g.recipient(), diago.RegisterOptions{
			Username:  g.cfg.Username,
			Password:  g.cfg.Password,
			ProxyHost: proxy,
			Expiry:    g.cfg.Expires,
		})
		if err == nil {
			t.Origin.AppendHeader(sip.NewHeader("User-Agent", g.cfg.UserAgent))
			err = t.Register(ctx)
		}
		if err != nil {
			code := statusCodeOf(err)
			reason := "register_failed"
			if code != 0 {
				reason = "register_rejected_" + strconv.Itoa(code)
			}
			g.st.Update(func(s *StatusSnapshot) { s.Registered = false; s.LastError = reason; s.Proxy = proxy })
			g.log.Error("REGISTER failed", "proxy", proxy, "code", code, "reason", reason, "err", err.Error())
			if code == 401 || code == 403 || code == 407 {
				// Credentials refused: wait 10 minutes (the owner rotates the password; avoid a lockout).
				g.sleep(ctx, 10*time.Minute)
			} else {
				g.sleep(ctx, backoff)
				backoff = minDur(backoff*2, 2*time.Minute)
			}
			continue
		}
		backoff = 5 * time.Second
		seen := ""
		if c := t.Origin.Contact(); c != nil {
			seen = net.JoinHostPort(c.Address.Host, strconv.Itoa(c.Address.Port))
		}
		snap := g.st.Update(func(s *StatusSnapshot) {
			s.Registered = true
			s.Proxy = proxy
			s.Transport = "tls"
			s.SeenAs = seen
			s.ExpiresSec = int(g.cfg.Expires.Seconds())
			s.LastError = ""
			s.RegisteredAt = time.Now().UTC().Format(time.RFC3339)
		})
		g.log.Info("REGISTERED", "proxy", proxy, "transport", "tls", "tls_version", snap.TLSVersion, "tls_cipher", snap.TLSCipher,
			"verified_name", snap.TLSVerifiedName, "expires_s", snap.ExpiresSec, "public_ip", snap.PublicIP)

		g.keepRegistered(ctx, t, proxy)
		if ctx.Err() != nil {
			uctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			_ = t.Unregister(uctx)
			cancel()
			g.st.Update(func(s *StatusSnapshot) { s.Registered = false; s.LastError = "shutdown" })
			return
		}
		g.sleep(ctx, time.Second)
	}
}

func (g *Gateway) keepRegistered(ctx context.Context, t *diago.RegisterTransaction, proxy string) {
	refresh := g.cfg.Expires * 45 / 100
	if refresh < 25*time.Second {
		refresh = 25 * time.Second
	}
	keep := time.NewTicker(25 * time.Second)
	defer keep.Stop()
	probe := time.NewTicker(5 * time.Minute)
	defer probe.Stop()
	refreshT := time.NewTimer(refresh)
	defer refreshT.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-keep.C:
			// RFC 5626 keepalive: a double CRLF on the registration's own TLS connection, like a desk phone. It keeps
			// our NAT binding and the proxy's connection alias alive; a write error means the connection is gone.
			if err := g.crlfKeepalive(proxy); err != nil {
				g.log.Warn("connection to proxy lost; registering again", "proxy", proxy, "err", err.Error())
				g.st.Update(func(s *StatusSnapshot) { s.Registered = false; s.LastError = "connection_lost" })
				return
			}
			g.st.Update(func(s *StatusSnapshot) { s.ActiveCalls = int(g.active.Load()); s.Panics = PanicsRecovered.Load() })
		case <-probe.C:
			if err := g.ping(ctx, proxy); err != nil {
				g.log.Warn("OPTIONS liveness check got no answer", "proxy", proxy)
			}
		case <-refreshT.C:
			if err := t.Qualify(ctx); err != nil {
				code := statusCodeOf(err)
				g.log.Warn("re-REGISTER failed", "proxy", proxy, "code", code)
				g.st.Update(func(s *StatusSnapshot) { s.Registered = false; s.LastError = "reregister_failed" })
				return
			}
			g.st.Update(func(s *StatusSnapshot) { s.Registered = true; s.LastError = "" })
			refreshT.Reset(refresh)
		}
	}
}

var crlf2 = []byte{'\r', '\n', '\r', '\n'}

// crlfKeepalive writes a double CRLF on the pooled TLS connection to the proxy (no new connection is opened).
func (g *Gateway) crlfKeepalive(proxy string) error {
	host, port, err := net.SplitHostPort(proxy)
	if err != nil {
		return err
	}
	ips, err := net.LookupIP(host)
	if err != nil {
		return err
	}
	for _, ip := range ips {
		c, err := g.ua.TransportLayer().GetConnection("tls", net.JoinHostPort(ip.String(), port))
		if err != nil || c == nil {
			continue
		}
		w, ok := c.(interface{ Write([]byte) (int, error) })
		if !ok {
			return nil
		}
		_, err = w.Write(crlf2)
		return err
	}
	return fmt.Errorf("no open connection to the proxy")
}

func (g *Gateway) ping(ctx context.Context, proxy string) error {
	u := sip.Uri{Scheme: "sip", Host: g.cfg.Realm, UriParams: sip.NewParams(), Headers: sip.NewParams()}
	u.UriParams.Add("transport", "tls")
	req := sip.NewRequest(sip.OPTIONS, u)
	req.SetDestination(proxy)
	req.AppendHeader(sip.NewHeader("User-Agent", g.cfg.UserAgent))
	pctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	defer cancel()
	_, err := g.cli.Do(pctx, req) // any final response means the connection is alive
	return err
}

func (g *Gateway) sleep(ctx context.Context, d time.Duration) {
	select {
	case <-ctx.Done():
	case <-time.After(d):
	}
}

func minDur(a, b time.Duration) time.Duration {
	if a < b {
		return a
	}
	return b
}

// SourceGuard refuses any request that does not come from one of the PBX proxies (a spoofed INVITE to the
// container would otherwise reach the agent). Responses to our own requests are not affected.
func (g *Gateway) SourceGuard(next sipgo.RequestHandler) sipgo.RequestHandler {
	return func(req *sip.Request, tx sip.ServerTransaction) {
		host, _, err := net.SplitHostPort(req.Source())
		if err != nil || !g.isAllowed(host) {
			g.log.Warn("SIP request from an unexpected source refused", "method", req.Method.String(), "src", host)
			_ = tx.Respond(sip.NewResponseFromRequest(req, sip.StatusForbidden, "Forbidden", nil))
			return
		}
		// Unsolicited NOTIFY outside a dialog (voicemail waiting indicator, message-summary): acknowledge and
		// ignore, as a desk phone does, so the PBX does not retry. In-dialog NOTIFYs (REFER progress) carry a To tag.
		if req.Method == sip.NOTIFY {
			if to := req.To(); to != nil {
				if tag, _ := to.Params.Get("tag"); tag == "" {
					_ = tx.Respond(sip.NewResponseFromRequest(req, sip.StatusOK, "OK", nil))
					return
				}
			}
		}
		next(req, tx)
	}
}

// ── Calls ────────────────────────────────────────────────────────────────────────────────────────────────

func (g *Gateway) HandleCall(in *diago.DialogServerSession) {
	ref := newRef()
	// A panic anywhere in this call ends this call only (BYE), never the gateway or other calls.
	defer recoverCall(g.log, ref, "HandleCall", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = in.Hangup(ctx)
	})
	req := in.InviteRequest
	offer := ParseOffer(req.Body())
	caller, callerName := CallerID(req)
	g.log.Info("incoming call", "call", ref, "from_last4", last4(caller), "proto", offer.Proto, "srtp_offered", offer.SRTP, "crypto_offered", offer.Crypto, "codecs", offer.Codecs)

	if int(g.active.Add(1)) > g.cfg.MaxCalls {
		g.active.Add(-1)
		_ = in.Respond(sip.StatusBusyHere, "Busy Here", nil)
		g.log.Warn("call refused: at VOICE_MAX_CALLS", "call", ref)
		return
	}
	defer func() {
		g.active.Add(-1)
		g.st.Update(func(s *StatusSnapshot) { s.ActiveCalls = int(g.active.Load()) })
	}()
	g.st.Update(func(s *StatusSnapshot) { s.ActiveCalls = int(g.active.Load()) })

	if !offer.SRTP && g.cfg.MediaPolicy == PolicySRTPRequired {
		// Fail closed: no unencrypted media for patient calls.
		g.log.Warn("call refused: PBX did not offer SRTP (VOICE_MEDIA_ENCRYPTION=srtp-required)", "call", ref, "proto", offer.Proto)
		_ = in.Respond(488, "Not Acceptable Here", nil)
		g.notifyControl(map[string]any{"type": "security", "event": "srtp_refused", "call_ref": ref, "proto": offer.Proto})
		return
	}
	_ = in.Trying()
	switch g.cfg.Mode {
	case ModeGreetingEcho:
		g.greetingEcho(in, ref)
	default:
		g.bridge(in, ref, offer, caller, callerName)
	}
}

func (g *Gateway) answer(in *diago.DialogServerSession) (*diago.DialogMedia, bool, error) {
	med, err := in.Answer(diago.AnswerOptions{Codecs: answerCodecs, RTPNAT: media.RTPNATSymetric})
	if err != nil {
		return nil, false, err
	}
	srtp := in.InviteResponse != nil && AnswerHasCrypto(in.InviteResponse.Body())
	return med, srtp, nil
}

// greetingEcho (stage 2 test): play the greeting clip, then echo the caller back (~at once). No harness.
func (g *Gateway) greetingEcho(in *diago.DialogServerSession, ref string) {
	ctx := in.Context()
	med, srtp, err := g.answer(in)
	if err != nil {
		g.log.Error("answer failed", "call", ref, "err", err.Error())
		return
	}
	cm := NewCallMedia(ref, med, InternalRate, g.log)
	cm.gate = nil // the echo test plays the caller back as received (nil-safe)
	cm.fail = func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = in.Hangup(ctx)
	}
	suite := ""
	if in.InviteResponse != nil {
		suite = AnswerCryptoSuite(in.InviteResponse.Body())
	}
	g.log.Info("answered", "call", ref, "codec", cm.CodecName(), "srtp", srtp, "srtp_suite", suite, "mode", "greeting-echo")
	cm.onEvent = func(ev Event) {
		switch ev.Type {
		case "media_in":
			g.log.Info("first inbound RTP", "call", ref, "ms_after_answer", *ev.FirstInMs)
		case "media_warning":
			g.log.Warn("media warning", "call", ref, "reason", ev.Reason)
		case "segment_done":
			if ev.Segment == "greeting" {
				g.log.Info("greeting played", "call", ref, "played_ms", *ev.PlayedMs)
			}
		}
	}
	greetingDone := atomic.Bool{}
	if len(g.greeting) > 0 {
		cm.play.Push("greeting", g.greeting)
		cm.play.End("greeting")
	}
	cm.onCaller = func(pcm []int16) {
		if greetingDone.Load() || cm.play.QueuedMs() == 0 {
			greetingDone.Store(true)
			cm.NoteQueue(cm.play.QueuedMs())
			cm.play.Push("echo", pcm)
		}
	}
	start := time.Now()
	_ = cm.Run(ctx)
	in1, out1, first := cm.Stats()
	g.log.Info("call ended", "call", ref, "secs", int(time.Since(start).Seconds()), "pkts_in", in1, "pkts_out", out1, "first_in_ms", first, "quality", cm.Quality().String())
}

func reasonPhrase(code int) string {
	switch code {
	case 486:
		return "Busy Here"
	case 503:
		return "Service Unavailable"
	case 603:
		return "Decline"
	default:
		return "Temporarily Unavailable"
	}
}

// ── Control link (registration status -> harness) ────────────────────────────────────────────────────────

var ctlCh = make(chan []byte, 64)

func (g *Gateway) notifyControl(v any) {
	if g.cfg.Mode != ModeHarness {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case ctlCh <- b:
	default:
	}
}

func (g *Gateway) ControlLoop(ctx context.Context) {
	if g.cfg.Mode != ModeHarness {
		return
	}
	g.st.Subscribe(func(s StatusSnapshot) { g.notifyControl(s) })
	for ctx.Err() == nil {
		c, err := DialHarness(ctx, g.cfg, "control")
		if err != nil {
			g.sleep(ctx, 5*time.Second)
			continue
		}
		g.log.Info("control link to harness up")
		lctx, cancel := context.WithCancel(ctx)
		go func() { // reader: detect close
			for {
				if _, _, err := c.Read(lctx); err != nil {
					cancel()
					return
				}
			}
		}()
		_ = writeJSON(lctx, c, g.st.Snapshot())
		tick := time.NewTicker(30 * time.Second)
	loop:
		for {
			select {
			case <-lctx.Done():
				break loop
			case b := <-ctlCh:
				wctx, wc := context.WithTimeout(lctx, 2*time.Second)
				err := c.Write(wctx, websocket.MessageText, b)
				wc()
				if err != nil {
					break loop
				}
			case <-tick.C:
				if writeJSON(lctx, c, g.st.Snapshot()) != nil {
					break loop
				}
			}
		}
		tick.Stop()
		cancel()
		c.CloseNow()
		g.log.Warn("control link to harness down; retrying")
		g.sleep(ctx, 2*time.Second)
	}
}
