package main

import (
	"strings"

	"github.com/emiago/sipgo/sip"
)

// Offer is what we read from the caller's SDP before answering (policy decisions only; diago negotiates).
type Offer struct {
	Proto  string   // RTP/AVP, RTP/SAVP, ...
	SRTP   bool     // RTP/SAVP with at least one a=crypto (SDES)
	Codecs []string // rtpmap names, offer order
	Crypto []string // SDES suites offered (a=crypto), keys never kept
}

func ParseOffer(body []byte) Offer {
	var o Offer
	inAudio := false
	crypto := false
	for _, line := range strings.Split(strings.ReplaceAll(string(body), "\r\n", "\n"), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(line, "m="):
			f := strings.Fields(line[2:])
			inAudio = len(f) >= 3 && f[0] == "audio"
			if inAudio && o.Proto == "" {
				o.Proto = f[2]
			}
		case inAudio && strings.HasPrefix(line, "a=crypto:"):
			crypto = true
			if f := strings.Fields(line); len(f) >= 2 {
				o.Crypto = append(o.Crypto, f[1])
			}
		case inAudio && strings.HasPrefix(line, "a=rtpmap:"):
			f := strings.Fields(line)
			if len(f) >= 2 {
				name := strings.SplitN(f[1], "/", 2)[0]
				o.Codecs = append(o.Codecs, name)
			}
		}
	}
	o.SRTP = crypto && (o.Proto == "RTP/SAVP" || o.Proto == "RTP/SAVPF")
	return o
}

// AnswerCryptoSuite: the SDES suite in our answer ("" = none). Keys are never returned.
func AnswerCryptoSuite(body []byte) string {
	for _, line := range strings.Split(string(body), string(rune(10))) {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "a=crypto:") {
			if f := strings.Fields(line); len(f) >= 2 {
				return f[1]
			}
		}
	}
	return ""
}

// AnswerHasCrypto: did our 200 OK carry SDES keys (media actually encrypted)?
func AnswerHasCrypto(body []byte) bool {
	return strings.Contains(string(body), "a=crypto:") && strings.Contains(string(body), "RTP/SAVP")
}

// CallerID: the number the PBX presents (P-Asserted-Identity, else From). Unverified; used as the
// "caller phone" exactly like Retell's from_number.
func CallerID(req *sip.Request) (number, name string) {
	if h := req.GetHeader("P-Asserted-Identity"); h != nil {
		var a sip.Uri
		v := h.Value()
		if i := strings.Index(v, "<"); i >= 0 {
			if j := strings.Index(v[i:], ">"); j > 0 {
				if err := sip.ParseUri(v[i+1:i+j], &a); err == nil && a.User != "" {
					number = a.User
				}
				name = strings.Trim(strings.TrimSpace(v[:i]), `"`)
			}
		}
	}
	if from := req.From(); from != nil {
		if number == "" {
			number = from.Address.User
		}
		if name == "" {
			name = from.DisplayName
		}
	}
	return cleanNumber(number), cleanName(name)
}

func cleanNumber(s string) string {
	var b strings.Builder
	for _, r := range s {
		if (r >= '0' && r <= '9') || (r == '+' && b.Len() == 0) {
			b.WriteRune(r)
		}
		if b.Len() >= 20 {
			break
		}
	}
	return b.String()
}

func cleanName(s string) string {
	var b strings.Builder
	for _, r := range s {
		if r >= 32 && r != '<' && r != '>' && r != '"' && r < 0x7f {
			b.WriteRune(r)
		}
		if b.Len() >= 40 {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

func last4(s string) string {
	if len(s) <= 4 {
		return s
	}
	return s[len(s)-4:]
}
