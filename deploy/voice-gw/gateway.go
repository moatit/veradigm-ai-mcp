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
		g.log.Error("TLS to proxy failed", "proxy", proxy, "code", code)
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
		if err := g.probeTLS(proxy); err != nil {
			g.sleep(ctx, backoff)
			backoff = minDur(backoff*2, 2*time.Minute)
			continue
		}
		t, err := g.dg.RegisterTransaction(ctx, g.recipient(), diago.RegisterOptions{
			Username:  g.cfg.Username,
			Password:  g.cfg.Password,
			ProxyHost: proxy,
			Expiry:    g.cfg.Expires,
		})
		if err == nil {
			err = t.Register(ctx)
		}
		if err != nil {
			code := statusCodeOf(err)
			reason := "register_failed"
			if code != 0 {
				reason = "register_rejected_" + strconv.Itoa(code)
			}
			g.st.Update(func(s *StatusSnapshot) { s.Registered = false; s.LastError = reason; s.Proxy = proxy })
			g.log.Error("REGISTER failed", "proxy", proxy, "code", code, "reason", reason)
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
	refreshT := time.NewTimer(refresh)
	defer refreshT.Stop()
	fails := 0
	for {
		select {
		case <-ctx.Done():
			return
		case <-keep.C:
			if err := g.ping(ctx, proxy); err != nil {
				fails++
				g.log.Warn("keepalive failed", "proxy", proxy, "fails", fails)
				if fails >= 2 {
					g.st.Update(func(s *StatusSnapshot) { s.Registered = false; s.LastError = "keepalive_lost" })
					return
				}
			} else {
				fails = 0
				g.st.Update(func(s *StatusSnapshot) { s.ActiveCalls = int(g.active.Load()) })
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

func (g *Gateway) ping(ctx context.Context, proxy string) error {
	u := sip.Uri{Scheme: "sip", Host: g.cfg.Realm, UriParams: sip.NewParams(), Headers: sip.NewParams()}
	u.UriParams.Add("transport", "tls")
	req := sip.NewRequest(sip.OPTIONS, u)
	req.SetDestination(proxy)
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

var answerCodecs = []media.Codec{media.CodecAudioUlaw, media.CodecAudioAlaw, media.CodecTelephoneEvent8000}

func (g *Gateway) HandleCall(in *diago.DialogServerSession) {
	ref := newRef()
	req := in.InviteRequest
	offer := ParseOffer(req.Body())
	caller, callerName := CallerID(req)
	g.log.Info("incoming call", "call", ref, "from_last4", last4(caller), "proto", offer.Proto, "srtp_offered", offer.SRTP, "codecs", offer.Codecs)

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
	cm := NewCallMedia(ref, med, 8000, g.log)
	g.log.Info("answered", "call", ref, "codec", cm.CodecName(), "srtp", srtp, "mode", "greeting-echo")
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
			cm.play.Push("echo", pcm)
		}
	}
	start := time.Now()
	_ = cm.Run(ctx)
	in1, out1, first := cm.Stats()
	g.log.Info("call ended", "call", ref, "secs", int(time.Since(start).Seconds()), "pkts_in", in1, "pkts_out", out1, "first_in_ms", first)
}

type outMsg struct {
	bin  bool
	data []byte
}

// bridge connects the call to the Drawbridge harness: the harness decides (accept with its minted call ID, or
// reject so the PBX's no-answer route takes the call), then audio and control flow until either side hangs up.
func (g *Gateway) bridge(in *diago.DialogServerSession, ref string, offer Offer, caller, callerName string) {
	ctx := in.Context()
	conn, err := DialHarness(ctx, g.cfg, "call")
	if err != nil {
		g.log.Error("harness unreachable; call refused (480)", "call", ref, "err", err.Error())
		_ = in.Respond(sip.StatusTemporarilyUnavailable, "Temporarily Unavailable", nil)
		return
	}
	defer conn.CloseNow()
	to := ""
	if t := in.InviteRequest.To(); t != nil {
		to = cleanNumber(t.Address.User)
	}
	if err := writeJSON(ctx, conn, CallStart{
		Type: "call_start", CallRef: ref, From: caller, FromName: callerName, To: to,
		SRTP: offer.SRTP, Codecs: offer.Codecs, MediaRule: g.cfg.MediaPolicy, Registered: g.st.Snapshot().Registered,
	}); err != nil {
		_ = in.Respond(sip.StatusTemporarilyUnavailable, "Temporarily Unavailable", nil)
		return
	}
	actx, cancel := context.WithTimeout(ctx, 6*time.Second)
	typ, data, err := conn.Read(actx)
	cancel()
	var ctl Control
	if err != nil || typ != websocket.MessageText || json.Unmarshal(data, &ctl) != nil {
		g.log.Error("no decision from harness; call refused (480)", "call", ref)
		_ = in.Respond(sip.StatusTemporarilyUnavailable, "Temporarily Unavailable", nil)
		return
	}
	if ctl.Type != "accept" {
		code := ctl.Code
		if code != 480 && code != 486 && code != 503 && code != 603 {
			code = 480
		}
		g.log.Info("harness rejected call", "call", ref, "code", code)
		_ = in.Respond(code, reasonPhrase(code), nil)
		return
	}
	if ctl.PCMRate != 8000 && ctl.PCMRate != 16000 && ctl.PCMRate != 24000 {
		ctl.PCMRate = 16000
	}
	callID := ctl.CallID

	med, srtp, err := g.answer(in)
	if err != nil {
		g.log.Error("answer failed", "call", ref, "err", err.Error())
		return
	}
	cm := NewCallMedia(ref, med, ctl.PCMRate, g.log)
	g.log.Info("answered", "call", ref, "voice_call", callID, "codec", cm.CodecName(), "srtp", srtp, "pcm_rate", ctl.PCMRate)

	out := make(chan outMsg, 256)
	done := make(chan struct{})
	var dropped atomic.Int64
	send := func(m outMsg) {
		select {
		case out <- m:
		default:
			dropped.Add(1)
		}
	}
	sendEv := func(ev Event) {
		b, _ := json.Marshal(ev)
		send(outMsg{data: b})
	}
	go func() { // single writer: frames stay in order
		defer close(done)
		for m := range out {
			typ := websocket.MessageText
			if m.bin {
				typ = websocket.MessageBinary
			}
			wctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			err := conn.Write(wctx, typ, m.data)
			cancel()
			if err != nil {
				return
			}
		}
	}()
	sendEv(Event{Type: "answered", At: nowMs(), Codec: cm.CodecName(), SRTP: boolp(srtp)})
	cm.onEvent = sendEv
	cm.onCaller = func(pcm []int16) { send(outMsg{bin: true, data: pcmToBytes(pcm)}) }
	cm.onDTMF = func(d rune) { sendEv(Event{Type: "dtmf", At: nowMs(), Digit: string(d)}) }

	mediaDone := make(chan struct{})
	go func() {
		_ = cm.Run(ctx)
		close(mediaDone)
	}()

	var weHungUp atomic.Bool
	transferring := atomic.Bool{}
	seg := ""
	harnessLost := false
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			harnessLost = ctx.Err() == nil
			break
		}
		if typ == websocket.MessageBinary {
			cm.PushAgent(seg, bytesToPCM(data))
			continue
		}
		var c Control
		if json.Unmarshal(data, &c) != nil {
			continue
		}
		switch c.Type {
		case "segment":
			seg = c.Segment
		case "segment_end":
			cm.play.End(c.Segment)
		case "clear":
			if ev := cm.play.Clear(); ev != nil {
				sendEv(Event{Type: "cleared", At: nowMs(), Segment: ev.Segment, PlayedMs: intp(ev.PlayedMs)})
			} else {
				sendEv(Event{Type: "cleared", At: nowMs(), PlayedMs: intp(0)})
			}
		case "transfer":
			if transferring.CompareAndSwap(false, true) {
				go func(target string) {
					defer transferring.Store(false)
					g.transfer(ctx, in, ref, target, sendEv)
				}(c.Target)
			}
		case "hangup":
			weHungUp.Store(true)
			// Let queued audio (a closing line) finish, at most 15 s.
			deadline := time.Now().Add(15 * time.Second)
			for cm.play.QueuedMs() > 0 && time.Now().Before(deadline) && ctx.Err() == nil {
				time.Sleep(100 * time.Millisecond)
			}
			time.Sleep(300 * time.Millisecond)
			hctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			_ = in.Hangup(hctx)
			cancel()
		case "ping":
			sendEv(Event{Type: "pong", At: nowMs()})
		}
	}
	if harnessLost {
		g.log.Error("harness connection lost mid-call", "call", ref)
		if g.cfg.FallbackTarget != "" {
			g.transfer(ctx, in, ref, g.cfg.FallbackTarget, func(Event) {})
		}
		hctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		_ = in.Hangup(hctx)
		cancel()
	}
	<-mediaDone
	by := "remote"
	if weHungUp.Load() {
		by = "agent"
	}
	pin, pout, first := cm.Stats()
	ev := Event{Type: "hangup", At: nowMs(), By: by, PktsIn: pin, PktsOut: pout, FirstInMs: intp(first)}
	b, _ := json.Marshal(ev)
	send(outMsg{data: b})
	close(out)
	select {
	case <-done:
	case <-time.After(3 * time.Second):
	}
	_ = conn.Close(websocket.StatusNormalClosure, "call ended")
	g.log.Info("call ended", "call", ref, "voice_call", callID, "by", by, "pkts_in", pin, "pkts_out", pout, "first_in_ms", first, "ws_dropped", dropped.Load())
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

// transfer: blind transfer by SIP REFER to a target on our own PBX (second allow-list check here).
func (g *Gateway) transfer(ctx context.Context, in *diago.DialogServerSession, ref, target string, emit func(Event)) {
	clean, err := ValidateReferTarget(target, g.cfg.Realm)
	if err != nil {
		g.log.Warn("transfer target refused", "call", ref, "why", err.Error())
		emit(Event{Type: "transfer_result", At: nowMs(), Code: 0, Reason: "target_refused"})
		return
	}
	var u sip.Uri
	if err := sip.ParseUri(clean, &u); err != nil {
		emit(Event{Type: "transfer_result", At: nowMs(), Code: 0, Reason: "target_unparsable"})
		return
	}
	notified := make(chan int, 4)
	rctx, cancel := context.WithTimeout(ctx, 8*time.Second)
	err = in.ReferOptions(rctx, u, diago.ReferServerOptions{OnNotify: func(code int) {
		emit(Event{Type: "transfer_progress", At: nowMs(), Code: code})
		select {
		case notified <- code:
		default:
		}
	}})
	cancel()
	if err != nil {
		code := 0
		var de sipgo.ErrDialogResponse
		if errors.As(err, &de) && de.Res != nil {
			code = de.Res.StatusCode
		}
		g.log.Warn("REFER failed", "call", ref, "code", code)
		emit(Event{Type: "transfer_result", At: nowMs(), Code: code, Reason: fmt.Sprintf("refer_failed_%d", code)})
		return
	}
	g.log.Info("REFER accepted", "call", ref)
	emit(Event{Type: "transfer_result", At: nowMs(), Code: 202, Reason: "accepted"})
	// Final NOTIFY (2xx = connected to the target). The PBX normally ends our leg; if not, we do.
	deadline := time.After(30 * time.Second)
	for {
		select {
		case code := <-notified:
			if code >= 200 {
				if code < 300 {
					time.Sleep(1500 * time.Millisecond)
					hctx, c := context.WithTimeout(context.Background(), 5*time.Second)
					_ = in.Hangup(hctx)
					c()
				}
				return
			}
		case <-deadline:
			return
		case <-ctx.Done():
			return
		}
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
