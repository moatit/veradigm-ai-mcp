package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/emiago/diago"
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// A Session is one harness conversation, started by an inbound call to the extension. Like a desk phone with
// several call appearances it can hold more dialogs on the same registration: leg 0 is the caller, legs 1..
// are internal calls it dials (warm transfer to staff). Each leg has its own RTP stream, so every party's
// audio (and transcript) is labelled by its leg, never guessed. Legs can be held (re-INVITE sendonly),
// joined in a local conference (Mixer), blind-transferred (REFER) or attended-transferred (REFER + Replaces).

const (
	maxLegsPerSession = 3
	allConferenceLegs = 255
)

// ValidateDialTarget: the agent may only dial internal extensions, ring groups or queues on our own PBX:
// digits only (no +, no star codes, no external or international numbers), same realm.
func ValidateDialTarget(target, realm string) (string, error) {
	clean, err := ValidateReferTarget(target, realm)
	if err != nil {
		return "", err
	}
	user := strings.TrimPrefix(clean, "sip:")
	user = user[:strings.Index(user, "@")]
	kind, _, err := ClassifyTarget(user)
	if err != nil || (kind != TargetInternal && kind != TargetExternal) {
		return "", fmt.Errorf("dial target must be an internal extension/group or a 10-digit US/NANP number")
	}
	return clean, nil
}

type outMsg struct {
	bin  bool
	data []byte
}

type Leg struct {
	idx    int
	kind   string // inbound | outbound
	srv    *diago.DialogServerSession
	cli    *diago.DialogClientSession
	cm     *CallMedia
	seg    string
	held   bool
	ended  chan struct{}
	target string
}

func (l *Leg) ctx() context.Context {
	if l.srv != nil {
		return l.srv.Context()
	}
	return l.cli.Context()
}

func (l *Leg) hangup() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if l.srv != nil {
		_ = l.srv.Hangup(ctx)
	} else if l.cli != nil {
		_ = l.cli.Hangup(ctx)
	}
}

type Session struct {
	g            *Gateway
	ref          string
	callID       string
	rate         int
	conn         *websocket.Conn
	out          chan outMsg
	mix          *Mixer
	ctx          context.Context
	cancel       context.CancelFunc
	mu           sync.Mutex
	legs         map[int]*Leg
	next         int
	dropped      atomic.Int64
	agentHungUp  atomic.Bool
	transferring sync.Map // leg -> true
}

func (s *Session) send(m outMsg) {
	select {
	case s.out <- m:
	default:
		s.dropped.Add(1)
	}
}

func (s *Session) emit(ev Event) {
	if ev.At == 0 {
		ev.At = nowMs()
	}
	b, _ := json.Marshal(ev)
	s.send(outMsg{data: b})
}

func (s *Session) leg(i int) *Leg {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.legs[i]
}

// attach wires a leg's media into the session and starts it; when the leg ends the session hears about it.
func (s *Session) attach(l *Leg, med *diago.DialogMedia) {
	cm := NewCallMedia(s.ref, med, s.rate, s.g.log)
	cm.leg = l.idx
	cm.mix = s.mix
	l.cm = cm
	idx := byte(l.idx)
	cm.onEvent = func(ev Event) { ev.Leg = l.idx; s.emit(ev) }
	cm.onCaller = func(pcm []int16) {
		b := make([]byte, 1+2*len(pcm))
		b[0] = idx
		copy(b[1:], pcmToBytes(pcm))
		s.send(outMsg{bin: true, data: b})
	}
	cm.onDTMF = func(d rune) { s.emit(Event{Type: "dtmf", Leg: l.idx, Digit: string(d)}) }
	cm.fail = l.hangup
	s.mu.Lock()
	s.legs[l.idx] = l
	s.mu.Unlock()
	go func() {
		defer func() {
			close(l.ended)
			s.legEnded(l)
		}()
		defer recoverCall(s.g.log, s.ref, "leg", l.hangup)
		_ = cm.Run(l.ctx())
	}()
}

