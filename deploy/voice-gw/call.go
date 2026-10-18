package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/emiago/diago"
	"github.com/emiago/diago/audio"
	"github.com/emiago/diago/media"
)

// CallMedia moves audio between the RTP leg (G.711, 8 kHz, 20 ms) and the harness (PCM s16le at `rate`).
// Inbound: decode -> energy VAD (metric only) -> resample -> onCaller. Outbound: harness PCM -> resample to
// 8 kHz -> Playout queue -> one encoded frame every 20 ms (silence when idle, so RTP always flows: that keeps
// NAT bindings open and lets the PBX's media relay latch on our address, symmetric RTP).
type CallMedia struct {
	ref    string
	med    *diago.DialogMedia
	codec  media.Codec
	rate   int
	up     *Resampler // 8k -> rate
	downMu sync.Mutex
	down   *Resampler // rate -> 8k
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
}

func NewCallMedia(ref string, med *diago.DialogMedia, rate int, log *slog.Logger) *CallMedia {
	m := &CallMedia{
		ref:        ref,
		med:        med,
		codec:      media.CodecAudioFromSession(med.MediaSession()),
		rate:       rate,
		up:         NewResampler(8000, rate),
		down:       NewResampler(rate, 8000),
		play:       NewPlayout(8000 * 120), // at most 2 minutes queued
		vad:        NewVAD(),
		log:        log,
		answeredAt: time.Now(),
		onCaller:   func([]int16) {},
		onEvent:    func(Event) {},
		onDTMF:     func(rune) {},
	}
	m.firstInMs.Store(-1)
	return m
}

func (m *CallMedia) CodecName() string { return m.codec.Name }

// PushAgent queues agent audio (PCM at m.rate) under a segment ID.
func (m *CallMedia) PushAgent(seg string, pcm []int16) {
	m.downMu.Lock()
	s := m.down.Process(pcm)
	m.downMu.Unlock()
	if !m.play.Push(seg, s) {
		m.log.Warn("playout queue full; agent audio dropped", "call", m.ref)
	}
}

func (m *CallMedia) decode(lpcm, payload []byte) (int, error) {
	if m.codec.PayloadType == media.CodecAudioAlaw.PayloadType {
		return audio.DecodeAlawTo(lpcm, payload)
	}
	return audio.DecodeUlawTo(lpcm, payload)
}

func (m *CallMedia) encode(payload, lpcm []byte) (int, error) {
	if m.codec.PayloadType == media.CodecAudioAlaw.PayloadType {
		return audio.EncodeAlawTo(payload, lpcm)
	}
	return audio.EncodeUlawTo(payload, lpcm)
}

// Run blocks until the media ends (hang-up) or ctx is cancelled.
func (m *CallMedia) Run(ctx context.Context) error {
	if m.codec.PayloadType != media.CodecAudioUlaw.PayloadType && m.codec.PayloadType != media.CodecAudioAlaw.PayloadType {
		return errors.New("negotiated codec is not G.711")
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
	lpcm := make([]byte, 3000)
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
		k, err := m.decode(lpcm, buf[:n])
		if err != nil || k == 0 {
			continue
		}
		pcm := bytesToPCM(lpcm[:k])
		if m.vad.Push(pcm, time.Now()) {
			m.mu.Lock()
			m.turnArmed = true
			m.mu.Unlock()
		}
		m.onCaller(m.up.Process(pcm))
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
	const n = 160 // 20 ms at 8 kHz
	enc := make([]byte, n)
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
		k, err := m.encode(enc, pcmToBytes(frame))
		if err != nil || k != n {
			continue
		}
		if _, err := w.Write(enc[:k]); err != nil { // paced: blocks until the next 20 ms tick
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
