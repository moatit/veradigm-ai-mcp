package main

import (
	"math"
	"sync"
	"time"
)

// EchoGate keeps the agent's own voice from coming back into the model. A desk phone's echo canceller removes
// most acoustic echo, but some line/acoustic residue of what we play returns on the inbound stream; a realtime
// model with server-side voice detection would hear it as the caller talking (false barge-in, the model
// answering itself). The gate compares each inbound frame with the loudest frame we played in the echo window
// (the round trip is well under 800 ms): a frame more than marginDB quieter than that is treated as echo and
// replaced by silence before it goes to the harness. Real barge-in (the caller talking over the agent) is
// louder than the residue and passes. Half-duplex leaning, by design; marginDB 0 turns it off.
//
// It never touches what the PBX legs hear from each other in a conference, only the copy sent to the model.
type EchoGate struct {
	mu       sync.Mutex
	marginDB float64
	ring     []float64 // dBFS of recently played frames (20 ms each)
	pos      int
	// Suppressed counts frames replaced by silence (reported in call stats).
	Suppressed int
	Passed     int
}

func NewEchoGate(marginDB float64, window time.Duration) *EchoGate {
	n := int(window / (20 * time.Millisecond))
	if n < 5 {
		n = 5
	}
	r := make([]float64, n)
	for i := range r {
		r[i] = -120
	}
	return &EchoGate{marginDB: marginDB, ring: r}
}

// Played records the level of one outbound 20 ms frame (agent audio only; silence = -120).
func (e *EchoGate) Played(db float64) {
	if e == nil {
		return
	}
	e.mu.Lock()
	e.ring[e.pos] = db
	e.pos = (e.pos + 1) % len(e.ring)
	e.mu.Unlock()
}

// Counts returns frames gated and passed (nil-safe).
func (e *EchoGate) Counts() (gated, passed int) {
	if e == nil {
		return 0, 0
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.Suppressed, e.Passed
}

// Filter returns the frame to send to the model: the input, or silence when it looks like our own echo.
func (e *EchoGate) Filter(frame []int16) []int16 {
	if e == nil || e.marginDB <= 0 {
		return frame
	}
	e.mu.Lock()
	ref := -120.0
	for _, v := range e.ring {
		ref = math.Max(ref, v)
	}
	e.mu.Unlock()
	if ref < -50 { // nothing meaningful played recently
		e.Passed++
		return frame
	}
	if frameDBFS(frame) < ref-e.marginDB {
		e.Suppressed++
		return make([]int16, len(frame))
	}
	e.Passed++
	return frame
}

// ArrivalJitter: RFC 3550-style interarrival jitter estimate from packet arrival times alone (expected spacing
// 20 ms). Good enough to spot a bad network path; diago keeps the timestamp-based value internally.
type ArrivalJitter struct {
	last time.Time
	J    float64 // ms
	Max  float64 // ms, largest single deviation
}

func (a *ArrivalJitter) Note(now time.Time) {
	if !a.last.IsZero() {
		d := math.Abs(float64(now.Sub(a.last).Microseconds())/1000 - 20)
		if d > a.Max {
			a.Max = d
		}
		a.J += (d - a.J) / 16
	}
	a.last = now
}
