package main

import "sync"

// Playout is the outbound (agent -> caller) audio queue at the internal rate, paced out by the RTP writer every 20 ms.
// Audio arrives from the harness faster than real time in "segments" (one per agent response or scripted
// clip). The harness learns what was actually played: segment_done when a segment's end marker is reached,
// cleared (with the played milliseconds) when it flushes the queue for a barge-in.
type chunk struct {
	seg string
	s   []int16
	end bool
}

type SegmentEvent struct {
	Type     string `json:"type"` // segment_done | cleared
	Segment  string `json:"segment"`
	PlayedMs int    `json:"played_ms"`
}

type Playout struct {
	mu     sync.Mutex
	q      []chunk
	queued int
	played map[string]int
	maxQ   int
	perMs  int // samples per millisecond
}

func NewPlayout(maxSamples, samplesPerMs int) *Playout {
	if samplesPerMs < 1 {
		samplesPerMs = 8
	}
	return &Playout{played: map[string]int{}, maxQ: maxSamples, perMs: samplesPerMs}
}

// Push queues audio for a segment. Returns false if the queue is full (the audio is dropped).
func (p *Playout) Push(seg string, s []int16) bool {
	if len(s) == 0 {
		return true
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.queued+len(s) > p.maxQ {
		return false
	}
	p.q = append(p.q, chunk{seg: seg, s: s})
	p.queued += len(s)
	return true
}

// End marks the end of a segment: segment_done is reported when playout reaches this point.
func (p *Playout) End(seg string) {
	p.mu.Lock()
	p.q = append(p.q, chunk{seg: seg, end: true})
	p.mu.Unlock()
}

// Clear drops everything queued. Reports the segment that was playing (if any) with what was played of it.
func (p *Playout) Clear() *SegmentEvent {
	p.mu.Lock()
	defer p.mu.Unlock()
	var ev *SegmentEvent
	for _, c := range p.q {
		if c.seg != "" {
			ev = &SegmentEvent{Type: "cleared", Segment: c.seg, PlayedMs: p.played[c.seg] / p.perMs}
			break
		}
	}
	for _, c := range p.q {
		delete(p.played, c.seg)
	}
	p.q = nil
	p.queued = 0
	return ev
}

// Next pops up to n samples (padded with silence). active=false when nothing was queued (pure silence).
func (p *Playout) Next(n int) (frame []int16, events []SegmentEvent, active bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	frame = make([]int16, n)
	filled := 0
	for len(p.q) > 0 && filled < n {
		c := &p.q[0]
		if c.end {
			events = append(events, SegmentEvent{Type: "segment_done", Segment: c.seg, PlayedMs: p.played[c.seg] / p.perMs})
			delete(p.played, c.seg)
			p.q = p.q[1:]
			continue
		}
		k := copy(frame[filled:], c.s)
		filled += k
		p.played[c.seg] += k
		p.queued -= k
		active = true
		if k == len(c.s) {
			p.q = p.q[1:]
		} else {
			c.s = c.s[k:]
		}
	}
	// An end marker right behind the last audio is reported in the same tick.
	for len(p.q) > 0 && p.q[0].end {
		events = append(events, SegmentEvent{Type: "segment_done", Segment: p.q[0].seg, PlayedMs: p.played[p.q[0].seg] / p.perMs})
		delete(p.played, p.q[0].seg)
		p.q = p.q[1:]
	}
	return frame, events, active
}

func (p *Playout) QueuedMs() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.queued / p.perMs
}
