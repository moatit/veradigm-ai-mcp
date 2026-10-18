package main

import (
	"strings"
	"time"

	"github.com/emiago/diago/audio"
	"github.com/emiago/diago/media"
	"github.com/gotranspile/g722"
)

// InternalRate: every leg's audio is handled at 16 kHz inside the gateway (playout, local conference mixing,
// echo gate, VAD), whatever its codec, so a G.722 caller and a G.711 staff phone can share one conference.
const InternalRate = 16000

// CodecG722 is G.722 (HD voice, 16 kHz audio) as RFC 3551 defines it in SDP: payload 9, RTP clock 8000.
var CodecG722 = media.Codec{Name: "G722", PayloadType: 9, SampleRate: 8000, SampleDur: 20 * time.Millisecond, NumChannels: 1}

// Preference when we answer (and offer): G.722, then G.711 u-law, a-law; RFC 4733 DTMF.
var answerCodecs = []media.Codec{CodecG722, media.CodecAudioUlaw, media.CodecAudioAlaw, media.CodecTelephoneEvent8000}

// Coder converts one leg's RTP payload to/from 16-bit PCM at its native audio rate. Stateful (G.722 is ADPCM):
// one per leg and direction.
type Coder struct {
	Name      string
	AudioRate int // 16000 for G.722, 8000 for G.711
	decode    func(payload []byte) []int16
	encode    func(pcm []int16) []byte
}

func NewCoder(c media.Codec) (*Coder, bool) {
	switch {
	case strings.EqualFold(c.Name, "G722") || c.PayloadType == 9:
		dec := g722.NewDecoder(g722.Rate64000, 0)
		enc := g722.NewEncoder(g722.Rate64000, 0)
		return &Coder{
			Name:      "G722",
			AudioRate: 16000,
			decode: func(p []byte) []int16 {
				out := make([]int16, len(p)*2)
				n := dec.Decode(out, p)
				return out[:n]
			},
			encode: func(pcm []int16) []byte {
				out := make([]byte, (len(pcm)+1)/2)
				n := enc.Encode(out, pcm)
				return out[:n]
			},
		}, true
	case c.PayloadType == media.CodecAudioUlaw.PayloadType:
		return g711Coder("PCMU", audio.DecodeUlawTo, audio.EncodeUlawTo), true
	case c.PayloadType == media.CodecAudioAlaw.PayloadType:
		return g711Coder("PCMA", audio.DecodeAlawTo, audio.EncodeAlawTo), true
	}
	return nil, false
}

func g711Coder(name string, dec func(lpcm, p []byte) (int, error), enc func(p, lpcm []byte) (int, error)) *Coder {
	return &Coder{
		Name:      name,
		AudioRate: 8000,
		decode: func(p []byte) []int16 {
			lpcm := make([]byte, len(p)*2)
			n, err := dec(lpcm, p)
			if err != nil {
				return nil
			}
			return bytesToPCM(lpcm[:n])
		},
		encode: func(pcm []int16) []byte {
			out := make([]byte, len(pcm))
			n, err := enc(out, pcmToBytes(pcm))
			if err != nil {
				return nil
			}
			return out[:n]
		},
	}
}

func (c *Coder) Decode(p []byte) []int16   { return c.decode(p) }
func (c *Coder) Encode(pcm []int16) []byte { return c.encode(pcm) }