func (s *Session) legEnded(l *Leg) {
	s.mix.Remove(l.idx)
	pin, pout, first := l.cm.Stats()
	by := "remote"
	if s.agentHungUp.Load() {
		by = "agent"
	}
	s.emit(Event{Type: "leg_hangup", Leg: l.idx, By: by, PktsIn: pin, PktsOut: pout, FirstInMs: intp(first)})
	q := l.cm.Quality()
	s.emit(Event{Type: "leg_quality", Leg: l.idx, Quality: &q})
	s.g.log.Info("leg ended", "call", s.ref, "leg", l.idx, "kind", l.kind, "pkts_in", pin, "pkts_out", pout, "first_in_ms", first, "quality", q.String())
	s.mu.Lock()
	delete(s.legs, l.idx)
	left := len(s.legs)
	s.mu.Unlock()
	if l.kind == "outbound" {
		s.g.active.Add(-1)
		s.g.st.Update(func(st *StatusSnapshot) { st.ActiveCalls = int(s.g.active.Load()) })
	}
	if left == 0 {
		s.cancel()
	}
}

// bridge connects an inbound call to the Drawbridge harness: the harness decides (accept with its minted call
// ID, or reject so the PBX's no-answer route takes the call), then audio and control flow until every leg has
// hung up.
func (g *Gateway) bridge(in *diago.DialogServerSession, ref string, offer Offer, caller, callerName string) {
	ictx := in.Context()
	conn, err := DialHarness(ictx, g.cfg, "call")
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
	if err := writeJSON(ictx, conn, CallStart{
		Type: "call_start", CallRef: ref, From: caller, FromName: callerName, To: to,
		SRTP: offer.SRTP, Codecs: offer.Codecs, MediaRule: g.cfg.MediaPolicy, Registered: g.st.Snapshot().Registered,
	}); err != nil {
		_ = in.Respond(sip.StatusTemporarilyUnavailable, "Temporarily Unavailable", nil)
		return
	}
	actx, acancel := context.WithTimeout(ictx, 8*time.Second)
	typ, data, err := conn.Read(actx)
	acancel()
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
		ctl.PCMRate = 24000
	}
	med, srtp, err := g.answer(in)
	if err != nil {
		g.log.Error("answer failed", "call", ref, "err", err.Error())
		return
	}
	sctx, scancel := context.WithCancel(context.Background())
	s := &Session{g: g, ref: ref, callID: ctl.CallID, rate: ctl.PCMRate, conn: conn, out: make(chan outMsg, 512),
		mix: NewMixer(200), ctx: sctx, cancel: scancel, legs: map[int]*Leg{}, next: 1}
	writerDone := make(chan struct{})
	goSafe(g.log, ref, "writer", nil, func() { s.writer(writerDone) })

	leg0 := &Leg{idx: 0, kind: "inbound", srv: in, ended: make(chan struct{})}
	s.attach(leg0, med)
	g.log.Info("answered", "call", ref, "voice_call", s.callID, "codec", leg0.cm.CodecName(), "srtp", srtp, "pcm_rate", s.rate)
	s.emit(Event{Type: "answered", Leg: 0, Codec: leg0.cm.CodecName(), SRTP: boolp(srtp)})

	harnessLost := func() (lost bool) {
		defer recoverCall(g.log, ref, "session", func() { lost = true })
		return s.readLoop()
	}()
	if harnessLost {
		g.log.Error("harness connection lost mid-call", "call", ref)
		if l := s.leg(0); l != nil && g.cfg.FallbackTarget != "" {
			s.blindTransfer(l, g.cfg.FallbackTarget, "")
		}
		s.hangupAll()
	}
	select {
	case <-sctx.Done():
	case <-time.After(20 * time.Second):
		s.hangupAll()
		<-sctx.Done()
	}
	s.emit(Event{Type: "hangup", By: map[bool]string{true: "agent", false: "remote"}[s.agentHungUp.Load()]})
	close(s.out)
	select {
	case <-writerDone:
	case <-time.After(3 * time.Second):
	}
	_ = conn.Close(websocket.StatusNormalClosure, "call ended")
	g.log.Info("session ended", "call", ref, "voice_call", s.callID, "ws_dropped", s.dropped.Load())
	// in.Context() ends with leg 0; HandleCall's caller (diago) then cleans the dialog up.
	<-leg0.ended
}

