package main

import (
	"testing"
	"time"
)

func constFrame(v int16, n int) []int16 {
	f := make([]int16, n)
	for i := range f {
		f[i] = v
	}
	return f
}

// Each party hears the other two, never itself.
func TestMixerThreeWayNoSelf(t *testing.T) {
	m := NewMixer(200)
	m.Set([]int{0, 1, 2})
	m.Feed(0, constFrame(100, 160))
	m.Feed(1, constFrame(1000, 160))
	m.Feed(2, constFrame(10000, 160))
	want := map[int]int16{0: 11000, 1: 10100, 2: 1100}
	for leg, w := range want {
		got := m.Pull(leg, 160)
		if got == nil || got[0] != w || got[159] != w {
			t.Fatalf("leg %d hears %v, want %d (sum of the others only)", leg, got[:1], w)
		}
	}
	// Drained: nothing more to hear.
	if got := m.Pull(0, 160); got != nil {
		t.Fatalf("FIFO not drained")
	}
}

func TestMixerOutsideConferenceAndRemoval(t *testing.T) {
	m := NewMixer(200)
	m.Set([]int{0, 1})
	m.Feed(2, constFrame(500, 160)) // leg 2 is not in the conference: never mixed
	if got := m.Pull(0, 160); got != nil {
		t.Fatalf("non-member audio leaked")
	}
	if got := m.Pull(2, 160); got != nil {
		t.Fatalf("non-member hears the conference")
	}
	m.Feed(1, constFrame(700, 160))
	m.Remove(1) // one leg left: conference over
	if m.InConference(0) || m.Pull(0, 160) != nil {
		t.Fatalf("conference should end with one leg")
	}
	m.Set([]int{0}) // fewer than two legs = no conference
	if m.InConference(0) {
		t.Fatalf("single-leg conference")
	}
}

func TestMixerBoundedDelay(t *testing.T) {
	m := NewMixer(200) // 3200 samples at 16 kHz
	m.Set([]int{0, 1})
	for i := 0; i < 50; i++ { // 1 s of audio, nobody pulling
		m.Feed(1, constFrame(int16(i), 320))
	}
	got := m.Pull(0, 3200)
	if got[0] != 40 { // only the newest 200 ms are kept
		t.Fatalf("oldest audio not dropped: first sample %d", got[0])
	}
}

func TestMixerClipping(t *testing.T) {
	m := NewMixer(200)
	m.Set([]int{0, 1, 2})
	m.Feed(1, constFrame(30000, 160))
	m.Feed(2, constFrame(30000, 160))
	if got := m.Pull(0, 160); got[0] != 32767 {
		t.Fatalf("sum not clipped: %d", got[0])
	}
}

func TestEchoGate(t *testing.T) {
	g := NewEchoGate(10, 800*time.Millisecond)
	loud := sine(8000, 300, 160, 10000) // ~ -13 dBFS
	echo := sine(8000, 300, 160, 600)   // ~ -37 dBFS: our voice coming back
	barge := sine(8000, 300, 160, 8000) // caller talking over the agent
	// Nothing played: everything passes.
	if out := g.Filter(echo); rms(out) == 0 {
		t.Fatalf("gate closed with no agent audio")
	}
	g.Played(frameDBFS(loud))
	if out := g.Filter(echo); rms(out) != 0 {
		t.Fatalf("echo of the agent reached the model")
	}
	if out := g.Filter(barge); rms(out) == 0 {
		t.Fatalf("barge-in blocked")
	}
	// After the echo window with silence, the gate opens again.
	for i := 0; i < 40; i++ {
		g.Played(-120)
	}
	if out := g.Filter(echo); rms(out) == 0 {
		t.Fatalf("gate stuck closed")
	}
	off := NewEchoGate(0, 800*time.Millisecond)
	off.Played(frameDBFS(loud))
	if out := off.Filter(echo); rms(out) == 0 {
		t.Fatalf("margin 0 must disable the gate")
	}
}

func TestDialAllowList(t *testing.T) {
	realm := "mit.voip.moatit.net"
	for _, ok := range []string{"sip:4500@mit.voip.moatit.net", "sip:600@mit.voip.moatit.net"} {
		if _, err := ValidateDialTarget(ok, realm); err != nil {
			t.Fatalf("%s refused", ok)
		}
	}
	for _, bad := range []string{"sip:**4500@mit.voip.moatit.net", "sip:*3@mit.voip.moatit.net", "sip:*0101@mit.voip.moatit.net",
		"sip:12085551234@mit.voip.moatit.net", "sip:011441234@mit.voip.moatit.net", "sip:+12085551234@mit.voip.moatit.net",
		"sip:4500@evil.example", "sip:9@mit.voip.moatit.net"} {
		if _, err := ValidateDialTarget(bad, realm); err == nil {
			t.Fatalf("%s accepted for dial-out", bad)
		}
	}
}
