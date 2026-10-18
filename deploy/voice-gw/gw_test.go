package main

import (
	"encoding/binary"

	"math"
	"strings"
	"testing"
	"time"

	"github.com/emiago/diago/media"
)

func sine(rate, hz, n int, amp float64) []int16 {
	out := make([]int16, n)
	for i := range out {
		out[i] = int16(amp * math.Sin(2*math.Pi*float64(hz)*float64(i)/float64(rate)))
	}
	return out
}

func rms(s []int16) float64 {
	var sum float64
	for _, v := range s {
		sum += float64(v) * float64(v)
	}
	return math.Sqrt(sum / float64(len(s)))
}

func TestResamplerRatesAndGain(t *testing.T) {
	cases := [][2]int{{8000, 24000}, {24000, 8000}, {8000, 16000}, {16000, 8000}, {16000, 24000}, {24000, 16000}}
	for _, c := range cases {
		r := NewResampler(c[0], c[1])
		in := sine(c[0], 440, c[0], 10000) // 1 s
		var out []int16
		for i := 0; i < len(in); i += c[0] / 50 { // 20 ms blocks
			out = append(out, r.Process(in[i:i+c[0]/50])...)
		}
		want := c[1]
		if d := len(out) - want; d < -64 || d > 64 {
			t.Fatalf("%v: got %d samples, want ~%d", c, len(out), want)
		}
		g := rms(out[len(out)/4:]) / rms(in[len(in)/4:])
		if g < 0.9 || g > 1.1 {
			t.Fatalf("%v: passband gain %.3f", c, g)
		}
	}
}

func TestResamplerRejectsAlias(t *testing.T) {
	// 6 kHz at 24 kHz is above the 4 kHz Nyquist of 8 kHz: must be strongly attenuated, not folded to 2 kHz.
	r := NewResampler(24000, 8000)
	out := r.Process(sine(24000, 6000, 24000, 10000))
	if g := rms(out[2000:]) / rms(sine(24000, 6000, 24000, 10000)); g > 0.05 {
		t.Fatalf("alias leakage %.3f", g)
	}
}

func TestReferTargetAllowList(t *testing.T) {
	realm := "mit.voip.moatit.net"
	ok := []string{"sip:4500@mit.voip.moatit.net", "sip:**4500@mit.voip.moatit.net", "sip:*3@MIT.voip.moatit.net", "sip:*4@mit.voip.moatit.net"}
	for _, s := range ok {
		if _, err := ValidateReferTarget(s, realm); err != nil {
			t.Fatalf("%s refused: %v", s, err)
		}
	}
	bad := []string{"sip:+12085551234@evil.example", "sip:4500@other.example", "sips:4500@mit.voip.moatit.net", "sip:abc@mit.voip.moatit.net", "tel:4500", "sip:@mit.voip.moatit.net", "sip:4500@mit.voip.moatit.net;transport=udp"}
	for _, s := range bad {
		if _, err := ValidateReferTarget(s, realm); err == nil {
			t.Fatalf("%s accepted", s)
		}
	}
}

func TestNilEchoGateIsSafe(t *testing.T) {
	var g *EchoGate
	g.Played(-10) // echo-test mode runs without a gate: must not panic
	if out := g.Filter(make([]int16, 160)); len(out) != 160 {
		t.Fatalf("nil gate filter")
	}
	if a, b := g.Counts(); a != 0 || b != 0 {
		t.Fatalf("nil gate counts")
	}
}