func (s *Session) writer(done chan struct{}) {
	defer close(done)
	for m := range s.out {
		typ := websocket.MessageText
		if m.bin {
			typ = websocket.MessageBinary
		}
		wctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		err := s.conn.Write(wctx, typ, m.data)
		cancel()
		if err != nil {
			// keep draining so senders never block
			for range s.out {
			}
			return
		}
	}
}

func (s *Session) hangupAll() {
	s.mu.Lock()
	legs := make([]*Leg, 0, len(s.legs))
	for _, l := range s.legs {
		legs = append(legs, l)
	}
	s.mu.Unlock()
	for _, l := range legs {
		l.hangup()
	}
}

// readLoop handles harness commands until the session ends. Returns true when the harness went away.
func (s *Session) readLoop() bool {
	for {
		typ, data, err := s.conn.Read(s.ctx)
		if err != nil {
			return s.ctx.Err() == nil
		}
		if typ == websocket.MessageBinary {
			if len(data) < 3 {
				continue
			}
			pcm := bytesToPCM(data[1:])
			if data[0] == allConferenceLegs {
				for _, i := range s.mix.Members() {
					if l := s.leg(i); l != nil {
						l.cm.PushAgent(l.seg, pcm)
					}
				}
			} else if l := s.leg(int(data[0])); l != nil {
				l.cm.PushAgent(l.seg, pcm)
			}
			continue
		}
		var c Control
		if json.Unmarshal(data, &c) != nil {
			continue
		}
		s.handle(c)
	}
}

func (s *Session) targets(leg int) []*Leg {
	if leg == allConferenceLegs || leg < 0 {
		var out []*Leg
		s.mu.Lock()
		for _, l := range s.legs {
			if leg < 0 || s.mix.InConference(l.idx) {
				out = append(out, l)
			}
		}
		s.mu.Unlock()
		return out
	}
	if l := s.leg(leg); l != nil {
		return []*Leg{l}
	}
	return nil
}

