package main

import (
	"fmt"
	"regexp"
	"strings"
)

// Second gate for every target the harness asks us to dial or transfer to (the harness checks the agent's
// allow-list and rate limits first; src/platform/modules/voice/dialplan.ts has the same rules). Allowed:
// internal extensions/queues/groups (2-8 digits), **ext voicemail, *3 park, *4 valet park, and 10-digit US/NANP
// numbers. Always refused: international (011, + not 1, NANP area codes of other countries), premium (900, 976,
// 5XX personal numbers, 700), N11 codes and emergency numbers (the agent never dials 911), other star codes.

type TargetKind string

const (
	TargetInternal  TargetKind = "internal"
	TargetExternal  TargetKind = "external"
	TargetVoicemail TargetKind = "voicemail"
	TargetPark      TargetKind = "park"
)

var (
	foreignNANP = map[string]bool{"242": true, "246": true, "264": true, "268": true, "284": true, "345": true, "441": true, "473": true, "649": true, "658": true,
		"664": true, "721": true, "758": true, "767": true, "784": true, "809": true, "829": true, "849": true, "868": true, "869": true, "876": true}
	premiumNPA = map[string]bool{"900": true, "700": true, "500": true, "521": true, "522": true, "523": true, "524": true, "525": true, "526": true, "527": true,
		"528": true, "529": true, "533": true, "544": true, "566": true, "577": true, "588": true, "976": true}
	nanpRe      = regexp.MustCompile(`^[2-9]\d{2}[2-9]\d{6}$`)
	nanpPrefix  = regexp.MustCompile(`^1?[2-9]\d{2}[2-9]\d{2}`)
	internalRe  = regexp.MustCompile(`^\d{2,8}$`)
	voicemailRe = regexp.MustCompile(`^\*\*\d{2,8}$`)
	n11Re       = regexp.MustCompile(`^[2-9]11$`)
)

// ClassifyTarget returns the kind and the digits to put in the SIP URI user part.
func ClassifyTarget(user string) (TargetKind, string, error) {
	u := strings.TrimSpace(user)
	switch {
	case voicemailRe.MatchString(u):
		return TargetVoicemail, u, nil
	case u == "*3" || u == "*4":
		return TargetPark, u, nil
	case strings.HasPrefix(u, "*") || strings.Contains(u, "#"):
		return "", "", fmt.Errorf("star code not allowed")
	case strings.HasPrefix(u, "011") || (strings.HasPrefix(u, "+") && !strings.HasPrefix(u, "+1")):
		return "", "", fmt.Errorf("international not allowed")
	}
	d := strings.TrimPrefix(u, "+")
	if d == "" || strings.Trim(d, "0123456789") != "" {
		return "", "", fmt.Errorf("digits only")
	}
	if d == "911" || d == "933" || d == "112" || d == "999" || n11Re.MatchString(d) {
		return "", "", fmt.Errorf("emergency and N11 numbers are never dialled")
	}
	if internalRe.MatchString(d) && !nanpPrefix.MatchString(d) {
		if len(d) == 7 {
			return "", "", fmt.Errorf("7-digit local numbers not allowed")
		}
		return TargetInternal, d, nil
	}
	ten := d
	if len(d) == 11 && d[0] == '1' {
		ten = d[1:]
	}
	if !nanpRe.MatchString(ten) {
		return "", "", fmt.Errorf("outside numbers must be 10-digit NANP")
	}
	npa, nxx := ten[:3], ten[3:6]
	if foreignNANP[npa] {
		return "", "", fmt.Errorf("NANP area code of another country")
	}
	if premiumNPA[npa] || nxx == "976" {
		return "", "", fmt.Errorf("premium-rate number")
	}
	if n11Re.MatchString(nxx) {
		return "", "", fmt.Errorf("N11 exchange")
	}
	return TargetExternal, ten, nil
}
