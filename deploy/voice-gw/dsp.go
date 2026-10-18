package main

import (
	"encoding/binary"
	"math"
	"time"
)

// ── Rational polyphase resampler (Kaiser-windowed sinc) ──────────────────────────────────────────────────

func gcd(a, b int) int {
	for b != 0 {
		a, b = b, a%b
	}
	return a
}

// Resampler converts mono int16 PCM from one rate to another, streaming (state kept between calls).
type Resampler struct {
	L, M int
	k    int         // taps per phase
	h    [][]float32 // h[phase][tap]
	buf  []float32   // input history (k-1 samples of look-back + unread)
	t    int         // next output position in the upsampled domain, relative to buf[0]
	pass bool
}

func besselI0(x float64) float64 {
	sum, term := 1.0, 1.0
	for i := 1; i < 50; i++ {
		term *= (x / (2 * float64(i))) * (x / (2 * float64(i)))
		sum += term
		if term < 1e-12*sum {
			break
		}
	}
	return sum
}

// NewResampler builds a resampler from inRate to outRate (e.g. 8000 -> 24000, 24000 -> 8000).
func NewResampler(inRate, outRate int) *Resampler {
	g := gcd(inRate, outRate)
	L, M := outRate/g, inRate/g
	r := &Resampler{L: L, M: M}
	if L == 1 && M == 1 {
		r.pass = true
		return r
	}
	r.k = 24
	n := r.k * L
	maxLM := L
	if M > maxLM {
		maxLM = M
	}
	fc := 0.5 / float64(maxLM) * 0.92 // cutoff below the lower Nyquist, normalised to the upsampled rate
	beta := 7.0
	i0b := besselI0(beta)
	proto := make([]float64, n)
	mid := float64(n-1) / 2
	for i := 0; i < n; i++ {
		x := float64(i) - mid
		s := 2 * fc
		if x != 0 {
			s = math.Sin(2*math.Pi*fc*x) / (math.Pi * x)
		}
		w := besselI0(beta*math.Sqrt(1-math.Pow(2*float64(i)/float64(n-1)-1, 2))) / i0b
		proto[i] = s * w * float64(L)
	}
	r.h = make([][]float32, L)
	for p := 0; p < L; p++ {
		r.h[p] = make([]float32, r.k)
		for j := 0; j < r.k; j++ {
			r.h[p][j] = float32(proto[j*L+p])
		}
	}
	r.buf = make([]float32, r.k-1)
	r.t = (r.k - 1) * L
	return r
}

// Process converts one block. Output length ~ len(in)*L/M (the filter adds a fixed delay of k/2 input samples).
func (r *Resampler) Process(in []int16) []int16 {
	if r.pass {
		out := make([]int16, len(in))
		copy(out, in)
		return out
	}
	for _, s := range in {
		r.buf = append(r.buf, float32(s))
	}
	out := make([]int16, 0, len(in)*r.L/r.M+2)
	for {
		i := r.t / r.L
		if i >= len(r.buf) {
			break
		}
		p := r.t % r.L
		var acc float32
		hp := r.h[p]
		for j := 0; j < r.k; j++ {
			acc += hp[j] * r.buf[i-j]
		}
		if acc > 32767 {
			acc = 32767
		} else if acc < -32768 {
			acc = -32768
		}
		out = append(out, int16(acc))
		r.t += r.M
	}
	drop := r.t/r.L - (r.k - 1)
	if drop > 0 {
		r.buf = append(r.buf[:0], r.buf[drop:]...)
		r.t -= drop * r.L
	}
	return out
}

// ── PCM helpers ──────────────────────────────────────────────────────────────────────────────────────────

func bytesToPCM(b []byte) []int16 {
	out := make([]int16, len(b)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[2*i:]))
	}
	return out
}

func pcmToBytes(s []int16) []byte {
	out := make([]byte, len(s)*2)
	for i, v := range s {
		binary.LittleEndian.PutUint16(out[2*i:], uint16(v))
	}
	return out
}

func frameDBFS(s []int16) float64 {
	if len(s) == 0 {
		return -120
	}
	var sum float64
	for _, v := range s {
		f := float64(v)
		sum += f * f
	}
	ms := sum / float64(len(s)) / (32768.0 * 32768.0)
	if ms <= 1e-12 {
		return -120
	}
	return 10 * math.Log10(ms)
}

// ── Energy VAD (for the latency metric only, never for turn-taking) ──────────────────────────────────────

// VAD tracks when the caller last spoke: adaptive noise floor, 60 ms to start, 300 ms hangover to end.
type VAD struct {
	noise      float64
	speaking   bool
	voicedRun  int
	lastVoiced time.Time
	// SpeechEndedAt is the last voiced frame of the most recent finished utterance (zero if none yet).
	SpeechEndedAt time.Time
}

func NewVAD() *VAD { return &VAD{noise: -60} }

// Push one 20 ms frame. Returns true when an utterance just ended.
func (v *VAD) Push(frame []int16, now time.Time) bool {
	db := frameDBFS(frame)
	thr := v.noise + 12
	if thr < -48 {
		thr = -48
	}
	voiced := db > thr
	if !v.speaking && db < v.noise+6 {
		v.noise = 0.95*v.noise + 0.05*db
		if v.noise < -75 {
			v.noise = -75
		}
	}
	if voiced {
		v.voicedRun++
		v.lastVoiced = now
		if v.voicedRun >= 3 {
			v.speaking = true
		}
		return false
	}
	v.voicedRun = 0
	if v.speaking && now.Sub(v.lastVoiced) > 300*time.Millisecond {
		v.speaking = false
		v.SpeechEndedAt = v.lastVoiced
		return true
	}
	return false
}

func (v *VAD) Speaking() bool { return v.speaking }