func (s *Session) handle(c Control) {
	switch c.Type {
	case "segment":
		for _, l := range s.targets(c.Leg) {
			l.seg = c.Segment
		}
	case "segment_end":
		for _, l := range s.targets(c.Leg) {
			l.cm.play.End(c.Segment)
		}
	case "clear":
		for _, l := range s.targets(c.Leg) {
			ev := Event{Type: "cleared", Leg: l.idx, PlayedMs: intp(0)}
			if r := l.cm.play.Clear(); r != nil {
				ev.Segment, ev.PlayedMs = r.Segment, intp(r.PlayedMs)
			}
			s.emit(ev)
		}
	case "hangup":
		s.agentHungUp.Store(true)
		for _, l := range s.targets(c.Leg) {
			goSafe(s.g.log, s.ref, "hangup", l.hangup, func() {
				// Let a queued closing line finish (at most 15 s).
				deadline := time.Now().Add(15 * time.Second)
				for l.cm.play.QueuedMs() > 0 && time.Now().Before(deadline) && l.ctx().Err() == nil {
					time.Sleep(100 * time.Millisecond)
				}
				time.Sleep(300 * time.Millisecond)
				l.hangup()
			})
		}
	case "transfer":
		l := s.leg(c.Leg)
		if l == nil {
			s.emit(Event{Type: "transfer_result", Leg: c.Leg, RequestID: c.RequestID, Reason: "no_such_leg"})
			return
		}
		if _, busy := s.transferring.LoadOrStore(l.idx, true); busy {
			return
		}
		goSafe(s.g.log, s.ref, "transfer", nil, func() {
			defer s.transferring.Delete(l.idx)
			if c.ReplacesLeg != nil {
				s.attendedTransfer(l, *c.ReplacesLeg, c.RequestID)
			} else {
				s.blindTransfer(l, c.Target, c.RequestID)
			}
		})
	case "dial":
		goSafe(s.g.log, s.ref, "dial", nil, func() { s.dial(c) })
	case "hold", "resume":
		l := s.leg(c.Leg)
		if l == nil {
			s.emit(Event{Type: c.Type + "_result", Leg: c.Leg, RequestID: c.RequestID, Reason: "no_such_leg"})
			return
		}
		goSafe(s.g.log, s.ref, "holdResume", nil, func() { s.holdResume(l, c.Type == "hold", c.RequestID) })
	case "conference":
		legs := []int{}
		for _, i := range c.Legs {
			if s.leg(i) != nil {
				legs = append(legs, i)
			}
		}
		s.mix.Set(legs)
		s.g.log.Info("conference set", "call", s.ref, "legs", legs)
		s.emit(Event{Type: "conference_result", RequestID: c.RequestID, Reason: fmt.Sprint(legs)})
	case "ping":
		s.emit(Event{Type: "pong"})
	}
}

func (s *Session) holdResume(l *Leg, hold bool, reqID string) {
	ctx, cancel := context.WithTimeout(s.ctx, 8*time.Second)
	defer cancel()
	var err error
	switch {
	case l.srv != nil && hold:
		err = l.srv.Hold(ctx)
	case l.srv != nil:
		err = l.srv.Unhold(ctx)
	case hold:
		err = l.cli.Hold(ctx)
	default:
		err = l.cli.Unhold(ctx)
	}
	typ := "resume_result"
	if hold {
		typ = "hold_result"
	}
	ev := Event{Type: typ, Leg: l.idx, RequestID: reqID, Code: 200, Reason: "ok"}
	if err != nil {
		ev.Code, ev.Reason = responseCode(err), "reinvite_failed"
		// The PBX's reason phrase and Warning header (no caller data) say why it refused.
		var dp *sipgo.ErrDialogResponse
		if errors.As(err, &dp) && dp != nil && dp.Res != nil {
			warn := ""
			if h := dp.Res.GetHeader("Warning"); h != nil {
				warn = h.Value()
			}
			s.g.log.Warn("re-INVITE refused", "call", s.ref, "leg", l.idx, "code", dp.Res.StatusCode, "reason", dp.Res.Reason, "warning", warn)
		} else {
			s.g.log.Warn("re-INVITE failed", "call", s.ref, "leg", l.idx, "err", err.Error())
		}
	} else {
		l.held = hold
	}
	s.g.log.Info(typ, "call", s.ref, "leg", l.idx, "code", ev.Code)
	s.emit(ev)
}

func responseCode(err error) int {
	var de sipgo.ErrDialogResponse
	if errors.As(err, &de) && de.Res != nil {
		return de.Res.StatusCode
	}
	var dp *sipgo.ErrDialogResponse
	if errors.As(err, &dp) && dp != nil && dp.Res != nil {
		return dp.Res.StatusCode
	}
	return 0
}

