package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/emiago/diago"
	"github.com/emiago/diago/media"
	"github.com/emiago/sipgo"
	"github.com/emiago/sipgo/sip"
)

// testGateway: a Gateway answering on UDP loopback (the TLS registration path is not needed to exercise the
// call path: offer policy, answer, SRTP, media loops, echo-test mode).
func testGateway(t *testing.T, ctx context.Context, port int, policy string) *Gateway {
	t.Helper()
	ua, _ := sipgo.NewUA(sipgo.WithUserAgent("gwtest"))
	g := &Gateway{
		cfg:      &Config{MediaPolicy: policy, MaxCalls: 2, Mode: ModeGreetingEcho, Realm: "pbx.example.test", UserAgent: "t"},
		log:      slog.New(slog.NewTextHandler(io.Discard, nil)),
		st:       NewStatus(filepath.Join(os.TempDir(), fmt.Sprintf("gwtest-%d.json", port))), // written after the test returns; not t.TempDir
		allowed:  map[string]bool{"127.0.0.1": true},
		greeting: sine(InternalRate, 440, InternalRate, 8000), // 1 s
	}
	g.dg = diago.NewDiago(ua,
		diago.WithLogger(g.log),
		diago.WithTransport(diago.Transport{Transport: "udp", BindHost: "127.0.0.1", BindPort: port, MediaSRTP: 1}),
		diago.WithMediaConfig(diago.MediaConfig{Codecs: answerCodecs}),
		diago.WithServerRequestMiddleware(g.SourceGuard),
	)
	if err := g.dg.ServeBackground(ctx, g.HandleCall); err != nil {
		t.Fatal(err)
	}
	return g
}

func testPhone(t *testing.T, ctx context.Context, port int, srtp int) *diago.Diago {
	t.Helper()
	ua, _ := sipgo.NewUA(sipgo.WithUserAgent("phone"))
	d := diago.NewDiago(ua,
		diago.WithLogger(slog.New(slog.NewTextHandler(io.Discard, nil))),
		diago.WithTransport(diago.Transport{Transport: "udp", BindHost: "127.0.0.1", BindPort: port, MediaSRTP: srtp}),
		diago.WithMediaConfig(diago.MediaConfig{Codecs: []media.Codec{media.CodecAudioUlaw, media.CodecTelephoneEvent8000}}),
	)
	if err := d.ServeBackground(ctx, func(*diago.DialogServerSession) {}); err != nil {
		t.Fatal(err)
	}
	return d
}

// Regression (Oct 18 20:27 UTC): an SRTP call in greeting-echo mode crashed the gateway (nil echo gate). The call
// must be answered with SRTP, the greeting must arrive, and the gateway must survive.
func TestGreetingEchoSRTPCall(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	g := testGateway(t, ctx, 25091, PolicySRTPRequired)
	phone := testPhone(t, ctx, 25092, 1)

	d, med, err := phone.Invite(ctx, sip.Uri{User: "4515", Host: "127.0.0.1", Port: 25091}, diago.InviteOptions{})
	if err != nil {
		t.Fatalf("SRTP call refused: %v", err)
	}
	ans := string(d.InviteResponse.Body())
	if !strings.Contains(ans, "RTP/SAVP") || AnswerCryptoSuite(d.InviteResponse.Body()) == "" {
		t.Fatalf("answer is not SDES-SRTP")
	}
	r, err := med.AudioReader()
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, 1500)
	loud := 0
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && loud < 10 {
		n, err := r.Read(buf)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		// PCMU silence is 0xFF/0x7F; the greeting tone is not.
		for _, b := range buf[:n] {
			if b != 0xFF && b != 0x7F {
				loud++
				break
			}
		}
	}
	if loud < 10 {
		t.Fatalf("greeting audio not received over SRTP")
	}
	_ = d.Hangup(ctx)
	time.Sleep(300 * time.Millisecond)
	if n := PanicsRecovered.Load(); n != 0 {
		t.Fatalf("%d panics during the call", n)
	}
	// Still answering after the first call.
	d2, _, err := phone.Invite(ctx, sip.Uri{User: "4515", Host: "127.0.0.1", Port: 25091}, diago.InviteOptions{})
	if err != nil {
		t.Fatalf("second call refused: %v", err)
	}
	_ = d2.Hangup(ctx)
	_ = g
}

// Plain RTP offered while SRTP is required: 488, nothing answered.
func TestPlainRTPRefusedWhenSRTPRequired(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	testGateway(t, ctx, 25093, PolicySRTPRequired)
	phone := testPhone(t, ctx, 25094, 0)
	_, _, err := phone.Invite(ctx, sip.Uri{User: "4515", Host: "127.0.0.1", Port: 25093}, diago.InviteOptions{})
	if err == nil || responseCode(err) != 488 {
		t.Fatalf("want 488, got %v (code %d)", err, responseCode(err))
	}
}

// A panic inside one call's goroutine ends that call only.
func TestRecoverCallContainsPanic(t *testing.T) {
	before := PanicsRecovered.Load()
	hungUp := make(chan struct{})
	done := make(chan struct{})
	goSafe(slog.New(slog.NewTextHandler(io.Discard, nil)), "gwtest", "test", func() { close(hungUp) }, func() {
		defer close(done)
		var g *Gateway
		_ = g.cfg.Mode // nil dereference
	})
	select {
	case <-hungUp:
	case <-time.After(2 * time.Second):
		t.Fatal("onPanic (BYE) not called")
	}
	<-done
	if PanicsRecovered.Load() != before+1 {
		t.Fatal("panic not counted")
	}
	PanicsRecovered.Store(before)
}

func TestMain(m *testing.M) {
	media.RTPProfileSAVPDisable = false
	media.SDPCodecPreferLocalOrder = 1
	os.Exit(m.Run())
}