func TestParseOffer(t *testing.T) {
	plain := "v=0\r\nm=audio 4000 RTP/AVP 0 8 101\r\na=rtpmap:0 PCMU/8000\r\na=rtpmap:8 PCMA/8000\r\na=rtpmap:101 telephone-event/8000\r\n"
	o := ParseOffer([]byte(plain))
	if o.SRTP || o.Proto != "RTP/AVP" || strings.Join(o.Codecs, ",") != "PCMU,PCMA,telephone-event" {
		t.Fatalf("plain offer parsed wrong: %+v", o)
	}
	sec := "v=0\r\nm=audio 4000 RTP/SAVP 0\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abc\r\na=rtpmap:0 PCMU/8000\r\n"
	if o := ParseOffer([]byte(sec)); !o.SRTP {
		t.Fatalf("SDES offer not detected: %+v", o)
	}
	// crypto under a non-audio m= line does not count
	video := "v=0\r\nm=audio 4000 RTP/AVP 0\r\nm=video 5000 RTP/SAVP 96\r\na=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:abc\r\n"
	if o := ParseOffer([]byte(video)); o.SRTP {
		t.Fatalf("video crypto counted for audio")
	}
}

func TestPlayoutSegments(t *testing.T) {
	p := NewPlayout(8000*10, 8)
	p.Push("a", make([]int16, 240)) // 30 ms
	p.End("a")
	p.Push("b", make([]int16, 400)) // 50 ms
	_, ev, active := p.Next(160)
	if !active || len(ev) != 0 {
		t.Fatalf("first frame")
	}
	_, ev, _ = p.Next(160) // finishes a (80 samples) and starts b
	if len(ev) != 1 || ev[0].Segment != "a" || ev[0].PlayedMs != 30 {
		t.Fatalf("segment_done for a: %+v", ev)
	}
	c := p.Clear()
	if c == nil || c.Segment != "b" || c.PlayedMs != 10 {
		t.Fatalf("cleared b: %+v", c)
	}
	_, _, active = p.Next(160)
	if active {
		t.Fatalf("queue should be empty after clear")
	}
	if p.Push("x", make([]int16, 8000*11)) {
		t.Fatalf("over-capacity push accepted")
	}
}

func TestAuthTokenShape(t *testing.T) {
	secret := strings.Repeat("s", 40)
	tok := AuthToken(secret, "call", time.Unix(1_800_000_000, 0))
	parts := map[string]string{}
	for _, kv := range strings.Split(strings.TrimPrefix(tok, "v1,"), ",") {
		p := strings.SplitN(kv, "=", 2)
		parts[p[0]] = p[1]
	}
	if parts["kind"] != "call" || parts["ts"] != "1800000000" || len(parts["nonce"]) != 32 {
		t.Fatalf("token fields: %v", parts)
	}
	if parts["mac"] != authMAC(secret, "call", 1_800_000_000, parts["nonce"]) {
		t.Fatalf("mac mismatch")
	}
	if strings.Contains(tok, secret) {
		t.Fatalf("secret leaked into token")
	}
}

