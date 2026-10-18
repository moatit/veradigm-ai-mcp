package main

import "sync"

// Mixer is the local conference ("3-way calling" done in our user agent, like a desk phone). Every human leg
// keeps its own RTP stream; inside a conference each leg hears the sum of the OTHER legs' inbound audio, never
// its own. Agent audio is not mixed here: the harness sends it to the legs it wants (one leg, or every leg in
// the conference), and the harness feeds the model only the human legs, so the model never hears itself.
//
// Per (source, destination) FIFOs at 8 kHz, each capped at maxMs (oldest dropped) so a slow leg cannot build
// up delay.
type Mixer struct {
	mu    sync.Mutex
	conf  map[int]bool
	fifo  map[[2]int][]int16
	maxSz int
}

func NewMixer(maxMs int) *Mixer {
	return &Mixer{conf: map[int]bool{}, fifo: map[[2]int][]int16{}, maxSz: maxMs * 8}
}

// Set replaces the conference membership (fewer than two legs = no conference). FIFOs are reset.
func (m *Mixer) Set(legs []int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.conf = map[int]bool{}
	m.fifo = map[[2]int][]int16{}
	if len(legs) < 2 {
		return
	}
	for _, l := range legs {
		m.conf[l] = true
	}
}

// Remove takes one leg out (hang-up). With one leg left the conference ends.
func (m *Mixer) Remove(leg int) {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.conf, leg)
	for k := range m.fifo {
		if k[0] == leg || k[1] == leg {
			delete(m.fifo, k)
		}
	}
	if len(m.conf) < 2 {
		m.conf = map[int]bool{}
		m.fifo = map[[2]int][]int16{}
	}
}

func (m *Mixer) Members() []int {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]int, 0, len(m.conf))
	for l := range m.conf {
		out = append(out, l)
	}
	return out
}

func (m *Mixer) InConference(leg int) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conf[leg]
}

// Feed: inbound audio (8 kHz) received on leg src.
func (m *Mixer) Feed(src int, pcm []int16) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.conf[src] {
		return
	}
	for dst := range m.conf {
		if dst == src {
			continue
		}
		k := [2]int{src, dst}
		q := append(m.fifo[k], pcm...)
		if len(q) > m.maxSz {
			q = q[len(q)-m.maxSz:]
		}
		m.fifo[k] = q
	}
}

// Pull: n samples of what leg dst should hear from the other legs (nil when dst is not in a conference).
func (m *Mixer) Pull(dst int, n int) []int16 {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.conf[dst] {
		return nil
	}
	out := make([]int32, n)
	any := false
	for src := range m.conf {
		if src == dst {
			continue
		}
		k := [2]int{src, dst}
		q := m.fifo[k]
		c := n
		if len(q) < c {
			c = len(q)
		}
		for i := 0; i < c; i++ {
			out[i] += int32(q[i])
		}
		if c > 0 {
			any = true
		}
		m.fifo[k] = q[c:]
	}
	if !any {
		return nil
	}
	res := make([]int16, n)
	for i, v := range out {
		res[i] = clip16(v)
	}
	return res
}

func clip16(v int32) int16 {
	if v > 32767 {
		return 32767
	}
	if v < -32768 {
		return -32768
	}
	return int16(v)
}

// AddInto mixes b into a (in place, clipped).
func AddInto(a, b []int16) {
	for i := 0; i < len(a) && i < len(b); i++ {
		a[i] = clip16(int32(a[i]) + int32(b[i]))
	}
}
