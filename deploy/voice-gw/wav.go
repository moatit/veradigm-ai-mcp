package main

import (
	"encoding/binary"
	"errors"
	"os"
)

// LoadWAV8k reads a PCM s16le mono WAV of any rate and returns it at 8 kHz.
func LoadWAV8k(path string) ([]int16, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	pcm, rate, err := ParseWAV(b)
	if err != nil {
		return nil, err
	}
	return NewResampler(rate, 8000).Process(append(pcm, make([]int16, 48)...)), nil
}

// ParseWAV returns the samples and sample rate of a 16-bit mono PCM WAV.
func ParseWAV(b []byte) ([]int16, int, error) {
	if len(b) < 12 || string(b[0:4]) != "RIFF" || string(b[8:12]) != "WAVE" {
		return nil, 0, errors.New("not a WAV file")
	}
	var rate, channels, bits int
	var format uint16
	var data []byte
	for p := 12; p+8 <= len(b); {
		id := string(b[p : p+4])
		size := int(binary.LittleEndian.Uint32(b[p+4 : p+8]))
		body := p + 8
		if body+size > len(b) {
			size = len(b) - body
		}
		switch id {
		case "fmt ":
			if size < 16 {
				return nil, 0, errors.New("bad fmt chunk")
			}
			format = binary.LittleEndian.Uint16(b[body:])
			channels = int(binary.LittleEndian.Uint16(b[body+2:]))
			rate = int(binary.LittleEndian.Uint32(b[body+4:]))
			bits = int(binary.LittleEndian.Uint16(b[body+14:]))
		case "data":
			data = b[body : body+size]
		}
		p = body + size + size%2
	}
	if format != 1 || channels != 1 || bits != 16 || rate < 8000 || rate > 48000 || data == nil {
		return nil, 0, errors.New("WAV must be PCM 16-bit mono, 8-48 kHz")
	}
	return bytesToPCM(data), rate, nil
}