func TestWAVParse(t *testing.T) {
	pcm := sine(16000, 300, 1600, 8000)
	data := pcmToBytes(pcm)
	b := make([]byte, 44+len(data))
	copy(b, "RIFF")
	binary.LittleEndian.PutUint32(b[4:], uint32(36+len(data)))
	copy(b[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(b[16:], 16)
	binary.LittleEndian.PutUint16(b[20:], 1)
	binary.LittleEndian.PutUint16(b[22:], 1)
	binary.LittleEndian.PutUint32(b[24:], 16000)
	binary.LittleEndian.PutUint32(b[28:], 32000)
	binary.LittleEndian.PutUint16(b[32:], 2)
	binary.LittleEndian.PutUint16(b[34:], 16)
	copy(b[36:], "data")
	binary.LittleEndian.PutUint32(b[40:], uint32(len(data)))
	copy(b[44:], data)
	got, rate, err := ParseWAV(b)
	if err != nil || rate != 16000 || len(got) != 1600 {
		t.Fatalf("wav: %v %d %d", err, rate, len(got))
	}
}

func TestVADEndOfSpeech(t *testing.T) {
	v := NewVAD()
	now := time.Unix(0, 0)
	quiet := make([]int16, 160)
	for i := 0; i < 50; i++ {
		v.Push(quiet, now)
		now = now.Add(20 * time.Millisecond)
	}
	loud := sine(8000, 300, 160, 6000)
	for i := 0; i < 25; i++ {
		v.Push(loud, now)
		now = now.Add(20 * time.Millisecond)
	}
	lastVoiced := now.Add(-20 * time.Millisecond)
	ended := false
	for i := 0; i < 25 && !ended; i++ {
		ended = v.Push(quiet, now)
		now = now.Add(20 * time.Millisecond)
	}
	if !ended || !v.SpeechEndedAt.Equal(lastVoiced) {
		t.Fatalf("end of speech not detected at the last voiced frame")
	}
}

func TestConfigFailsClosed(t *testing.T) {
	c := &Config{Realm: "mit.voip.moatit.net", Username: "u", Password: "p", AORUser: "u", Expires: 300 * time.Second,
		MediaPolicy: PolicySRTPRequired, RTPMin: 20000, RTPMax: 20199, MaxCalls: 4, Mode: ModeHarness,
		HarnessURL: "ws://unity:3010/voice-gw", Secret: strings.Repeat("k", 40)}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "VOICE_SIP_PROXIES") {
		t.Fatalf("missing proxy must fail")
	}
	c.Proxies = []string{"kam001.z1.grr.voipproxy.net:5061"}
	if err := c.Validate(); err == nil || !strings.Contains(err.Error(), "TLS_SERVER_NAME") {
		t.Fatalf("missing TLS name must fail")
	}
	c.TLSServerName = "kam001.phl.wlcomm.net"
	if err := c.Validate(); err != nil {
		t.Fatalf("valid config refused: %v", err)
	}
	c.Secret = "short"
	if err := c.Validate(); err == nil {
		t.Fatalf("short secret accepted")
	}
	c.Secret = strings.Repeat("k", 40)
	c.MediaPolicy = "rtp"
	if err := c.Validate(); err == nil {
		t.Fatalf("unknown media policy accepted")
	}
	c.MediaPolicy = PolicySRTPRequired
	c.Password = ""
	if err := c.Validate(); err == nil || strings.Contains(err.Error(), "p\"") {
		t.Fatalf("missing password accepted")
	}
}

func TestRedact(t *testing.T) {
	c := &Config{Username: "authuser77", AORUser: "authuser77", Password: "pw-secret-1", Secret: strings.Repeat("z", 40)}
	in := `From: <sip:authuser77@mit.voip.moatit.net>;tag=x Authorization: Digest response="abc123", nonce="n0" pw-secret-1 caller +12085551234`
	out := Redact(c, in)
	for _, leak := range []string{"authuser77", "pw-secret-1", "abc123", "2085551234"} {
		if strings.Contains(out, leak) {
			t.Fatalf("leaked %q in %q", leak, out)
		}
	}
	if !strings.Contains(out, "1234") {
		t.Fatalf("last 4 digits should stay: %q", out)
	}
}

func TestG722RoundTrip(t *testing.T) {
	enc, _ := NewCoder(CodecG722)
	dec, _ := NewCoder(CodecG722)
	in := sine(16000, 1000, 16000, 8000) // 1 s, 1 kHz (HD band)
	var out []int16
	for i := 0; i < len(in); i += 320 {
		p := enc.Encode(in[i : i+320])
		if len(p) != 160 {
			t.Fatalf("G.722 20 ms frame is %d bytes, want 160", len(p))
		}
		out = append(out, dec.Decode(p)...)
	}
	if len(out) != len(in) {
		t.Fatalf("decoded %d samples, want %d", len(out), len(in))
	}
	if g := rms(out[4000:]) / rms(in[4000:]); g < 0.8 || g > 1.2 {
		t.Fatalf("G.722 round trip gain %.2f", g)
	}
	u, _ := NewCoder(media.CodecAudioUlaw)
	if u.AudioRate != 8000 || len(u.Encode(make([]int16, 160))) != 160 {
		t.Fatalf("PCMU coder")
	}
}