// dial places an internal call (warm transfer to staff). Allow-listed by the harness first; here only
// internal numbers on our realm, a per-session leg cap and the gateway-wide call cap.
func (s *Session) dial(c Control) {
	fail := func(idx, code int, reason string) {
		s.emit(Event{Type: "leg_failed", Leg: idx, RequestID: c.RequestID, Code: code, Reason: reason})
	}
	target, err := ValidateDialTarget(c.Target, s.g.cfg.Realm)
	if err != nil {
		fail(-1, 0, "target_refused")
		return
	}
	s.mu.Lock()
	if len(s.legs) >= maxLegsPerSession {
		s.mu.Unlock()
		fail(-1, 0, "max_legs")
		return
	}
	idx := s.next
	s.next++
	s.mu.Unlock()
	if int(s.g.active.Add(1)) > s.g.cfg.MaxCalls {
		s.g.active.Add(-1)
		fail(idx, 486, "max_calls")
		return
	}
	counted := true
	defer func() {
		if counted {
			s.g.active.Add(-1)
		}
	}()
	timeout := time.Duration(c.TimeoutS) * time.Second
	if timeout < 5*time.Second || timeout > 60*time.Second {
		timeout = 25 * time.Second
	}
	s.emit(Event{Type: "leg_dialing", Leg: idx, RequestID: c.RequestID})
	var u sip.Uri
	if err := sip.ParseUri(target+";transport=tls", &u); err != nil {
		fail(idx, 0, "target_unparsable")
		return
	}
	proxy := s.g.st.Snapshot().Proxy
	if proxy == "" {
		fail(idx, 0, "not_registered")
		return
	}
	route := sip.NewHeader("Route", "<sip:"+proxy+";transport=tls;lr>")
	ictx, cancel := context.WithTimeout(s.ctx, timeout)
	defer cancel()
	d, med, err := s.g.dg.Invite(ictx, u, diago.InviteOptions{
		Transport: "tls",
		Username:  s.g.cfg.Username,
		Password:  s.g.cfg.Password,
		Headers:   []sip.Header{route, sip.NewHeader("User-Agent", s.g.cfg.UserAgent)},
		OnResponse: func(res *sip.Response) error {
			if res.StatusCode == 180 || res.StatusCode == 183 {
				s.emit(Event{Type: "leg_ringing", Leg: idx, RequestID: c.RequestID, Code: res.StatusCode})
			}
			return nil
		},
	})
	if err != nil {
		code := responseCode(err)
		reason := "no_answer"
		if code != 0 {
			reason = fmt.Sprintf("rejected_%d", code)
		} else if !errors.Is(err, context.DeadlineExceeded) && ictx.Err() == nil {
			reason = "invite_failed"
		}
		s.g.log.Info("dial failed", "call", s.ref, "leg", idx, "code", code, "reason", reason)
		fail(idx, code, reason)
		return
	}
	srtp := d.InviteResponse != nil && AnswerHasCrypto(d.InviteResponse.Body())
	if !srtp && s.g.cfg.MediaPolicy == PolicySRTPRequired {
		hctx, hc := context.WithTimeout(context.Background(), 5*time.Second)
		_ = d.Hangup(hctx)
		hc()
		fail(idx, 488, "srtp_not_negotiated")
		return
	}
	counted = false // the leg now owns the slot (released in legEnded)
	l := &Leg{idx: idx, kind: "outbound", cli: d, ended: make(chan struct{}), target: target}
	s.attach(l, med)
	s.g.st.Update(func(st *StatusSnapshot) { st.ActiveCalls = int(s.g.active.Load()) })
	s.g.log.Info("leg answered", "call", s.ref, "leg", idx, "codec", l.cm.CodecName(), "srtp", srtp)
	s.emit(Event{Type: "leg_answered", Leg: idx, RequestID: c.RequestID, Codec: l.cm.CodecName(), SRTP: boolp(srtp)})
}

func (s *Session) refer(l *Leg, uri sip.Uri, referTo string, onNotify func(int)) error {
	ctx, cancel := context.WithTimeout(s.ctx, 8*time.Second)
	defer cancel()
	hdrs := []sip.Header{sip.NewHeader("User-Agent", s.g.cfg.UserAgent)}
	if referTo != "" {
		hdrs = append(hdrs, sip.NewHeader("Refer-To", referTo))
	}
	if l.srv != nil {
		return l.srv.ReferOptions(ctx, uri, diago.ReferServerOptions{Headers: hdrs, OnNotify: onNotify})
	}
	return l.cli.ReferOptions(ctx, uri, diago.ReferClientOptions{Headers: hdrs, OnNotify: onNotify})
}

