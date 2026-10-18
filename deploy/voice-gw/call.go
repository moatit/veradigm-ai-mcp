package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/emiago/diago"
	"github.com/emiago/diago/media"
)

// CallMedia moves audio between one RTP leg (G.722 or G.711, 20 ms) and the harness (PCM s16le at `rate`).
// Everything inside runs at InternalRate (16 kHz). Inbound: decode -> 16 kHz -> energy VAD (metric only), local
// conference feed, echo gate -> resample -> onCaller. Outbound: harness PCM -> 16 kHz -> Playout queue (+ the
// other conference legs) -> codec rate -> one encoded frame every 20 ms (silence when idle, so RTP always flows:
// that keeps NAT bindings open and lets the PBX's media relay latch on our address, symmetric RTP).
type CallMedia struct {
	ref    string
	leg    int
	mix    *Mixer // local conference (nil = none)
	med    *diago.DialogMedia
	codec  media.Codec
	inC    *Coder     // inbound decoder (own state)
	outC   *Coder     // outbound encoder (own state)
	toIR   *Resampler // codec audio rate -> 16k
	fromIR *Resampler // 16k -> codec audio rate
	rate   int
	up     *Resampler // 16k -> rate
	downMu sync.Mutex
	down   *Resampler // rate -> 16k
	play   *Playout
	vad    *VAD
	log    *slog.Logger

	answeredAt time.Time
	pktsIn     atomic.Int64
	pktsOut    atomic.Int64
	firstInMs  atomic.Int64 // -1 until the first inbound packet

	mu         sync.Mutex
	turnArmed  bool
	onCaller   func(pcm []int16)
	onEvent    func(Event)
	onDTMF     func(digit rune)
	agentAudio atomic.Bool // agent audio currently going out

	gate   *EchoGate
	statMu sync.Mutex
	jit    ArrivalJitter
	qSum   int // echo test: playout queue depth when a frame was queued (internal loopback latency)
	qN     int
	qMax   int
}

// EchoMarginDB is VOICE_ECHO_GATE_DB (0 = off).
var EchoMarginDB = 10.0

func NewCallMedia(ref string, med *diago.DialogMedia, rate int, log *slog.Logger) *CallMedia {
	codec := media.CodecAudioFromSession(med.MediaSession())
	m := &CallMedia{
		ref:        ref,
		med:        med,
		codec:      codec,
		rate:       rate,
		up:         NewResampler(InternalRate, rate),
		down:       NewResampler(rate, InternalRate),
		play:       NewPlayout(InternalRate*120, InternalRate/1000), // at most 2 minutes queued
		vad:        NewVAD(),
		log:        log,
		answeredAt: time.Now(),
		gate:       NewEchoGate(EchoMarginDB, 800*time.Millisecond),
		onCaller:   func([]int16) {},
		onEvent:    func(Event) {},
		onDTMF:     func(rune) {},
	}
	m.firstInMs.Store(-1)
	if in, ok := NewCoder(codec); ok {
		out, _ := NewCoder(codec)
		m.inC, m.outC = in, out
		m.toIR = NewResampler(in.AudioRate, InternalRate)
		m.fromIR = NewResampler(InternalRate, in.AudioRate)
	}
	return m
}

func (m *CallMedia) CodecName() string {
	if m.inC != nil {
		return m.inC.Name
	}
	return m.codec.Name
}

// PushAgent queues agent audio (PCM at m.rate) under a segment ID.
func (m *CallMedia) PushAgent(seg string, pcm []int16) {
	m.downMu.Lock()
	s := m.down.Process(pcm)
	m.downMu.Unlock()
	if !m.play.Push(seg, s) {
		m.log.Warn("playout queue full; agent audio dropped", "call", m.ref)
	}
}

// Run blocks until the media ends (hang-up) or ctx is cancelled.
func (m *CallMedia) Run(ctx context.Context) error {
	if m.inC == nil {
		return errors.New("negotiated codec is not G.722 or G.711")
	}
	dtmfR, err := m.med.AudioReaderDTMF()
	if err != nil {
		return err
	}
	dtmfR.OnDTMF(func(d rune) error {
		m.onDTMF(d)
		return nil
	})
	w, err := m.med.AudioWriter()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	go m.writeLoop(ctx, w)
	go m.watchInbound(ctx)
	return m.readLoop(ctx, dtmfR)
}

func (m *CallMedia) readLoop(ctx context.Context, r io.Reader) error {
	buf := make([]byte, 1500)
	for ctx.Err() == nil {
		n, err := r.Read(buf)
		if err != nil {
			if errors.Is(err, io.EOF) || ctx.Err() != nil {
				return nil
			}
			return err
		}
		if n == 0 {
			continue
		}
		if m.pktsIn.Add(1) == 1 {
			ms := time.Since(m.answeredAt).Milliseconds()
			m.firstInMs.Store(ms)
			m.onEvent(Event{Type: "media_in", At: nowMs(), FirstInMs: intp(int(ms))})
		}
		now := time.Now()
		m.statMu.Lock()
		m.jit.Note(now)
		m.statMu.Unlock()
		native := m.inC.Decode(buf[:n])
		if len(native) == 0 {
			continue
		}
		pcm := m.toIR.Process(native)
		if m.mix != nil {
			m.mix.Feed(m.leg, pcm)
		}
		if m.vad.Push(pcm, time.Now()) {
			m.mu.Lock()
			m.turnArmed = true
			m.mu.Unlock()
		}
		m.onCaller(m.up.Process(m.gate.Filter(pcm)))
	}
	return nil
}