// blindTransfer: REFER the leg to an allow-listed target on our PBX (extension, group, queue, **ext voicemail,
// *3/*4 park). Second allow-list check here.
func (s *Session) blindTransfer(l *Leg, target, reqID string) {
	clean, err := ValidateReferTarget(target, s.g.cfg.Realm)
	if err != nil {
		s.emit(Event{Type: "transfer_result", Leg: l.idx, RequestID: reqID, Reason: "target_refused"})
		return
	}
	var u sip.Uri
	if err := sip.ParseUri(clean, &u); err != nil {
		s.emit(Event{Type: "transfer_result", Leg: l.idx, RequestID: reqID, Reason: "target_unparsable"})
		return
	}
	s.runRefer(l, u, "", reqID)
}

// attendedTransfer: REFER the caller's leg to the staff party with Replaces (RFC 3891), so the PBX joins them
// directly and drops both of our legs. Through a B2BUA this may be refused: the harness then keeps the local
// conference instead.
func (s *Session) attendedTransfer(l *Leg, replacesLeg int, reqID string) {
	other := s.leg(replacesLeg)
	if other == nil || other.cli == nil || other.cli.InviteResponse == nil {
		s.emit(Event{Type: "transfer_result", Leg: l.idx, RequestID: reqID, Reason: "no_consult_leg"})
		return
	}
	req, res := other.cli.InviteRequest, other.cli.InviteResponse
	callID := ""
	if h := req.CallID(); h != nil {
		callID = h.Value()
	}
	fromTag, _ := req.From().Params.Get("tag")
	toTag, _ := res.To().Params.Get("tag")
	if callID == "" || fromTag == "" || toTag == "" {
		s.emit(Event{Type: "transfer_result", Leg: l.idx, RequestID: reqID, Reason: "no_dialog_ids"})
		return
	}
	replaces := url.QueryEscape(fmt.Sprintf("%s;to-tag=%s;from-tag=%s", callID, toTag, fromTag))
	var u sip.Uri
	if err := sip.ParseUri(other.target, &u); err != nil {
		s.emit(Event{Type: "transfer_result", Leg: l.idx, RequestID: reqID, Reason: "target_unparsable"})
		return
	}
	s.runRefer(l, u, fmt.Sprintf("<%s?Replaces=%s>", other.target, replaces), reqID)
}

func (s *Session) runRefer(l *Leg, u sip.Uri, referTo, reqID string) {
	notified := make(chan int, 4)
	err := s.refer(l, u, referTo, func(code int) {
		s.emit(Event{Type: "transfer_progress", Leg: l.idx, RequestID: reqID, Code: code})
		select {
		case notified <- code:
		default:
		}
	})
	if err != nil {
		code := responseCode(err)
		s.g.log.Warn("REFER failed", "call", s.ref, "leg", l.idx, "code", code)
		s.emit(Event{Type: "transfer_result", Leg: l.idx, RequestID: reqID, Code: code, Reason: fmt.Sprintf("refer_failed_%d", code)})
		return
	}
	s.g.log.Info("REFER accepted", "call", s.ref, "leg", l.idx)
	s.emit(Event{Type: "transfer_result", Leg: l.idx, RequestID: reqID, Code: 202, Reason: "accepted"})
	deadline := time.After(30 * time.Second)
	for {
		select {
		case code := <-notified:
			if code >= 200 {
				if code < 300 {
					// Transferred: our leg is no longer needed (the PBX usually sends BYE itself).
					time.Sleep(1500 * time.Millisecond)
					if l.ctx().Err() == nil {
						l.hangup()
					}
				}
				return
			}
		case <-deadline:
			return
		case <-l.ended:
			return
		}
	}
}