// watchInbound reports one-way audio: nothing received 4 s after answering (NAT / firewall / SDP address).
func (m *CallMedia) watchInbound(ctx context.Context) {
	select {
	case <-ctx.Done():
		return
	case <-time.After(4 * time.Second):
	}
	if m.pktsIn.Load() == 0 {
		m.log.Warn("no inbound RTP 4 s after answer (one-way audio)", "call", m.ref, "pkts_out", m.pktsOut.Load())
		m.onEvent(Event{Type: "media_warning", At: nowMs(), Reason: "no_inbound_rtp"})
	}
}

func (m *CallMedia) writeLoop(ctx context.Context, w io.Writer) {
	const n = InternalRate / 50 // 20 ms
	wasActive := false
	for ctx.Err() == nil {
		frame, evs, active := m.play.Next(n)
		for _, ev := range evs {
			m.onEvent(Event{Type: ev.Type, At: nowMs(), Segment: ev.Segment, PlayedMs: intp(ev.PlayedMs)})
		}
		if active && !wasActive {
			ev := Event{Type: "playout_started", At: nowMs()}
			m.mu.Lock()
			if m.turnArmed && !m.vad.Speaking() && !m.vad.SpeechEndedAt.IsZero() {
				ev.LatencyMs = intp(int(time.Since(m.vad.SpeechEndedAt).Milliseconds()))
			}
			m.turnArmed = false
			m.mu.Unlock()
			m.agentAudio.Store(true)
			m.onEvent(ev)
		} else if !active && wasActive {
			m.agentAudio.Store(false)
			m.onEvent(Event{Type: "playout_idle", At: nowMs()})
		}
		wasActive = active
		if active {
			m.gate.Played(frameDBFS(frame))
		} else {
			m.gate.Played(-120)
		}
		if m.mix != nil {
			if other := m.mix.Pull(m.leg, n); other != nil {
				AddInto(frame, other)
			}
		}
		enc := m.outC.Encode(m.fromIR.Process(frame))
		if len(enc) == 0 {
			continue
		}
		if _, err := w.Write(enc); err != nil { // paced: blocks until the next 20 ms tick
			if ctx.Err() == nil {
				m.log.Debug("rtp write ended", "call", m.ref)
			}
			return
		}
		m.pktsOut.Add(1)
	}
}

func (m *CallMedia) Stats() (in, out int, firstInMs int) {
	return int(m.pktsIn.Load()), int(m.pktsOut.Load()), int(m.firstInMs.Load())
}

// NoteQueue records the playout queue depth (ms) at the moment an echo-test frame is queued.
func (m *CallMedia) NoteQueue(ms int) {
	m.statMu.Lock()
	m.qSum += ms
	m.qN++
	if ms > m.qMax {
		m.qMax = ms
	}
	m.statMu.Unlock()
}

// Quality: RTP loss (from sequence numbers), arrival jitter, RTCP round trip (when the far end sends
// receiver reports), echo-gate counts and the echo-test queue depth.
type Quality struct {
	Expected    int     `json:"expected"`
	Received    int     `json:"received"`
	LossPct     float64 `json:"loss_pct"`
	JitterMs    float64 `json:"jitter_ms"`
	JitterMaxMs float64 `json:"jitter_max_ms"`
	RTTMs       int     `json:"rtt_ms"`
	EchoGated   int     `json:"echo_gated_frames"`
	EchoPassed  int     `json:"echo_passed_frames"`
	QueueAvgMs  int     `json:"loopback_queue_avg_ms"`
	QueueMaxMs  int     `json:"loopback_queue_max_ms"`
}

func (m *CallMedia) Quality() Quality {
	q := Quality{}
	if rs := m.med.RTPSession(); rs != nil {
		st := rs.ReadStats()
		q.Received = int(st.PacketsCount)
		q.Expected = int(uint16(st.LastSequenceNumber-st.FirstPktSequenceNumber)) + 1
		if q.Expected > 0 && q.Expected >= q.Received {
			q.LossPct = math.Round(float64(q.Expected-q.Received)*1000/float64(q.Expected)) / 10
		}
		q.RTTMs = int(st.RTT.Milliseconds())
	}
	m.statMu.Lock()
	q.JitterMs = math.Round(m.jit.J*10) / 10
	q.JitterMaxMs = math.Round(m.jit.Max*10) / 10
	if m.qN > 0 {
		q.QueueAvgMs = m.qSum / m.qN
	}
	q.QueueMaxMs = m.qMax
	m.statMu.Unlock()
	q.EchoGated, q.EchoPassed = m.gate.Suppressed, m.gate.Passed
	return q
}
